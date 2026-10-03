use crate::audio_toolkit::session_transcriber::{
    ChunkEngine, Segment, SessionTranscriber, TranscriberConfig,
};
use crate::managers::audio::AudioRecordingManager;
use crate::managers::session::{SessionAmplitudeEvent, SessionManager};
use crate::managers::transcription::TranscriptionManager;
use log::{debug, error, info, warn};
use std::sync::Arc;
use std::time::Instant;
use tauri::AppHandle;
use tauri::Emitter;
use tauri::Manager;
use transcribe_rs::TranscriptionResult;

const POLL_INTERVAL_MS: u64 = 250;

/// Runs chunks through the app's loaded model (Core ML or ONNX Parakeet),
/// with the user's word corrections and output filter applied.
struct LiveEngine(Arc<TranscriptionManager>);

impl ChunkEngine for LiveEngine {
    fn transcribe(&mut self, audio: &[f32]) -> anyhow::Result<TranscriptionResult> {
        self.0.transcribe_chunk(audio.to_vec())
    }
}

/// Runs the session transcription loop: polls mic and system audio, feeds
/// them through the session transcriber, and stores the segments it emits.
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
    use crate::audio_toolkit::level_meter::LevelMeter;
    use tokio::time::{interval, Duration};

    let sm = app.state::<Arc<SessionManager>>().inner().clone();
    let rm = app.state::<Arc<AudioRecordingManager>>().inner().clone();
    let tm = app.state::<Arc<TranscriptionManager>>().inner().clone();

    let settings = crate::settings::get_settings(&app);
    let save_debug_recordings = settings.debug_mode && settings.save_debug_recordings;
    let debug_recordings_max_count = settings.debug_recordings_max_count as usize;

    let mut config = TranscriberConfig::default();
    // Echo cancellation needs the system audio as its reference.
    let capturing_system_audio = cfg!(any(target_os = "macos", target_os = "windows"))
        && !settings.debug_disable_speaker_capture;
    if !capturing_system_audio {
        config.aec = false;
    }
    let vad_path = match app.path().resolve(
        "resources/models/silero_vad_v4.onnx",
        tauri::path::BaseDirectory::Resource,
    ) {
        Ok(p) => p,
        Err(e) => {
            error!("Failed to resolve VAD model path: {e}");
            let _ = app.emit("transcription-flush-complete", &session_id);
            return;
        }
    };
    let mut transcriber = match SessionTranscriber::new(config.clone(), &vad_path) {
        Ok(t) => t,
        Err(e) => {
            error!("Failed to start session transcriber: {e}");
            let _ = app.emit("transcription-flush-complete", &session_id);
            return;
        }
    };
    let mut engine = LiveEngine(tm.clone());
    let mut meter = LevelMeter::new();
    let session_start = Instant::now();

    // Create a streaming debug writer if debug recording is enabled.
    // Captures raw (pre-pipeline) mic and speaker audio for offline pipeline eval.
    let mut debug_writer: Option<crate::debug_recording::DebugRecordingWriter> =
        if save_debug_recordings {
            match crate::get_user_data_dir(&app) {
                Ok(data_dir) => {
                    let session_dir = data_dir.join("debug_recordings").join(&session_id);
                    match crate::debug_recording::DebugRecordingWriter::create(session_dir) {
                        Ok(w) => {
                            info!("Debug recording started for session {}", session_id);
                            Some(w)
                        }
                        Err(e) => {
                            warn!("Failed to start debug recording: {}", e);
                            None
                        }
                    }
                }
                Err(e) => {
                    warn!("Could not resolve data dir for debug recording: {}", e);
                    None
                }
            }
        } else {
            None
        };

    let store = |segments: Vec<Segment>| {
        for seg in segments {
            debug!(
                "{} segment {}-{} ms ({} chars)",
                seg.channel.source(),
                seg.start_ms,
                seg.end_ms,
                seg.text.len()
            );
            if let Err(e) = sm.add_segment(
                &session_id,
                seg.text,
                seg.channel.source(),
                seg.start_ms + time_offset_ms,
                seg.end_ms + time_offset_ms,
            ) {
                error!("Failed to store transcript segment: {e}");
            }
        }
    };

    let mut tick = interval(Duration::from_millis(POLL_INTERVAL_MS));

    loop {
        tick.tick().await;

        // Exit when session ended OR recording stopped (allows re-start)
        let session_ended = sm.get_active_session_id().as_deref() != Some(&session_id);
        let recording_stopped = !rm.is_recording();
        if session_ended || recording_stopped {
            // Session ended — take whatever audio is left on both channels
            let final_mic = if rm.is_recording() {
                rm.take_session_chunk()
            } else {
                Vec::new()
            };
            let final_spk = sm.take_speaker_samples();
            if let Some(ref mut w) = debug_writer {
                w.write_mic(&final_mic);
                w.write_spk(&final_spk);
            }
            match transcriber.push(&final_mic, &final_spk, &mut engine) {
                Ok(segments) => store(segments),
                Err(e) => error!("Transcription error: {e}"),
            }
            match transcriber.finish(&mut engine) {
                Ok(segments) => store(segments),
                Err(e) => error!("Final transcription error: {e}"),
            }
            sm.flush_done();
            info!("Session transcriber stats: {:?}", transcriber.stats);

            // Finalize debug recording: write metadata.json and enforce retention limit.
            if let Some(writer) = debug_writer.take() {
                finalize_debug_recording(
                    &app,
                    &sm,
                    &session_id,
                    writer,
                    session_start.elapsed().as_secs_f64(),
                    &config,
                    debug_recordings_max_count,
                );
            }

            debug!("Session transcription loop ended for {}", session_id);
            let _ = app.emit("transcription-flush-complete", &session_id);
            break;
        }

        tm.mark_active();
        let new_mic = rm.take_session_chunk();
        let new_spk = sm.take_speaker_samples();
        if let Some(ref mut w) = debug_writer {
            w.write_mic(&new_mic);
            w.write_spk(&new_spk);
        }

        meter.push(&new_mic, &new_spk);
        if let Some(amp) = meter.poll() {
            let _ = app.emit(
                "session-amplitude",
                SessionAmplitudeEvent {
                    session_id: session_id.clone(),
                    mic: (amp.mic_level * 1000.0) as u16,
                    speaker: (amp.spk_level * 1000.0) as u16,
                },
            );
        }

        match transcriber.push(&new_mic, &new_spk, &mut engine) {
            Ok(segments) => store(segments),
            Err(e) => error!("Transcription error: {e}"),
        }

        // Someone (e.g. chat) wants the transcript up to date right now.
        if sm.flush_pending() {
            match transcriber.flush(&mut engine) {
                Ok(segments) => store(segments),
                Err(e) => error!("Transcription flush error: {e}"),
            }
            sm.flush_done();
        }
    }
}

fn finalize_debug_recording(
    app: &AppHandle,
    sm: &SessionManager,
    session_id: &str,
    writer: crate::debug_recording::DebugRecordingWriter,
    duration_seconds: f64,
    config: &TranscriberConfig,
    max_count: usize,
) {
    let segments = sm
        .get_session_transcript(session_id)
        .unwrap_or_default()
        .into_iter()
        .map(|s| crate::debug_recording::RecordingSegment {
            text: s.text,
            source: s.source,
            start_ms: s.start_ms,
            end_ms: s.end_ms,
        })
        .collect();
    let metadata = crate::debug_recording::RecordingMetadata {
        version: 2,
        session_id: session_id.to_string(),
        recorded_at: crate::debug_recording::now_rfc3339(),
        duration_seconds,
        pipeline_config: None,
        transcriber: Some(config.clone()),
        transcript_segments: segments,
    };
    if let Err(e) = writer.finalize(metadata) {
        warn!("Failed to finalize debug recording: {}", e);
    }
    if let Ok(data_dir) = crate::get_user_data_dir(app) {
        let _ = crate::debug_recording::cleanup_old_recordings(
            &data_dir.join("debug_recordings"),
            max_count,
        );
    }
}
