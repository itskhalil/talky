use crate::managers::session::SessionManager;
use chrono::{Local, TimeZone};
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::sync::Arc;
use tauri::State;

/// Characters invalid for filenames on Windows/macOS/Linux
fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect()
}

/// Strip [ai] and [noted] tags from notes content
fn strip_tags(content: &str) -> String {
    content
        .lines()
        .map(|line| {
            line.trim_start_matches("[ai]")
                .trim_start_matches("[noted]")
                .trim_start()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Format milliseconds as HH:MM
fn format_timestamp(ms: i64) -> String {
    let total_seconds = ms / 1000;
    let hours = total_seconds / 3600;
    let minutes = (total_seconds % 3600) / 60;
    format!("{:02}:{:02}", hours, minutes)
}

/// Generate markdown content for a session with configurable sections
fn generate_markdown(
    session_manager: &SessionManager,
    session_id: &str,
    include_notes: bool,
    include_enhanced: bool,
    include_transcript: bool,
) -> Result<String, String> {
    let session = session_manager
        .get_session(session_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Session not found: {}", session_id))?;

    let tags = session_manager
        .get_session_tags(session_id)
        .map_err(|e| e.to_string())?;

    let notes = session_manager
        .get_meeting_notes(session_id)
        .map_err(|e| e.to_string())?;

    let mut md = String::new();

    // Title
    md.push_str(&format!("# {}\n\n", session.title));

    // Metadata
    let date = Local
        .timestamp_opt(session.started_at, 0)
        .single()
        .map(|dt| dt.format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_else(|| "Unknown".to_string());

    md.push_str(&format!("**Date:** {}\n", date));

    if !tags.is_empty() {
        let tag_names: Vec<_> = tags.iter().map(|t| t.name.as_str()).collect();
        md.push_str(&format!("**Tags:** {}\n", tag_names.join(", ")));
    }

    md.push_str("\n---\n\n");

    // Determine which notes sections are actually available
    let has_user_notes = notes
        .as_ref()
        .and_then(|n| n.user_notes.as_ref())
        .map(|c| !c.trim().is_empty())
        .unwrap_or(false);
    let has_enhanced_notes = notes
        .as_ref()
        .and_then(|n| n.enhanced_notes.as_ref())
        .map(|c| !strip_tags(c).trim().is_empty())
        .unwrap_or(false);

    // Count how many notes sections will actually be included
    let notes_section_count =
        (include_notes && has_user_notes) as u8 + (include_enhanced && has_enhanced_notes) as u8;

    // Notes section
    if include_notes && has_user_notes {
        if let Some(ref meeting_notes) = notes {
            if let Some(ref content) = meeting_notes.user_notes {
                let stripped = strip_tags(content);
                if !stripped.trim().is_empty() {
                    let heading = if notes_section_count > 1 {
                        "## Notes\n\n"
                    } else {
                        "## Notes\n\n"
                    };
                    md.push_str(heading);
                    md.push_str(&stripped);
                    md.push_str("\n\n");
                }
            }
        }
    }

    // Enhanced Notes section
    if include_enhanced && has_enhanced_notes {
        if let Some(ref meeting_notes) = notes {
            if let Some(ref content) = meeting_notes.enhanced_notes {
                let stripped = strip_tags(content);
                if !stripped.trim().is_empty() {
                    let heading = if notes_section_count > 1 {
                        "## Enhanced Notes\n\n"
                    } else {
                        "## Notes\n\n"
                    };
                    md.push_str(heading);
                    md.push_str(&stripped);
                    md.push_str("\n\n");
                }
            }
        }
    }

    // Transcript section
    if include_transcript {
        let segments = session_manager
            .get_session_transcript(session_id)
            .map_err(|e| e.to_string())?;

        if !segments.is_empty() {
            md.push_str("## Transcript\n\n");
            for segment in &segments {
                let timestamp = format_timestamp(segment.start_ms);
                let label = if segment.source == "mic" {
                    "[You]"
                } else {
                    "[Other]"
                };
                md.push_str(&format!(
                    "[{}] {}: {}\n\n",
                    timestamp,
                    label,
                    segment.text.trim()
                ));
            }
        }
    }

    Ok(md)
}

#[tauri::command]
#[specta::specta]
pub async fn export_note_as_markdown(
    session_id: String,
    file_path: String,
    include_notes: bool,
    include_enhanced: bool,
    include_transcript: bool,
    session_manager: State<'_, Arc<SessionManager>>,
) -> Result<(), String> {
    let markdown = generate_markdown(
        &session_manager,
        &session_id,
        include_notes,
        include_enhanced,
        include_transcript,
    )?;

    fs::write(&file_path, markdown).map_err(|e| format!("Failed to write file: {}", e))?;

    log::info!("Exported note {} to {}", session_id, file_path);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn export_all_notes_as_markdown(
    directory_path: String,
    include_notes: bool,
    include_enhanced: bool,
    include_transcript: bool,
    session_manager: State<'_, Arc<SessionManager>>,
) -> Result<u32, String> {
    let sessions = session_manager.get_sessions().map_err(|e| e.to_string())?;

    if sessions.is_empty() {
        return Ok(0);
    }

    let dir_path = Path::new(&directory_path);
    if !dir_path.exists() {
        fs::create_dir_all(dir_path).map_err(|e| format!("Failed to create directory: {}", e))?;
    }

    let mut used_names: HashSet<String> = HashSet::new();
    let mut exported_count: u32 = 0;

    for session in sessions {
        // Generate filename: {YYYY-MM-DD} {Title}.md using local time
        let date_str = Local
            .timestamp_opt(session.started_at, 0)
            .single()
            .map(|dt| dt.format("%Y-%m-%d").to_string())
            .unwrap_or_else(|| "Unknown".to_string());

        let sanitized_title = sanitize_filename(&session.title);
        let base_name = format!("{} {}", date_str, sanitized_title);

        // Handle duplicate names by appending counter
        let mut final_name = base_name.clone();
        let mut counter = 2u32;
        while used_names.contains(&final_name.to_lowercase()) {
            final_name = format!("{} ({})", base_name, counter);
            counter += 1;
        }
        used_names.insert(final_name.to_lowercase());

        let file_path = dir_path.join(format!("{}.md", final_name));

        match generate_markdown(
            &session_manager,
            &session.id,
            include_notes,
            include_enhanced,
            include_transcript,
        ) {
            Ok(markdown) => {
                if let Err(e) = fs::write(&file_path, markdown) {
                    log::error!("Failed to export {}: {}", session.id, e);
                    continue;
                }
                exported_count += 1;
            }
            Err(e) => {
                log::error!("Failed to generate markdown for {}: {}", session.id, e);
                continue;
            }
        }
    }

    log::info!("Exported {} notes to {}", exported_count, directory_path);
    Ok(exported_count)
}
