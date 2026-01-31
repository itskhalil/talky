use crate::managers::session::{
    MeetingNotes, Session, SessionManager, TranscriptSegment,
};
use std::sync::Arc;
use tauri::{AppHandle, Manager};

#[tauri::command]
#[specta::specta]
pub fn start_session(app: AppHandle, title: Option<String>) -> Result<Session, String> {
    let sm = app.state::<Arc<SessionManager>>();

    // Start session in the manager
    let session = sm.start_session(title).map_err(|e| e.to_string())?;

    // Start recording and transcription loop
    let rm = app.state::<Arc<crate::managers::audio::AudioRecordingManager>>();
    let tm = app.state::<Arc<crate::managers::transcription::TranscriptionManager>>();

    tm.initiate_model_load();

    rm.start_session_recording()
        .map_err(|e| e.to_string())?;

    let session_id = session.id.clone();
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        crate::actions::run_session_transcription_loop(app_clone, session_id).await;
    });

    crate::tray::change_tray_icon(&app, crate::tray::TrayIconState::Recording);

    Ok(session)
}

#[tauri::command]
#[specta::specta]
pub fn end_session(app: AppHandle) -> Result<Option<Session>, String> {
    let sm = app.state::<Arc<SessionManager>>();
    let rm = app.state::<Arc<crate::managers::audio::AudioRecordingManager>>();

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
