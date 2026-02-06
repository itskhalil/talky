use crate::managers::audio::AudioRecordingManager;
use crate::managers::transcription::TranscriptionManager;
use log::{debug, error, info};
use std::sync::Arc;
use std::time::Instant;
use tauri::AppHandle;
use tauri::Emitter;
use tauri::Manager;

#[cfg(target_os = "macos")]
use crate::mic_detect;

const POLL_INTERVAL_MS: u64 = 250; // Faster polling for responsive VAD-based triggers
const MIN_CHUNK_SAMPLES: usize = 16000; // 1s minimum at 16kHz
const MAX_CHUNK_SAMPLES: usize = 16000 * 15; // 15s — force transcribe (safety net)
const OVERLAP_SAMPLES: usize = 3200; // 200ms overlap at 16kHz for context continuity
const SPK_SILENCE_FLUSH_POLLS: u32 = 8; // 8 polls of silence (~2s at 250ms) → flush speaker audio
const WHISPER_RATE: usize = 16000;

/// Runs the session transcription loop, processing audio from mic and speaker channels.
///
/// # Arguments
/// * `app` - The Tauri app handle
/// * `session_id` - The ID of the active session
/// * `time_offset_ms` - Offset in milliseconds to add to all timestamps (for pause/resume support)
pub async fn run_session_transcription_loop(
    app: AppHandle,
    session_id: String,
    time_offset_ms: i64,
) {
    use crate::audio_toolkit::pipeline::{ChannelMode, Pipeline};
    use crate::audio_toolkit::text::{is_duplicate_segment, remove_prefix_overlap};
    use crate::audio_toolkit::vad::SileroVad;
    use crate::managers::session::{SessionAmplitudeEvent, SessionManager};
    use tokio::time::{interval, Duration};

    let sm = app.state::<Arc<SessionManager>>();
    let rm = app.state::<Arc<AudioRecordingManager>>();
    let tm = app.state::<Arc<TranscriptionManager>>();

    // Read speaker energy settings
    let settings = crate::settings::get_settings(&app);
    let speaker_energy_threshold = settings.speaker_energy_threshold;
    let skip_mic_on_speaker_energy = settings.skip_mic_on_speaker_energy;
    info!(
        "Speaker energy threshold: {:.4}, skip_mic_on_speaker_energy: {}",
        speaker_energy_threshold, skip_mic_on_speaker_energy
    );

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

    // Initialize VAD for segmentation (does NOT filter audio, only detects speech transitions)
    let vad: Option<Box<dyn crate::audio_toolkit::VoiceActivityDetector>> =
        match app.path().resolve(
            "resources/models/silero_vad_v4.onnx",
            tauri::path::BaseDirectory::Resource,
        ) {
            Ok(vad_path) => match SileroVad::new(&vad_path, 0.15) {
                Ok(silero) => {
                    log::info!("VAD initialized successfully");
                    // SileroVad now has built-in smoothing (onset_frames=2, hangover_frames=5)
                    Some(Box::new(silero))
                }
                Err(e) => {
                    log::warn!(
                        "VAD init failed, running without voice activity detection: {}",
                        e
                    );
                    None
                }
            },
            Err(e) => {
                log::warn!("Failed to resolve VAD model path: {}", e);
                None
            }
        };

    // Both mic and speaker streams are already resampled to 16kHz,
    // so Pipeline resamplers act as identity (16k→16k).
    let mut pipeline = Pipeline::new(
        WHISPER_RATE as u32,
        WHISPER_RATE as u32,
        vad,
        aec,
        ChannelMode::MicAndSpeaker,
    );

    let session_start = Instant::now();
    let mut tick = interval(Duration::from_millis(POLL_INTERVAL_MS));
    let mut pending_spk_samples: Vec<f32> = Vec::new();
    let mut spk_silent_polls: u32 = 0;
    let mut mic_chunk_start: Instant = session_start;
    let mut spk_chunk_start: Instant = session_start;
    // Track whether we have any mic samples accumulated in the pipeline
    let mut mic_has_samples = false;
    // Track previous mic transcription for prefix overlap removal
    let mut previous_mic_text = String::new();

    // Meeting app detection: track meeting apps that use the mic during recording
    #[cfg(target_os = "macos")]
    let mut tracked_meeting_apps: std::collections::HashSet<String> =
        mic_detect::filter_meeting_apps(&mic_detect::get_mic_using_apps());
    #[cfg(target_os = "macos")]
    let mut last_meeting_check = Instant::now();
    #[cfg(target_os = "macos")]
    let mut notified_apps: std::collections::HashSet<String> = std::collections::HashSet::new();
    #[cfg(target_os = "macos")]
    if !tracked_meeting_apps.is_empty() {
        log::info!(
            "Recording started with meeting apps: {:?}",
            tracked_meeting_apps
        );
    }

    loop {
        tick.tick().await;

        // Exit when session ended OR recording stopped (allows re-start)
        let session_ended = sm.get_active_session_id().as_deref() != Some(&session_id);
        let recording_stopped = !rm.is_recording();
        if session_ended || recording_stopped {
            let now = session_start.elapsed().as_millis() as i64 + time_offset_ms;

            // Session ended — flush remaining mic audio
            if rm.is_recording() {
                let final_chunk = rm.take_session_chunk();
                if !final_chunk.is_empty() {
                    pipeline.push_mic(&final_chunk);
                }
            }

            // Flush remaining speaker audio
            let final_spk = sm.take_speaker_samples();
            if !final_spk.is_empty() {
                pipeline.push_spk(&final_spk);
                pending_spk_samples.extend_from_slice(&final_spk);
            }

            // Poll final pipeline state
            pipeline.poll_event();

            // Transcribe remaining speaker first (so we can dedupe mic against it)
            if !pending_spk_samples.is_empty() {
                let start_ms = spk_chunk_start.duration_since(session_start).as_millis() as i64
                    + time_offset_ms;
                if let Ok(text) = tm.transcribe_chunk(std::mem::take(&mut pending_spk_samples)) {
                    if !text.is_empty() {
                        let _ = sm.add_segment(&session_id, text, "speaker", start_ms, now);
                    }
                }
            }

            // Apply AEC to accumulated audio before final flush
            pipeline.apply_aec_to_accumulated();

            // Transcribe remaining mic (AEC-cleaned) with deduplication
            let (remaining_mic, _remaining_spk) = pipeline.take_all_accumulated();
            if !remaining_mic.is_empty() {
                let start_ms = mic_chunk_start.duration_since(session_start).as_millis() as i64
                    + time_offset_ms;
                if let Ok(text) = tm.transcribe_chunk(remaining_mic) {
                    if !text.is_empty() {
                        // Check for duplicates against speaker segments
                        let is_dup = sm
                            .get_recent_segments(&session_id, "speaker", start_ms - 5000)
                            .map(|segments| {
                                segments.iter().any(|seg| {
                                    is_duplicate_segment(
                                        &text,
                                        start_ms,
                                        now,
                                        &seg.text,
                                        seg.start_ms,
                                        seg.end_ms,
                                        0.80, // similarity threshold
                                        300,  // time overlap threshold in ms
                                    )
                                })
                            })
                            .unwrap_or(false);

                        if !is_dup {
                            let _ = sm.add_segment(&session_id, text, "mic", start_ms, now);
                        } else {
                            debug!("Skipping duplicate mic segment (final flush)");
                        }
                    }
                }
            }

            debug!("Session transcription loop ended for {}", session_id);
            let _ = app.emit("transcription-flush-complete", &session_id);
            break;
        }

        // Poll mic samples and push into pipeline
        let new_mic = rm.take_session_chunk();
        if !new_mic.is_empty() {
            if !mic_has_samples {
                mic_chunk_start = Instant::now();
            }
            mic_has_samples = true;
            pipeline.push_mic(&new_mic);
        }

        // Poll speaker samples and push into pipeline
        let new_spk = sm.take_speaker_samples();
        if !new_spk.is_empty() {
            let spk_elapsed = session_start.elapsed().as_secs_f32();
            debug!(
                "[{:.1}s] Speaker batch: {} samples ({:.2}s), pending_total={:.2}s",
                spk_elapsed,
                new_spk.len(),
                new_spk.len() as f32 / 16000.0,
                (pending_spk_samples.len() + new_spk.len()) as f32 / 16000.0
            );
            if pending_spk_samples.is_empty() {
                spk_chunk_start = Instant::now();
            }
            pipeline.push_spk(&new_spk);
            pending_spk_samples.extend_from_slice(&new_spk);

            if is_silence(&new_spk) {
                spk_silent_polls += 1;
            } else {
                spk_silent_polls = 0;
            }
        } else {
            spk_silent_polls += 1;
        }

        // Poll pipeline for events (VAD transitions, amplitude updates)
        let pipeline_event = pipeline.poll_event();

        // Log VAD state changes (not every frame)
        let elapsed_secs = session_start.elapsed().as_secs_f32();
        let accumulated_secs = pipeline.accumulated_mic_len() as f32 / 16000.0;

        if pipeline_event.mic_speech_ended {
            info!(
                "[{:.1}s] SPEECH ENDED - vad_prob={:.2}, buffered={:.1}s audio",
                elapsed_secs, pipeline_event.mic_vad_prob, accumulated_secs
            );
        } else if pipeline_event.mic_is_speaking && !pipeline_event.mic_speech_ended {
            // Only log occasionally while speaking
            if pipeline.accumulated_mic_len() % 8000 < 500 {
                info!(
                    "[{:.1}s] SPEAKING - vad_prob={:.2}, buffered={:.1}s",
                    elapsed_secs, pipeline_event.mic_vad_prob, accumulated_secs
                );
            }
        }

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

        // Check for meeting app changes (every 2 seconds)
        #[cfg(target_os = "macos")]
        if last_meeting_check.elapsed() >= Duration::from_secs(2) {
            last_meeting_check = Instant::now();
            let current_apps = mic_detect::filter_meeting_apps(&mic_detect::get_mic_using_apps());

            // Track any new meeting apps that started using the mic
            for app_id in &current_apps {
                if !tracked_meeting_apps.contains(app_id) {
                    log::info!(
                        "Meeting app {} started using microphone",
                        mic_detect::app_name(app_id)
                    );
                    tracked_meeting_apps.insert(app_id.clone());
                }
            }

            // Check which tracked meeting apps have stopped using the mic
            // Deduplicate by app name (not bundle ID) since apps like Teams have multiple processes
            for app_id in tracked_meeting_apps.clone() {
                if !current_apps.contains(&app_id) {
                    let name = mic_detect::app_name(&app_id);
                    // Use app name for deduplication (e.g., "Teams" not bundle ID)
                    if !notified_apps.contains(name) {
                        notified_apps.insert(name.to_string());
                        log::info!("Meeting app {} ({}) stopped using microphone", name, app_id);

                        // Emit event for frontend to handle (show window + toast to stop recording)
                        let _ = app.emit("meeting-ended", name);
                    }
                    // Remove from tracked to stop checking (already notified or will be)
                    tracked_meeting_apps.remove(&app_id);
                }
            }
        }

        let now = session_start.elapsed().as_millis() as i64 + time_offset_ms;

        // Check if mic audio is ready to transcribe
        // Event-driven: trigger on VAD speech end or force-flush at 15s
        let accumulated = pipeline.accumulated_mic_len();
        let force_flush = accumulated >= MAX_CHUNK_SAMPLES;
        let vad_trigger = accumulated >= MIN_CHUNK_SAMPLES && pipeline_event.mic_speech_ended;
        let mic_should_transcribe = mic_has_samples && (force_flush || vad_trigger);

        if mic_should_transcribe {
            let trigger_reason = if force_flush {
                "15s limit"
            } else {
                "speech ended"
            };
            info!(
                "[{:.1}s] TRANSCRIBING - {:.1}s of audio (reason: {})",
                elapsed_secs,
                accumulated as f32 / WHISPER_RATE as f32,
                trigger_reason
            );

            // Flush pending speaker audio FIRST so we can dedupe mic against it.
            // This is critical: speaker audio arrives in delayed batches, so by the time
            // mic VAD triggers, speaker hasn't transcribed yet. Flush speaker first to
            // create segments that deduplication can find.
            if pending_spk_samples.len() >= MIN_CHUNK_SAMPLES / 4 {
                let spk_start_ms = spk_chunk_start.duration_since(session_start).as_millis() as i64
                    + time_offset_ms;
                if !is_silence(&pending_spk_samples) {
                    if let Ok(spk_text) =
                        tm.transcribe_chunk(std::mem::take(&mut pending_spk_samples))
                    {
                        if !spk_text.is_empty() {
                            info!(
                                "Pre-flushed speaker audio for dedup: '{}'",
                                if spk_text.len() > 50 {
                                    &spk_text[..50]
                                } else {
                                    &spk_text
                                }
                            );
                            let _ =
                                sm.add_segment(&session_id, spk_text, "speaker", spk_start_ms, now);
                        }
                    }
                } else {
                    pending_spk_samples.clear();
                }
                spk_silent_polls = 0;
                // Reset speaker chunk start after pre-flush
                spk_chunk_start = Instant::now();
            }

            let start_ms =
                mic_chunk_start.duration_since(session_start).as_millis() as i64 + time_offset_ms;

            // Apply AEC to the accumulated chunk (both streams now available and aligned)
            pipeline.apply_aec_to_accumulated();

            // Take mic audio with time-windowed speaker energy filtering
            // This zeros out mic portions where speaker was active, preserving user speech in gaps
            let mic_audio = if skip_mic_on_speaker_energy {
                const WINDOW_MS: usize = 400; // 400ms windows for speaker energy filtering
                let (filtered_mic, windows_zeroed) = pipeline.take_filtered_mic(
                    speaker_energy_threshold,
                    WINDOW_MS,
                    OVERLAP_SAMPLES,
                );

                // If all windows were zeroed, skip transcription entirely
                let total_windows =
                    (filtered_mic.len().saturating_sub(1) / (WINDOW_MS * 16) + 1).max(1);
                if windows_zeroed == total_windows && total_windows > 1 {
                    info!(
                        "Skipping mic transcription - all {} windows had speaker activity",
                        total_windows
                    );
                    mic_has_samples = false;
                    mic_chunk_start = Instant::now();
                    continue;
                }

                filtered_mic
            } else {
                // AEC only mode - take mic audio without speaker energy filtering
                let (mic, _spk) = pipeline.take_with_overlap(OVERLAP_SAMPLES);
                mic
            };

            // Skip transcription if mic audio is silent (prevents hallucinations)
            if is_silence(&mic_audio) {
                info!("Skipping mic transcription - audio is silent");
                mic_has_samples = false;
                mic_chunk_start = Instant::now();
                continue;
            }

            let audio_len = mic_audio.len();
            match tm.transcribe_chunk(mic_audio) {
                Ok(text) => {
                    info!(
                        "Transcription result: {} samples -> '{}' ({} chars)",
                        audio_len,
                        if text.len() > 100 {
                            &text[..100]
                        } else {
                            &text
                        },
                        text.len()
                    );
                    if !text.is_empty() {
                        // Remove prefix overlap from 200ms audio overlap
                        let deduped_text = if !previous_mic_text.is_empty() {
                            remove_prefix_overlap(&text, &previous_mic_text, 2)
                        } else {
                            text.clone()
                        };

                        if !deduped_text.is_empty() {
                            // Check if this mic segment duplicates a recent speaker segment
                            // Speaker channel is authoritative - skip mic if it's just echo
                            let is_dup = sm
                                .get_recent_segments(&session_id, "speaker", start_ms - 5000)
                                .map(|segments| {
                                    segments.iter().any(|seg| {
                                        is_duplicate_segment(
                                            &deduped_text,
                                            start_ms,
                                            now,
                                            &seg.text,
                                            seg.start_ms,
                                            seg.end_ms,
                                            0.80, // similarity threshold
                                            300,  // time overlap threshold in ms
                                        )
                                    })
                                })
                                .unwrap_or(false);

                            if !is_dup {
                                let _ = sm.add_segment(
                                    &session_id,
                                    deduped_text.clone(),
                                    "mic",
                                    start_ms,
                                    now,
                                );
                                // Update previous text for next overlap removal
                                previous_mic_text = text;
                            } else {
                                debug!("Skipping duplicate mic segment");
                            }
                        }
                    }
                }
                Err(e) => {
                    error!("Mic chunk transcription error: {}", e);
                }
            }
            mic_has_samples = false;
        }

        // Transcribe speaker if ready (energy-based silence detection)
        let spk_should_transcribe = pending_spk_samples.len() >= MAX_CHUNK_SAMPLES
            || (pending_spk_samples.len() >= MIN_CHUNK_SAMPLES
                && spk_silent_polls >= SPK_SILENCE_FLUSH_POLLS);

        if spk_should_transcribe {
            // Skip transcription if accumulated speaker audio is silent (prevents hallucinations like "T.")
            if is_silence(&pending_spk_samples) {
                pending_spk_samples.clear();
                spk_silent_polls = 0;
                continue;
            }

            let start_ms =
                spk_chunk_start.duration_since(session_start).as_millis() as i64 + time_offset_ms;

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
