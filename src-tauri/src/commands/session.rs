use crate::llm_client::ChatMessage;
use crate::managers::session::{
    MeetingNotes, Session, SessionManager, TranscriptSegment,
};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, Manager};

fn format_ms_timestamp(ms: i64) -> String {
    let total_secs = ms / 1000;
    let hours = total_secs / 3600;
    let mins = (total_secs % 3600) / 60;
    let secs = total_secs % 60;
    if hours > 0 {
        format!("{:02}:{:02}:{:02}", hours, mins, secs)
    } else {
        format!("{:02}:{:02}", mins, secs)
    }
}

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

    // Build timestamped transcript
    let transcript_text: String = segments
        .iter()
        .map(|seg| {
            let label = if seg.source == "mic" {
                "[You]"
            } else {
                "[Other]"
            };
            format!("[{}] {}: {}", format_ms_timestamp(seg.start_ms), label, seg.text)
        })
        .collect::<Vec<_>>()
        .join("\n");

    // Compute duration from transcript span
    let duration = if let (Some(first), Some(last)) = (segments.first(), segments.last()) {
        let total_ms = last.end_ms - first.start_ms;
        let total_secs = total_ms / 1000;
        let mins = total_secs / 60;
        let secs = total_secs % 60;
        format!("{}m {}s", mins, secs)
    } else {
        "Unknown".to_string()
    };

    // Fetch session title
    let session_title = sm
        .get_session(&session_id)
        .map_err(|e| e.to_string())?
        .map(|s| s.title)
        .unwrap_or_default();

    // Fetch user notes
    let user_notes = sm
        .get_meeting_notes(&session_id)
        .map_err(|e| e.to_string())?
        .and_then(|n| n.user_notes)
        .unwrap_or_default();

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

    let system_message = "You are enhancing meeting notes. You will receive:\n\
1. The user's rough notes — these signal what THEY found important\n\
2. The full meeting transcript\n\n\
Generate polished, comprehensive meeting notes. For each line of output, prefix it with either [user] or [ai]:\n\
- [user] = content that corresponds to something the user noted (even if you've reworded it for clarity)\n\
- [ai] = new detail you added from the transcript that the user didn't capture\n\n\
Guidelines:\n\
- The user's notes tell you what matters. Their topics and emphasis are your guide.\n\
- Read like notes, not prose. \"Q3 budget = 100k (60k infra, 25k tooling, 15k contingency)\" not \"The group discussed the Q3 budget and agreed to set it at $100,000.\"\n\
- Use the user's vocabulary. If they wrote \"Kubernetes\", write \"Kubernetes\" even if transcript heard \"shiba\".\n\
- Match their tone and density.\n\
- Add important details from the transcript the user missed — names, numbers, dates, decisions, action items.\n\
- For significant topics the user didn't note at all, add them as [ai] sections.\n\
- Use markdown: ### headers, bullet points (-), **bold** for key items.\n\
- Output only the notes. No preamble.".to_string();

    let notes_section = if user_notes.trim().is_empty() {
        "No notes were taken. Generate comprehensive notes from the transcript, marking all lines as [ai].".to_string()
    } else {
        user_notes
    };

    let user_message = format!(
        "## MEETING CONTEXT\nTitle: {}\nDuration: {}\n\n## USER'S NOTES\n{}\n\n## TRANSCRIPT\n{}",
        session_title, duration, notes_section, transcript_text
    );

    let messages = vec![
        ChatMessage {
            role: "system".to_string(),
            content: system_message,
        },
        ChatMessage {
            role: "user".to_string(),
            content: user_message,
        },
    ];

    let result = crate::llm_client::send_chat_completion_messages(&provider, api_key, &model, messages)
        .await?
        .ok_or_else(|| "LLM returned no content".to_string())?;

    sm.save_meeting_notes(&session_id, None, None, None, None, Some(result.clone()))
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

/// Reactivate a completed session so it can record again.
#[tauri::command]
#[specta::specta]
pub fn reactivate_session(app: AppHandle, session_id: String) -> Result<Session, String> {
    let sm = app.state::<Arc<SessionManager>>();
    let rm = app.state::<Arc<crate::managers::audio::AudioRecordingManager>>();

    // Stop any ongoing recording first
    sm.stop_speaker_capture();
    if rm.is_recording() {
        rm.stop_session_recording();
    }

    sm.reset_speaker_state();
    let session = sm.reactivate_session(&session_id).map_err(|e| e.to_string())?;
    Ok(session)
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
pub fn search_sessions(app: AppHandle, query: String) -> Result<Vec<Session>, String> {
    let sm = app.state::<Arc<SessionManager>>();
    sm.search_sessions(&query).map_err(|e| e.to_string())
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
    sm.save_meeting_notes(&session_id, summary, action_items, decisions, user_notes, None)
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
    sm.save_meeting_notes(&session_id, None, None, None, Some(notes), None)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn save_enhanced_notes(
    app: AppHandle,
    session_id: String,
    notes: String,
) -> Result<(), String> {
    let sm = app.state::<Arc<SessionManager>>();
    sm.save_meeting_notes(&session_id, None, None, None, None, Some(notes))
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
