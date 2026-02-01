use crate::managers::session::{
    MeetingNotes, Session, SessionManager, TranscriptSegment,
};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, Manager};

#[tauri::command]
#[specta::specta]
pub async fn generate_session_summary(
    app: AppHandle,
    session_id: String,
) -> Result<String, String> {
    let sm = app.state::<Arc<SessionManager>>();
    let segments = sm
        .get_session_transcript(&session_id)
        .map_err(|e| e.to_string())?;

    if segments.is_empty() {
        return Err("No transcript segments to summarize".to_string());
    }

    let transcript_text: String = segments
        .iter()
        .map(|seg| {
            let label = if seg.source == "mic" {
                "[mic]"
            } else {
                "[speaker]"
            };
            format!("{}: {}", label, seg.text)
        })
        .collect::<Vec<_>>()
        .join("\n");

    let settings = crate::settings::get_settings(&app);

    let provider = settings
        .active_post_process_provider()
        .ok_or_else(|| "No post-process provider configured".to_string())?
        .clone();

    let api_key = settings
        .post_process_api_keys
        .get(&provider.id)
        .cloned()
        .unwrap_or_default();

    let model = settings
        .post_process_models
        .get(&provider.id)
        .cloned()
        .unwrap_or_default();

    if model.is_empty() {
        return Err("No post-process model configured".to_string());
    }

    let prompt = format!(
        "Summarize the following meeting transcript:\n\n{}",
        transcript_text
    );

    let result = crate::llm_client::send_chat_completion(&provider, api_key, &model, prompt)
        .await?
        .ok_or_else(|| "LLM returned no content".to_string())?;

    sm.save_meeting_notes(&session_id, Some(result.clone()), None, None, None)
        .map_err(|e| e.to_string())?;

    Ok(result)
}

#[tauri::command]
#[specta::specta]
pub fn get_session_summary(
    app: AppHandle,
    session_id: String,
) -> Result<Option<String>, String> {
    let sm = app.state::<Arc<SessionManager>>();
    let notes = sm
        .get_meeting_notes(&session_id)
        .map_err(|e| e.to_string())?;
    Ok(notes.and_then(|n| n.summary))
}

/// Create a new session (Note) without starting recording.
#[tauri::command]
#[specta::specta]
pub fn start_session(app: AppHandle, title: Option<String>) -> Result<Session, String> {
    let sm = app.state::<Arc<SessionManager>>();
    sm.reset_speaker_state();
    let session = sm.start_session(title).map_err(|e| e.to_string())?;
    Ok(session)
}

/// Start recording within an existing session.
#[tauri::command]
#[specta::specta]
pub fn start_session_recording(app: AppHandle, session_id: String) -> Result<(), String> {
    let sm = app.state::<Arc<SessionManager>>();

    // Verify this session is the active one
    if sm.get_active_session_id().as_deref() != Some(&session_id) {
        return Err("Session is not active".to_string());
    }

    // Reset speaker state for each recording pass
    sm.reset_speaker_state();

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

    let app_clone = app.clone();
    let sid = session_id.clone();
    tauri::async_runtime::spawn(async move {
        crate::actions::run_session_transcription_loop(app_clone, sid).await;
    });

    crate::tray::change_tray_icon(&app, crate::tray::TrayIconState::Recording);

    Ok(())
}

/// Stop recording but keep the session open.
#[tauri::command]
#[specta::specta]
pub fn stop_session_recording(app: AppHandle, session_id: String) -> Result<(), String> {
    let sm = app.state::<Arc<SessionManager>>();
    let rm = app.state::<Arc<crate::managers::audio::AudioRecordingManager>>();

    // Verify this session is the active one
    if sm.get_active_session_id().as_deref() != Some(&session_id) {
        return Err("Session is not active".to_string());
    }

    sm.stop_speaker_capture();
    rm.stop_session_recording();

    crate::tray::change_tray_icon(&app, crate::tray::TrayIconState::Idle);

    Ok(())
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

    // Stop recording if active
    sm.stop_speaker_capture();
    if rm.is_recording() {
        rm.stop_session_recording();
    }

    let session = sm.end_session().map_err(|e| e.to_string())?;

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

#[tauri::command]
#[specta::specta]
pub fn save_user_notes(
    app: AppHandle,
    session_id: String,
    notes: String,
) -> Result<(), String> {
    let sm = app.state::<Arc<SessionManager>>();
    sm.save_meeting_notes(&session_id, None, None, None, Some(notes))
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn get_user_notes(
    app: AppHandle,
    session_id: String,
) -> Result<Option<String>, String> {
    let sm = app.state::<Arc<SessionManager>>();
    let notes = sm.get_meeting_notes(&session_id).map_err(|e| e.to_string())?;
    Ok(notes.and_then(|n| n.user_notes))
}
