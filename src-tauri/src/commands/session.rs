use crate::llm_client::{ChatMessage, ContentPart, ImageUrl};
use crate::managers::audio::AudioRecordingManager;
use crate::managers::session::{
    Attachment, Folder, MeetingNotes, Session, SessionManager, Tag, TranscriptSegment,
};
use crate::managers::transcription::TranscriptionManager;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, Manager};

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

    let settings = crate::settings::get_settings(&app);

    // Build timestamped transcript
    let transcript_text: String = segments
        .iter()
        .map(|seg| {
            let label = if seg.source == "mic" {
                "[Mic]"
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

    // Fetch user notes
    let user_notes = sm
        .get_meeting_notes(&session_id)
        .map_err(|e| e.to_string())?
        .and_then(|n| n.user_notes)
        .unwrap_or_default();

    // Get session's environment_id
    let session = sm
        .get_session(&session_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Session not found".to_string())?;

    // Get summarisation config from environment or fall back to legacy settings
    let (base_url, api_key, model) = settings
        .get_summarisation_config(session.environment_id.as_deref())
        .ok_or_else(|| "No summarisation model configured. Please configure a model in Settings → Model Environments.".to_string())?;

    let mut system_message = include_str!("../../resources/prompts/enhance_notes.txt").to_string();

    // Inject custom words (+ user name) into the prompt for vocabulary correction
    let mut vocab = settings.custom_words.clone();
    let user_name_trimmed = settings.user_name.trim().to_string();
    if !user_name_trimmed.is_empty() && !vocab.contains(&user_name_trimmed) {
        vocab.push(user_name_trimmed);
    }
    if !vocab.is_empty() {
        system_message.push_str(&format!(
            "\n\nDOMAIN VOCABULARY: The following terms are important and should be spelled exactly as shown: {}\nIf the transcript contains misspellings or misheard versions of these terms, correct them.",
            vocab.join(", ")
        ));
    }

    // Inject user identity when name is set
    if !settings.user_name.trim().is_empty() {
        let name = settings.user_name.trim();
        system_message.push_str(&format!(
            "\n\nUSER IDENTITY: {} is the person who recorded this meeting. \
             Their microphone audio is labeled [Mic] in the transcript.",
            name
        ));
    }

    // Explain what transcript labels mean so the LLM handles in-person meetings correctly
    system_message.push_str(
        "\n\nSPEAKER CONTEXT: Transcript labels indicate audio sources, not individual speakers.\
         \n- [Mic] = the recorder's microphone. In in-person or hybrid meetings, this captures everyone in the room.\
         \n- [Other] = system audio from remote participants (e.g. a video call).\
         \nIf only [Mic] segments appear, multiple speakers are likely mixed together. \
         Do not assume one person said everything."
    );

    let notes_section = if user_notes.trim().is_empty() {
        "No notes were taken.".to_string()
    } else {
        user_notes
    };

    let user_instructions = include_str!("../../resources/prompts/enhance_notes_user.txt");
    let user_message = format!(
        "<user_notes>\n{}\n</user_notes>\n\n<transcript>\n{}\n</transcript>\n\n{}",
        notes_section, transcript_text, user_instructions
    );

    let messages = vec![
        ChatMessage::text("system", system_message),
        ChatMessage::text("user", user_message),
    ];

    let result = crate::llm_client::send_chat_completion(&base_url, &api_key, &model, messages)
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

    let settings = crate::settings::get_settings(&app);

    // Build timestamped transcript
    let transcript_text: String = segments
        .iter()
        .map(|seg| {
            let label = if seg.source == "mic" {
                "[Mic]"
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

    // Fetch user notes
    let user_notes = sm
        .get_meeting_notes(&session_id)
        .map_err(|e| e.to_string())?
        .and_then(|n| n.user_notes)
        .unwrap_or_default();

    // Get session's environment_id
    let session = sm
        .get_session(&session_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Session not found".to_string())?;

    // Get summarisation config from environment or fall back to legacy settings
    let (base_url, api_key, model) = settings
        .get_summarisation_config(session.environment_id.as_deref())
        .ok_or_else(|| "No summarisation model configured. Please configure a model in Settings → Model Environments.".to_string())?;

    let mut system_message = include_str!("../../resources/prompts/enhance_notes.txt").to_string();

    // Inject custom words (+ user name) into the prompt for vocabulary correction
    let mut vocab = settings.custom_words.clone();
    let user_name_trimmed = settings.user_name.trim().to_string();
    if !user_name_trimmed.is_empty() && !vocab.contains(&user_name_trimmed) {
        vocab.push(user_name_trimmed);
    }
    if !vocab.is_empty() {
        system_message.push_str(&format!(
            "\n\nDOMAIN VOCABULARY: The following terms are important and should be spelled exactly as shown: {}\nIf the transcript contains misspellings or misheard versions of these terms, correct them.",
            vocab.join(", ")
        ));
    }

    // Inject user identity when name is set
    if !settings.user_name.trim().is_empty() {
        let name = settings.user_name.trim();
        system_message.push_str(&format!(
            "\n\nUSER IDENTITY: {} is the person who recorded this meeting. \
             Their microphone audio is labeled [Mic] in the transcript.",
            name
        ));
    }

    // Explain what transcript labels mean so the LLM handles in-person meetings correctly
    system_message.push_str(
        "\n\nSPEAKER CONTEXT: Transcript labels indicate audio sources, not individual speakers.\
         \n- [Mic] = the recorder's microphone. In in-person or hybrid meetings, this captures everyone in the room.\
         \n- [Other] = system audio from remote participants (e.g. a video call).\
         \nIf only [Mic] segments appear, multiple speakers are likely mixed together. \
         Do not assume one person said everything."
    );

    let notes_section = if user_notes.trim().is_empty() {
        "No notes were taken.".to_string()
    } else {
        user_notes
    };

    // Fetch attachments for this session
    let attachments = sm.get_attachments(&session_id).map_err(|e| e.to_string())?;

    // Build document context from attachments
    let mut document_context = String::new();
    let mut image_parts: Vec<ContentPart> = Vec::new();

    for att in &attachments {
        if att.mime_type.starts_with("image/") {
            // Include images directly if they exist
            if let Ok(bytes) = std::fs::read(&att.file_path) {
                let base64_data = BASE64.encode(&bytes);
                let data_url = format!("data:{};base64,{}", att.mime_type, base64_data);
                image_parts.push(ContentPart::ImageUrl {
                    image_url: ImageUrl { url: data_url },
                });
                log::info!(
                    "[enhance-notes] Including image attachment: {} ({} bytes)",
                    att.filename,
                    bytes.len()
                );
            }
        } else if att.mime_type == "application/pdf" {
            // For PDFs, use extracted text if available
            if let Some(ref text) = att.extracted_text {
                if !text.is_empty() {
                    document_context
                        .push_str(&format!("\n\n## DOCUMENT: {}\n{}\n", att.filename, text));
                    log::info!(
                        "[enhance-notes] Including PDF text: {} ({} chars)",
                        att.filename,
                        text.len()
                    );
                }
            }
        }
    }

    // Build the user message: inputs first (XML tags), then instructions
    let user_instructions = include_str!("../../resources/prompts/enhance_notes_user.txt");
    let mut attachments_section = String::new();
    if !document_context.is_empty() {
        attachments_section = format!("\n\n<attachments>{}</attachments>", document_context);
    }

    let user_message = format!(
        "<user_notes>\n{}\n</user_notes>\n\n<transcript>\n{}\n</transcript>{}\n\n{}",
        notes_section, transcript_text, attachments_section, user_instructions
    );

    // Build messages - use multimodal if we have images, otherwise text-only
    let messages = if image_parts.is_empty() {
        vec![
            ChatMessage::text("system", system_message.clone()),
            ChatMessage::text("user", user_message.clone()),
        ]
    } else {
        // For multimodal, include text first then images
        let mut parts = vec![ContentPart::Text {
            text: user_message.clone(),
        }];
        parts.extend(image_parts);

        vec![
            ChatMessage::text("system", system_message.clone()),
            ChatMessage::multimodal("user", parts),
        ]
    };

    log::info!(
        "[enhance-notes] Including {} attachments ({} images, {} with extracted text)",
        attachments.len(),
        attachments
            .iter()
            .filter(|a| a.mime_type.starts_with("image/"))
            .count(),
        attachments
            .iter()
            .filter(|a| a.extracted_text.is_some())
            .count()
    );

    // Log the full context being sent to the model
    log::info!(
        "[enhance-notes] Sending request | session={} url={} model={}",
        session_id,
        base_url,
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
    let result = crate::llm_client::stream_chat_completion(
        &app,
        &session_id,
        &base_url,
        &api_key,
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

    // Get the default environment ID from settings
    let settings = crate::settings::get_settings(&app);
    let default_env_id = settings.default_environment_id.clone();

    let session = sm
        .start_session(title, default_env_id)
        .map_err(|e| e.to_string())?;
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

    // Check debug flags
    let settings = crate::settings::get_settings(&app);

    if settings.debug_disable_model_loading {
        log::warn!("Model loading disabled by debug flag");
    } else {
        tm.initiate_model_load();
    }

    rm.start_session_recording().map_err(|e| e.to_string())?;

    // Spawn speaker capture task (macOS and Windows)
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        if settings.debug_disable_speaker_capture {
            log::warn!("Speaker capture disabled by debug flag");
        } else {
            let speaker_buf = sm.speaker_buffer_handle();
            let shutdown = sm.speaker_shutdown_handle();
            let handle = spawn_speaker_capture(speaker_buf, shutdown);
            sm.set_speaker_thread_handle(handle);
        }
    }

    // Get time offset from existing segments (for pause/resume continuity)
    let time_offset_ms = sm.get_session_time_offset(&session_id);

    let app_clone = app.clone();
    let sid = session_id.clone();
    tauri::async_runtime::spawn(async move {
        crate::actions::run_session_transcription_loop(app_clone, sid, time_offset_ms).await;
    });

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

    crate::hide_pill_window(&app);

    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
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

    crate::hide_pill_window(&app);

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
pub fn update_session_environment(
    app: AppHandle,
    session_id: String,
    environment_id: Option<String>,
) -> Result<(), String> {
    let sm = app.state::<Arc<SessionManager>>();
    sm.update_session_environment(&session_id, environment_id.as_deref())
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

// ==================== Attachment Commands ====================

#[tauri::command]
#[specta::specta]
pub fn add_attachment(
    app: AppHandle,
    session_id: String,
    source_path: String,
    filename: String,
    mime_type: String,
) -> Result<Attachment, String> {
    let sm = app.state::<Arc<SessionManager>>();
    sm.add_attachment(&session_id, &source_path, &filename, &mime_type)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn get_attachments(app: AppHandle, session_id: String) -> Result<Vec<Attachment>, String> {
    let sm = app.state::<Arc<SessionManager>>();
    sm.get_attachments(&session_id).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn get_attachment(app: AppHandle, attachment_id: String) -> Result<Option<Attachment>, String> {
    let sm = app.state::<Arc<SessionManager>>();
    sm.get_attachment(&attachment_id).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn delete_attachment(app: AppHandle, attachment_id: String) -> Result<(), String> {
    let sm = app.state::<Arc<SessionManager>>();
    sm.delete_attachment(&attachment_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn open_attachment(app: AppHandle, attachment_id: String) -> Result<(), String> {
    let sm = app.state::<Arc<SessionManager>>();
    let attachment = sm
        .get_attachment(&attachment_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Attachment not found".to_string())?;

    // Open file in default application
    tauri_plugin_opener::open_path(&attachment.file_path, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn extract_pdf_text(app: AppHandle, attachment_id: String) -> Result<String, String> {
    let sm = app.state::<Arc<SessionManager>>();
    let attachment = sm
        .get_attachment(&attachment_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Attachment not found".to_string())?;

    if attachment.mime_type != "application/pdf" {
        return Err("Attachment is not a PDF".to_string());
    }

    // Extract text from PDF
    let text = pdf_extract::extract_text(&attachment.file_path)
        .map_err(|e| format!("Failed to extract PDF text: {}", e))?;

    // Limit text to reasonable size (200 pages worth, roughly 500KB)
    let max_chars = 500_000;
    let text = if text.len() > max_chars {
        log::warn!(
            "[pdf-extract] Truncating PDF text from {} to {} chars",
            text.len(),
            max_chars
        );
        text[..max_chars].to_string()
    } else {
        text
    };

    // Save extracted text to database
    sm.update_attachment_extracted_text(&attachment_id, Some(&text))
        .map_err(|e| e.to_string())?;

    log::info!(
        "[pdf-extract] Extracted {} chars from {}",
        text.len(),
        attachment.filename
    );

    Ok(text)
}

