use crate::managers::audio::AudioRecordingManager;
use crate::managers::transcription::TranscriptionManager;
use log::{debug, error};
use std::sync::Arc;
use std::time::Instant;
use tauri::AppHandle;
use tauri::Emitter;
use tauri::Manager;

const POLL_INTERVAL_MS: u64 = 500;
const MIN_CHUNK_SAMPLES: usize = 16000; // 1s at 16kHz — don't transcribe less
const MAX_CHUNK_SAMPLES: usize = 16000 * 15; // 15s — force transcribe
const SILENCE_FLUSH_POLLS: u32 = 4; // 4 polls of silence (~2s) → flush pending audio
const WHISPER_RATE: usize = 16000;

pub async fn run_session_transcription_loop(app: AppHandle, session_id: String) {
    use crate::audio_toolkit::pipeline::{ChannelMode, Pipeline};
    use crate::managers::session::{SessionAmplitudeEvent, SessionManager};
    use tokio::time::{interval, Duration};

    let sm = app.state::<Arc<SessionManager>>();
    let rm = app.state::<Arc<AudioRecordingManager>>();
    let tm = app.state::<Arc<TranscriptionManager>>();

    let aec = match crate::aec::AEC::new() {
        Ok(a) => {
            log::info!("AEC initialized successfully");
            Some(a)
        }
        Err(e) => {
            log::warn!("AEC init failed, running without echo cancellation: {}", e);
            None
        }
    };

    // Both mic and speaker streams are already resampled to 16kHz,
    // so Pipeline resamplers act as identity (16k→16k).
    let mut pipeline = Pipeline::new(
        WHISPER_RATE as u32,
        WHISPER_RATE as u32,
        None, // VAD handled separately or inside pipeline if needed
        aec,
        ChannelMode::MicAndSpeaker,
    );

    let session_start = Instant::now();
    let mut tick = interval(Duration::from_millis(POLL_INTERVAL_MS));
    let mut pending_spk_samples: Vec<f32> = Vec::new();
    let mut mic_silent_polls: u32 = 0;
    let mut spk_silent_polls: u32 = 0;
    let mut mic_chunk_start: Instant = session_start;
    let mut spk_chunk_start: Instant = session_start;
    // Track whether we have any mic samples accumulated in the pipeline
    let mut mic_has_samples = false;

    loop {
        tick.tick().await;

        // Exit when session ended OR recording stopped (allows re-start)
        let session_ended = sm.get_active_session_id().as_deref() != Some(&session_id);
        let recording_stopped = !rm.is_recording();
        if session_ended || recording_stopped {
            let now = session_start.elapsed().as_millis() as i64;

            // Session ended — flush remaining mic audio
            if rm.is_recording() {
                let final_chunk = rm.take_session_chunk();
                if !final_chunk.is_empty() {
                    pipeline.push_mic_samples(&final_chunk);
                }
            }

            // Flush remaining speaker audio
            let final_spk = sm.take_speaker_samples();
            if !final_spk.is_empty() {
                pipeline.push_spk_samples(&final_spk);
                pending_spk_samples.extend_from_slice(&final_spk);
            }

            // Process remaining pairs through AEC
            let pairs = pipeline.flush();
            pipeline.process_pairs(pairs);

            // Transcribe remaining mic (AEC-cleaned via pipeline)
            let (remaining_mic, _remaining_spk) = pipeline.take_all_accumulated();
            if !remaining_mic.is_empty() {
                let start_ms = mic_chunk_start.duration_since(session_start).as_millis() as i64;
                if let Ok(text) = tm.transcribe_chunk(remaining_mic) {
                    if !text.is_empty() {
                        let _ = sm.add_segment(&session_id, text, "mic", start_ms, now);
                    }
                }
            }

            // Transcribe remaining speaker
            if !pending_spk_samples.is_empty() {
                let start_ms = spk_chunk_start.duration_since(session_start).as_millis() as i64;
                if let Ok(text) = tm.transcribe_chunk(std::mem::take(&mut pending_spk_samples)) {
                    if !text.is_empty() {
                        let _ = sm.add_segment(&session_id, text, "speaker", start_ms, now);
                    }
                }
            }

            debug!("Session transcription loop ended for {}", session_id);
            break;
        }

        // Poll mic samples and push into pipeline
        let new_mic = rm.take_session_chunk();
        if new_mic.is_empty() {
            mic_silent_polls += 1;
        } else {
            if !mic_has_samples {
                mic_chunk_start = Instant::now();
            }
            mic_silent_polls = 0;
            mic_has_samples = true;
            pipeline.push_mic_samples(&new_mic);
        }

        // Poll speaker samples and push into pipeline
        let new_spk = sm.take_speaker_samples();
        if !new_spk.is_empty() {
            if pending_spk_samples.is_empty() {
                spk_chunk_start = Instant::now();
            }
            pipeline.push_spk_samples(&new_spk);
            pending_spk_samples.extend_from_slice(&new_spk);

            if is_silence(&new_spk) {
                spk_silent_polls += 1;
            } else {
                spk_silent_polls = 0;
            }
        } else {
            spk_silent_polls += 1;
        }

        // Flush joiner and process pairs (AEC applied per-pair inside pipeline)
        let pairs = pipeline.flush();
        pipeline.process_pairs(pairs);

        // Emit amplitude event for UI visualization
        if let Some(amp) = pipeline.get_amplitude() {
            let _ = app.emit(
                "session-amplitude",
                SessionAmplitudeEvent {
                    session_id: session_id.clone(),
                    mic: (amp.mic_level * 1000.0) as u16,
                    speaker: (amp.spk_level * 1000.0) as u16,
                },
            );
        }

        let now = session_start.elapsed().as_millis() as i64;

        // Check if mic audio is ready to transcribe
        let mic_should_transcribe = mic_has_samples
            && (pipeline.accumulated_mic_len() >= MAX_CHUNK_SAMPLES
                || (pipeline.accumulated_mic_len() >= MIN_CHUNK_SAMPLES
                    && mic_silent_polls >= SILENCE_FLUSH_POLLS));

        if mic_should_transcribe {
            let start_ms = mic_chunk_start.duration_since(session_start).as_millis() as i64;

            // Take only mic from pipeline; speaker is tracked separately
            let (mic_audio, _spk_audio) = pipeline.take_all_accumulated();

            match tm.transcribe_chunk(mic_audio) {
                Ok(text) => {
                    if !text.is_empty() {
                        let _ = sm.add_segment(&session_id, text, "mic", start_ms, now);
                    }
                }
                Err(e) => {
                    error!("Mic chunk transcription error: {}", e);
                }
            }
            mic_silent_polls = 0;
            mic_has_samples = false;
        }

        // Transcribe speaker if ready
        let spk_should_transcribe = pending_spk_samples.len() >= MAX_CHUNK_SAMPLES
            || (pending_spk_samples.len() >= MIN_CHUNK_SAMPLES && spk_silent_polls >= SILENCE_FLUSH_POLLS);

        if spk_should_transcribe {
            let start_ms = spk_chunk_start.duration_since(session_start).as_millis() as i64;

            match tm.transcribe_chunk(std::mem::take(&mut pending_spk_samples)) {
                Ok(text) => {
                    if !text.is_empty() {
                        let _ = sm.add_segment(&session_id, text, "speaker", start_ms, now);
                    }
                }
                Err(e) => {
                    error!("Speaker chunk transcription error: {}", e);
                }
            }
            spk_silent_polls = 0;
        }
    }
}

/// Returns true if the chunk's RMS energy is below a quiet threshold (~-40 dB).
fn is_silence(samples: &[f32]) -> bool {
    if samples.is_empty() {
        return true;
    }
    let sum_sq: f32 = samples.iter().map(|&x| x * x).sum();
    let rms = (sum_sq / samples.len() as f32).sqrt();
    rms < 0.01 // roughly -40 dB
}
