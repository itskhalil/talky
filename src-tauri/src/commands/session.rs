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
                "[mic]"
            } else {
                "[speaker]"
            };
            format!("[{}] {}: {}", format_ms_timestamp(seg.start_ms), label, seg.text)
        })
        .collect::<Vec<_>>()
        .join("\n");

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

    let system_message = "You are a meeting notes enhancer. Your job is to take a user's rough notes and a meeting transcript, then produce unified chronological meeting notes.\n\n\
Rules:\n\
- Preserve the user's original text, structure, and terminology exactly\n\
- Enhance user's bullets with specific details from the transcript (names, numbers, dates, action items)\n\
- For parts of the meeting the user didn't capture, generate concise bullets summarizing key points\n\
- Prefix ALL generated content (content not from the user's notes) with [+]\n\
- Do NOT prefix content that originated from the user's notes\n\
- Use vocabulary from the user's notes throughout (their spelling of names, acronyms, project names takes priority over transcript)\n\
- Match the user's writing style: if they're terse, be terse; if they use headers, use headers for new topics\n\
- Output should read as one continuous set of chronological notes, not separate sections\n\
- Use markdown bullet points (- ) for items\n\
- If the user used markdown headers (## ), use the same style for generated topic headers".to_string();

    let user_message = if user_notes.trim().is_empty() {
        format!(
            "## MEETING TRANSCRIPT\n\n{}\n\n## TASK\n\n\
Generate comprehensive meeting notes from this transcript. \
Prefix every bullet with [+] since there are no user notes. \
Use markdown bullets (- ) and headers (## ) to organize by topic. \
Be concise but capture all key points, decisions, and action items.",
            transcript_text
        )
    } else {
        format!(
            "## USER'S NOTES\n\n{}\n\n## MEETING TRANSCRIPT\n\n{}\n\n## TASK\n\n\
Create unified chronological meeting notes:\n\
1. For each of the user's notes: Output their text, enhanced with specifics from the transcript\n\
2. For transcript sections the user didn't cover: Generate 1-3 bullets summarizing key points\n\
3. Use vocabulary from user's notes throughout (their spelling takes priority)\n\
4. Match the user's writing style and structure\n\
5. Prefix generated bullets with [+] — do NOT prefix the user's original content",
            user_notes, transcript_text
        )
    };

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
pub fn get_user_notes(
    app: AppHandle,
    session_id: String,
) -> Result<Option<String>, String> {
    let sm = app.state::<Arc<SessionManager>>();
    let notes = sm.get_meeting_notes(&session_id).map_err(|e| e.to_string())?;
    Ok(notes.and_then(|n| n.user_notes))
}
