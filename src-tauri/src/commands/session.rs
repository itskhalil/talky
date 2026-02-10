use crate::llm_client::ChatMessage;
use crate::managers::audio::AudioRecordingManager;
use crate::managers::session::{
    Folder, MeetingNotes, Session, SessionManager, Tag, TranscriptSegment,
};
use crate::managers::transcription::TranscriptionManager;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

/// Strip all blank lines from model output.
fn strip_model_blank_lines(input: &str) -> String {
    input
        .lines()
        .filter(|line| {
            let trimmed = line.trim();
            // Skip blank lines
            if trimmed.is_empty() || trimmed == "[ai]" || trimmed == "[noted]" {
                return false;
            }
            // Skip horizontal rules
            if trimmed.len() >= 3 && trimmed.chars().all(|c| c == '-' || c == '*' || c == '_') {
                return false;
            }
            true
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Force-flush any buffered audio through the transcription pipeline.
/// Called before chat so the transcript is as up-to-date as possible.
#[tauri::command]
#[specta::specta]
pub async fn flush_pending_audio(app: AppHandle, session_id: String) -> Result<(), String> {
    let sm = app.state::<Arc<SessionManager>>();
    let rm = app.state::<Arc<AudioRecordingManager>>();
    let tm = app.state::<Arc<TranscriptionManager>>();

    // Only flush if we're actively recording this session
    if sm.get_active_session_id().as_deref() != Some(&session_id) {
        return Ok(());
    }
    if !rm.is_recording() {
        return Ok(());
    }

    // Take whatever mic audio has accumulated
    let mic_chunk = rm.take_session_chunk();
    if !mic_chunk.is_empty() {
        if let Ok(text) = tm.transcribe_chunk(mic_chunk) {
            if !text.is_empty() {
                let _ = sm.add_segment(&session_id, text, "mic", 0, 0);
            }
        }
    }

    // Take whatever speaker audio has accumulated
    let spk_chunk = sm.take_speaker_samples();
    if !spk_chunk.is_empty() {
        if let Ok(text) = tm.transcribe_chunk(spk_chunk) {
            if !text.is_empty() {
                let _ = sm.add_segment(&session_id, text, "speaker", 0, 0);
            }
        }
    }

    Ok(())
}

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
            format!(
                "[{}] {}: {}",
                format_ms_timestamp(seg.start_ms),
                label,
                seg.text
            )
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

    let mut system_message = include_str!("../../resources/prompts/enhance_notes.txt").to_string();

    // Inject custom words into the prompt for vocabulary correction
    if !settings.custom_words.is_empty() {
        system_message.push_str(&format!(
            "\n\nDOMAIN VOCABULARY: The following terms are important and should be spelled exactly as shown: {}\nIf the transcript contains misspellings or misheard versions of these terms, correct them.",
            settings.custom_words.join(", ")
        ));
    }

    let notes_section = if user_notes.trim().is_empty() {
        "No notes were taken. Generate concise notes from the transcript, marking all lines as [ai].".to_string()
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

    let result =
        crate::llm_client::send_chat_completion_messages(&provider, api_key, &model, messages)
            .await?
            .ok_or_else(|| "LLM returned no content".to_string())?;

    log::debug!(
        "[enhance-notes] Raw LLM result (non-stream) | session={} len={}",
        session_id,
        result.len()
    );

    // Strip blank lines from model output before saving
    let cleaned = strip_model_blank_lines(&result);

    log::info!(
        "[enhance-notes] After strip (non-stream) | session={} before={} after={}",
        session_id,
        result.len(),
        cleaned.len()
    );

    if cleaned.is_empty() && !result.is_empty() {
        log::error!(
            "[enhance-notes] CRITICAL: All content stripped! session={} raw_preview={:?}",
            session_id,
            &result[..result.len().min(1000)]
        );
    }

    sm.save_meeting_notes(
        &session_id,
        None,
        None,
        None,
        None,
        Some(cleaned.clone()),
        Some(false),
    )
    .map_err(|e| e.to_string())?;

    Ok(cleaned)
}

#[tauri::command]
#[specta::specta]
pub fn get_session_summary(app: AppHandle, session_id: String) -> Result<Option<String>, String> {
    let sm = app.state::<Arc<SessionManager>>();
    let notes = sm
        .get_meeting_notes(&session_id)
        .map_err(|e| e.to_string())?;
    Ok(notes.and_then(|n| n.summary))
}

/// Streaming version of generate_session_summary
/// Emits enhance-notes-chunk events for progressive UI updates
#[tauri::command]
#[specta::specta]
pub async fn generate_session_summary_stream(
    app: AppHandle,
    session_id: String,
) -> Result<(), String> {
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
            format!(
                "[{}] {}: {}",
                format_ms_timestamp(seg.start_ms),
                label,
                seg.text
            )
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

    let mut system_message = include_str!("../../resources/prompts/enhance_notes.txt").to_string();

    // Inject custom words into the prompt for vocabulary correction
    if !settings.custom_words.is_empty() {
        system_message.push_str(&format!(
            "\n\nDOMAIN VOCABULARY: The following terms are important and should be spelled exactly as shown: {}\nIf the transcript contains misspellings or misheard versions of these terms, correct them.",
            settings.custom_words.join(", ")
        ));
    }

    let notes_section = if user_notes.trim().is_empty() {
        "No notes were taken. Generate concise notes from the transcript, marking all lines as [ai].".to_string()
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
            content: system_message.clone(),
        },
        ChatMessage {
            role: "user".to_string(),
            content: user_message.clone(),
        },
    ];

    // Log the full context being sent to the model
    log::info!(
        "[enhance-notes] Sending request | session={} provider={} model={}",
        session_id,
        provider.id,
        model
    );
    log::debug!(
        "[enhance-notes] System prompt ({} chars): {:?}",
        system_message.len(),
        &system_message[..system_message.len().min(500)]
    );
    log::debug!(
        "[enhance-notes] User message ({} chars): {:?}",
        user_message.len(),
        &user_message[..user_message.len().min(1000)]
    );

    // Use streaming API
    let result = crate::llm_client::stream_chat_completion_messages(
        &app,
        &session_id,
        &provider,
        api_key,
        &model,
        messages,
    )
    .await?;

    // Log the FULL model response
    log::info!(
        "[enhance-notes] Full model response | session={} len={}",
        session_id,
        result.len()
    );
    log::info!(
        "[enhance-notes] === RAW MODEL OUTPUT START ===\n{}\n=== RAW MODEL OUTPUT END ===",
        result
    );

    // Strip blank lines from model output before saving
    let cleaned = strip_model_blank_lines(&result);

    log::info!(
        "[enhance-notes] After strip | session={} before={} after={} stripped={}",
        session_id,
        result.len(),
        cleaned.len(),
        result.len().saturating_sub(cleaned.len())
    );

    log::info!(
        "[enhance-notes] === CLEANED OUTPUT START ===\n{}\n=== CLEANED OUTPUT END ===",
        cleaned
    );

    if cleaned.is_empty() && !result.is_empty() {
        log::error!(
            "[enhance-notes] CRITICAL: All content stripped! session={}",
            session_id
        );
    }

    log::info!(
        "[enhance-notes] Saving to DB | session={} len={}",
        session_id,
        cleaned.len()
    );

    // Save the complete result to database
    sm.save_meeting_notes(
        &session_id,
        None,
        None,
        None,
        None,
        Some(cleaned),
        Some(false),
    )
    .map_err(|e| e.to_string())?;

    Ok(())
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

    rm.start_session_recording().map_err(|e| e.to_string())?;

    // Spawn speaker capture task (macOS only)
    #[cfg(target_os = "macos")]
    {
        let speaker_buf = sm.speaker_buffer_handle();
        let shutdown = sm.speaker_shutdown_handle();
        let handle = spawn_speaker_capture(speaker_buf, shutdown);
        sm.set_speaker_thread_handle(handle);
    }

    // Get time offset from existing segments (for pause/resume continuity)
    let time_offset_ms = sm.get_session_time_offset(&session_id);

    let app_clone = app.clone();
    let sid = session_id.clone();
    tauri::async_runtime::spawn(async move {
        crate::actions::run_session_transcription_loop(app_clone, sid, time_offset_ms).await;
    });

    crate::tray::change_tray_icon(&app, crate::tray::TrayIconState::Recording);
    crate::tray::start_recording_indicator(&app);

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
    crate::tray::stop_recording_indicator(&app);

    Ok(())
}

#[cfg(target_os = "macos")]
pub fn spawn_speaker_capture(
    buffer: Arc<std::sync::Mutex<Vec<f32>>>,
    shutdown: Arc<std::sync::atomic::AtomicBool>,
) -> std::thread::JoinHandle<()> {
    use crate::utils::MutexExt;

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
        let mut resampler =
            FrameResampler::new(source_rate as usize, 16000, Duration::from_millis(30));

        let mut stream = speaker.stream();

        log::info!("Speaker capture started (source rate={}Hz)", source_rate);

        // Use a single-threaded tokio runtime to drive the async stream
        let rt = match tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
        {
            Ok(rt) => rt,
            Err(e) => {
                log::error!("Failed to create Tokio runtime for speaker capture: {}", e);
                return;
            }
        };

        rt.block_on(async {
            // Use Acquire ordering to see the Release from stop_speaker_capture
            while !shutdown.load(Ordering::Acquire) {
                match tokio::time::timeout(Duration::from_millis(200), stream.next()).await {
                    Ok(Some(chunk)) => {
                        resampler.push(&chunk, &mut |frame: &[f32]| {
                            buffer.lock_or_recover().extend_from_slice(frame);
                        });
                    }
                    Ok(None) => break,
                    Err(_) => continue,
                }
            }
        });

        log::info!("Speaker capture stopped");
    })
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
    let session = sm
        .reactivate_session(&session_id)
        .map_err(|e| e.to_string())?;
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
    crate::tray::stop_recording_indicator(&app);

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
    sm.get_meeting_notes(&session_id).map_err(|e| e.to_string())
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
    sm.save_meeting_notes(
        &session_id,
        summary,
        action_items,
        decisions,
        user_notes,
        None,
        None,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn save_user_notes(app: AppHandle, session_id: String, notes: String) -> Result<(), String> {
    let sm = app.state::<Arc<SessionManager>>();
    sm.save_meeting_notes(&session_id, None, None, None, Some(notes), None, None)
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
    sm.save_meeting_notes(&session_id, None, None, None, None, Some(notes), Some(true))
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn get_user_notes(app: AppHandle, session_id: String) -> Result<Option<String>, String> {
    let sm = app.state::<Arc<SessionManager>>();
    let notes = sm
        .get_meeting_notes(&session_id)
        .map_err(|e| e.to_string())?;
    Ok(notes.and_then(|n| n.user_notes))
}

// ==================== Folder Commands ====================

#[tauri::command]
#[specta::specta]
pub fn create_folder(
    app: AppHandle,
    name: String,
    color: Option<String>,
) -> Result<Folder, String> {
    let sm = app.state::<Arc<SessionManager>>();
    sm.create_folder(name, color).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn update_folder(
    app: AppHandle,
    folder_id: String,
    name: String,
    color: Option<String>,
) -> Result<(), String> {
    let sm = app.state::<Arc<SessionManager>>();
    sm.update_folder(&folder_id, name, color)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn delete_folder(app: AppHandle, folder_id: String) -> Result<(), String> {
    let sm = app.state::<Arc<SessionManager>>();
    sm.delete_folder(&folder_id).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn get_folders(app: AppHandle) -> Result<Vec<Folder>, String> {
    let sm = app.state::<Arc<SessionManager>>();
    sm.get_folders().map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn move_session_to_folder(
    app: AppHandle,
    session_id: String,
    folder_id: Option<String>,
) -> Result<(), String> {
    let sm = app.state::<Arc<SessionManager>>();
    sm.move_session_to_folder(&session_id, folder_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn get_sessions_by_folder(
    app: AppHandle,
    folder_id: Option<String>,
) -> Result<Vec<Session>, String> {
    let sm = app.state::<Arc<SessionManager>>();
    sm.get_sessions_by_folder(folder_id)
        .map_err(|e| e.to_string())
}

// ==================== Tag Commands ====================

#[tauri::command]
#[specta::specta]
pub fn create_tag(app: AppHandle, name: String, color: Option<String>) -> Result<Tag, String> {
    let sm = app.state::<Arc<SessionManager>>();
    sm.create_tag(name, color).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn update_tag(
    app: AppHandle,
    tag_id: String,
    name: String,
    color: Option<String>,
) -> Result<(), String> {
    let sm = app.state::<Arc<SessionManager>>();
    sm.update_tag(&tag_id, name, color)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn delete_tag(app: AppHandle, tag_id: String) -> Result<(), String> {
    let sm = app.state::<Arc<SessionManager>>();
    sm.delete_tag(&tag_id).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn get_tags(app: AppHandle) -> Result<Vec<Tag>, String> {
    let sm = app.state::<Arc<SessionManager>>();
    sm.get_tags().map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn add_tag_to_session(
    app: AppHandle,
    session_id: String,
    tag_id: String,
) -> Result<(), String> {
    let sm = app.state::<Arc<SessionManager>>();
    sm.add_tag_to_session(&session_id, &tag_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn remove_tag_from_session(
    app: AppHandle,
    session_id: String,
    tag_id: String,
) -> Result<(), String> {
    let sm = app.state::<Arc<SessionManager>>();
    sm.remove_tag_from_session(&session_id, &tag_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn get_session_tags(app: AppHandle, session_id: String) -> Result<Vec<Tag>, String> {
    let sm = app.state::<Arc<SessionManager>>();
    sm.get_session_tags(&session_id).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn set_session_tags(
    app: AppHandle,
    session_id: String,
    tag_ids: Vec<String>,
) -> Result<(), String> {
    let sm = app.state::<Arc<SessionManager>>();
    sm.set_session_tags(&session_id, tag_ids)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn get_sessions_by_tag(app: AppHandle, tag_id: String) -> Result<Vec<Session>, String> {
    let sm = app.state::<Arc<SessionManager>>();
    sm.get_sessions_by_tag(&tag_id).map_err(|e| e.to_string())
}
