use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Default, Serialize, Deserialize, Clone, Type)]
pub struct Memory {
    pub content: String,
    pub updated_at: i64,
    pub version: u32,
    pub source_sessions: Vec<String>,
}

fn memory_path(app: &AppHandle) -> Result<PathBuf, String> {
    let settings = crate::settings::get_settings(app);
    let data_dir = if let Some(custom_dir) = settings.data_directory {
        PathBuf::from(custom_dir)
    } else {
        app.path()
            .app_data_dir()
            .map_err(|e| format!("Failed to get app data dir: {}", e))?
    };
    Ok(data_dir.join("memory.json"))
}

/// Load the current memory document, or return a default empty one.
pub fn load_memory(app: &AppHandle) -> Result<Memory, String> {
    let path = memory_path(app)?;
    if !path.exists() {
        return Ok(Memory::default());
    }
    let data =
        std::fs::read_to_string(&path).map_err(|e| format!("Failed to read memory: {}", e))?;
    serde_json::from_str(&data).map_err(|e| format!("Failed to parse memory: {}", e))
}

/// Save the memory document to disk.
pub fn save_memory(app: &AppHandle, memory: &Memory) -> Result<(), String> {
    let path = memory_path(app)?;
    let data = serde_json::to_string_pretty(memory)
        .map_err(|e| format!("Failed to serialize memory: {}", e))?;
    std::fs::write(&path, data).map_err(|e| format!("Failed to write memory: {}", e))
}

/// Clear (delete) the memory document.
pub fn clear_memory(app: &AppHandle) -> Result<(), String> {
    let path = memory_path(app)?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("Failed to delete memory: {}", e))?;
    }
    Ok(())
}

const MEMORY_UPDATE_SYSTEM_PROMPT: &str = r###"You maintain a concise memory document for a meeting notes assistant. Given the current memory and a new meeting's enhanced notes, produce an updated memory document.

Rules:
- Keep it under 500 words. Prioritize what's actionable and ongoing.
- Use three sections: "## About you", "## People", "## Active threads"
- About you: the user's role, priorities, working style. Only update when you observe a clear new pattern.
- People: name, role, relationship, key recent context. Drop people who haven't appeared recently unless they're central to active threads.
- Active threads: what's happening, what's decided, what's open. Remove threads that are clearly resolved. Update existing threads with new information rather than creating duplicates.
- Write in the third person about the user (e.g. "Khalil cares about X"), not in the second person.
- Be terse. Use fragments, not full sentences. This is a reference document, not prose.
- Preserve existing information that's still relevant. Merge new information into existing entries rather than appending.

Output ONLY the updated memory document, starting with "## About you". No preamble, no explanation."###;

/// Spawn a background task to update the memory document after enhance_notes completes.
/// This runs asynchronously and does not block the UI.
pub fn spawn_memory_update(
    app: AppHandle,
    session_id: String,
    session_title: String,
    enhanced_notes: String,
) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) =
            update_memory_async(&app, &session_id, &session_title, &enhanced_notes).await
        {
            log::error!("[memory] Failed to update memory: {}", e);
        }
    });
}

async fn update_memory_async(
    app: &AppHandle,
    session_id: &str,
    session_title: &str,
    enhanced_notes: &str,
) -> Result<(), String> {
    let settings = crate::settings::get_settings(app);

    if !settings.memory_enabled {
        log::debug!("[memory] Memory disabled in settings, skipping update");
        return Ok(());
    }

    // Get the summarisation config for the LLM call
    let (base_url, api_key, model) = settings
        .get_summarisation_config(None)
        .ok_or_else(|| "No summarisation model configured for memory update".to_string())?;

    let current_memory = load_memory(app)?;

    let current_content = if current_memory.content.is_empty() {
        "(No existing memory — this is the first meeting)".to_string()
    } else {
        current_memory.content.clone()
    };

    let user_message = format!(
        "<current_memory>\n{}\n</current_memory>\n\n<meeting_title>{}</meeting_title>\n\n<enhanced_notes>\n{}\n</enhanced_notes>\n\nProduce the updated memory document.",
        current_content, session_title, enhanced_notes
    );

    let messages = vec![
        crate::llm_client::ChatMessage::text("system", MEMORY_UPDATE_SYSTEM_PROMPT),
        crate::llm_client::ChatMessage::text("user", user_message),
    ];

    log::info!(
        "[memory] Updating memory after session '{}' ({})",
        session_title,
        session_id
    );

    let result = crate::llm_client::send_chat_completion(&base_url, &api_key, &model, messages)
        .await?
        .ok_or_else(|| "LLM returned no content for memory update".to_string())?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    let mut source_sessions = current_memory.source_sessions;
    if !source_sessions.contains(&session_id.to_string()) {
        source_sessions.push(session_id.to_string());
    }

    let updated = Memory {
        content: result.trim().to_string(),
        updated_at: now,
        version: current_memory.version + 1,
        source_sessions,
    };

    save_memory(app, &updated)?;

    log::info!(
        "[memory] Memory updated to v{} ({} chars, {} sessions)",
        updated.version,
        updated.content.len(),
        updated.source_sessions.len()
    );

    Ok(())
}
