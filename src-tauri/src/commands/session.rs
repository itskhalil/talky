use crate::managers::session::{
    MeetingNotes, Session, SessionManager, TranscriptSegment,
};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, Manager};

#[tauri::command]
#[specta::specta]
pub fn start_session(app: AppHandle, title: Option<String>) -> Result<Session, String> {
    let sm = app.state::<Arc<SessionManager>>();

    // Reset speaker state for the new session
    sm.reset_speaker_state();

    // Start session in the manager
    let session = sm.start_session(title).map_err(|e| e.to_string())?;

    // Start recording and transcription loop
    let rm = app.state::<Arc<crate::managers::audio::AudioRecordingManager>>();
    let tm = app.state::<Arc<crate::managers::transcription::TranscriptionManager>>();

    tm.initiate_model_load();

    rm.start_session_recording()
        .map_err(|e| e.to_string())?;

    // Spawn speaker capture task (macOS only)
    #[cfg(target_os = "macos")]
    {
        let speaker_buf = sm.speaker_buffer_handle();
        let shutdown = sm.speaker_shutdown_handle();
        spawn_speaker_capture(speaker_buf, shutdown);
    }

    let session_id = session.id.clone();
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        crate::actions::run_session_transcription_loop(app_clone, session_id).await;
    });

    crate::tray::change_tray_icon(&app, crate::tray::TrayIconState::Recording);

    Ok(session)
}

#[cfg(target_os = "macos")]
pub fn spawn_speaker_capture(
    buffer: Arc<std::sync::Mutex<Vec<f32>>>,
    shutdown: Arc<std::sync::atomic::AtomicBool>,
) {
    std::thread::spawn(move || {
        use crate::audio_toolkit::audio::FrameResampler;
        use crate::audio_toolkit::speaker::SpeakerInput;
        use futures_util::StreamExt;
        use std::time::Duration;

        let speaker = match SpeakerInput::new() {
            Ok(s) => s,
            Err(e) => {
                log::error!("Failed to create SpeakerInput: {}", e);
                return;
            }
        };

        let source_rate = speaker.sample_rate();
        let mut resampler = FrameResampler::new(
            source_rate as usize,
            16000,
            Duration::from_millis(30),
        );

        let mut stream = speaker.stream();

        log::info!(
            "Speaker capture started (source rate={}Hz)",
            source_rate
        );

        // Use a single-threaded tokio runtime to drive the async stream
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();

        rt.block_on(async {
            while !shutdown.load(Ordering::Relaxed) {
                match tokio::time::timeout(Duration::from_millis(200), stream.next()).await {
                    Ok(Some(chunk)) => {
                        resampler.push(&chunk, &mut |frame: &[f32]| {
                            buffer.lock().unwrap().extend_from_slice(frame);
                        });
                    }
                    Ok(None) => break,
                    Err(_) => continue,
                }
            }
        });

        log::info!("Speaker capture stopped");
    });
}

#[tauri::command]
#[specta::specta]
pub fn end_session(app: AppHandle) -> Result<Option<Session>, String> {
    let sm = app.state::<Arc<SessionManager>>();
    let rm = app.state::<Arc<crate::managers::audio::AudioRecordingManager>>();

    // Signal speaker capture to stop
    sm.stop_speaker_capture();

    let session = sm.end_session().map_err(|e| e.to_string())?;
    rm.stop_session_recording();

    crate::tray::change_tray_icon(&app, crate::tray::TrayIconState::Idle);

    Ok(session)
}

#[tauri::command]
#[specta::specta]
pub fn get_sessions(app: AppHandle) -> Result<Vec<Session>, String> {
    let sm = app.state::<Arc<SessionManager>>();
    sm.get_sessions().map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn get_session(app: AppHandle, session_id: String) -> Result<Option<Session>, String> {
    let sm = app.state::<Arc<SessionManager>>();
    sm.get_session(&session_id).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn get_session_transcript(
    app: AppHandle,
    session_id: String,
) -> Result<Vec<TranscriptSegment>, String> {
    let sm = app.state::<Arc<SessionManager>>();
    sm.get_session_transcript(&session_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn get_active_session(app: AppHandle) -> Result<Option<Session>, String> {
    let sm = app.state::<Arc<SessionManager>>();
    if let Some(id) = sm.get_active_session_id() {
        sm.get_session(&id).map_err(|e| e.to_string())
    } else {
        Ok(None)
    }
}

#[tauri::command]
#[specta::specta]
pub fn delete_session(app: AppHandle, session_id: String) -> Result<(), String> {
    let sm = app.state::<Arc<SessionManager>>();
    sm.delete_session(&session_id).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn update_session_title(
    app: AppHandle,
    session_id: String,
    title: String,
) -> Result<(), String> {
    let sm = app.state::<Arc<SessionManager>>();
    sm.update_session_title(&session_id, &title)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn get_meeting_notes(
    app: AppHandle,
    session_id: String,
) -> Result<Option<MeetingNotes>, String> {
    let sm = app.state::<Arc<SessionManager>>();
    sm.get_meeting_notes(&session_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn save_meeting_notes(
    app: AppHandle,
    session_id: String,
    summary: Option<String>,
    action_items: Option<String>,
    decisions: Option<String>,
    user_notes: Option<String>,
) -> Result<(), String> {
    let sm = app.state::<Arc<SessionManager>>();
    sm.save_meeting_notes(&session_id, summary, action_items, decisions, user_notes)
        .map_err(|e| e.to_string())
}
