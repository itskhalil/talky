pub mod audio;
pub mod export;
pub mod history;
pub mod models;
pub mod session;
pub mod settings;
pub mod transcription;

use crate::error_events::{self, ErrorKind, UserVisibleError};
use crate::settings::{get_settings, write_settings, AppSettings, LogLevel};
use crate::utils::cancel_current_operation;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
#[specta::specta]
pub fn cancel_operation(app: AppHandle) {
    cancel_current_operation(&app);
}

#[tauri::command]
#[specta::specta]
pub fn get_app_dir_path(app: AppHandle) -> Result<String, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    Ok(app_data_dir.to_string_lossy().to_string())
}

#[tauri::command]
#[specta::specta]
pub fn get_app_settings(app: AppHandle) -> Result<AppSettings, String> {
    Ok(get_settings(&app))
}

#[tauri::command]
#[specta::specta]
pub fn get_default_settings() -> Result<AppSettings, String> {
    Ok(crate::settings::get_default_settings())
}

#[tauri::command]
#[specta::specta]
pub fn write_chat_debug_log(app: AppHandle, lines: Vec<String>) -> Result<(), String> {
    use std::io::Write;
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("Failed to get log directory: {}", e))?;
    let path = log_dir.join("chat-debug.log");
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("Failed to open chat log: {}", e))?;
    for line in &lines {
        writeln!(file, "{}", line).map_err(|e| format!("Failed to write: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn get_log_dir_path(app: AppHandle) -> Result<String, String> {
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("Failed to get log directory: {}", e))?;

    Ok(log_dir.to_string_lossy().to_string())
}

#[specta::specta]
#[tauri::command]
pub fn set_log_level(app: AppHandle, level: LogLevel) -> Result<(), String> {
    let tauri_log_level: tauri_plugin_log::LogLevel = level.into();
    let log_level: log::Level = tauri_log_level.into();
    // Update the file log level atomic so the filter picks up the new level
    crate::FILE_LOG_LEVEL.store(
        log_level.to_level_filter() as u8,
        std::sync::atomic::Ordering::Relaxed,
    );

    let mut settings = get_settings(&app);
    settings.log_level = level;
    write_settings(&app, settings);

    Ok(())
}

#[specta::specta]
#[tauri::command]
pub fn open_log_dir(app: AppHandle) -> Result<(), String> {
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("Failed to get log directory: {}", e))?;

    let path = log_dir.to_string_lossy().as_ref().to_string();
    app.opener()
        .open_path(path, None::<String>)
        .map_err(|e| format!("Failed to open log directory: {}", e))?;

    Ok(())
}

#[specta::specta]
#[tauri::command]
pub fn open_app_data_dir(app: AppHandle) -> Result<(), String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    let path = app_data_dir.to_string_lossy().as_ref().to_string();
    app.opener()
        .open_path(path, None::<String>)
        .map_err(|e| format!("Failed to open app data directory: {}", e))?;

    Ok(())
}

/// Check if Ollama is running and available at the given base URL.
/// Returns the list of installed model names if available, empty vec if not running.
#[specta::specta]
#[tauri::command]
pub async fn check_ollama_available(base_url: Option<String>) -> Vec<String> {
    let base = base_url
        .unwrap_or_else(|| "http://localhost:11434".to_string())
        .trim_end_matches('/')
        .trim_end_matches("/v1")
        .to_string();

    let url = format!("{}/api/tags", base);

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
    {
        Ok(c) => c,
        Err(_) => return vec![],
    };

    let response = match client.get(&url).send().await {
        Ok(r) if r.status().is_success() => r,
        _ => return vec![],
    };

    // Parse Ollama's response: { "models": [ { "name": "llama3.1:8b", ... }, ... ] }
    let parsed: serde_json::Value = match response.json().await {
        Ok(v) => v,
        Err(_) => return vec![],
    };

    let mut models = Vec::new();
    if let Some(model_list) = parsed.get("models").and_then(|m| m.as_array()) {
        for model in model_list {
            if let Some(name) = model.get("name").and_then(|n| n.as_str()) {
                models.push(name.to_string());
            }
        }
    }

    models
}

/// Get the current user data directory path.
/// Returns the custom path if set, otherwise the default app data directory.
#[specta::specta]
#[tauri::command]
pub fn get_user_data_directory(app: AppHandle) -> Result<String, String> {
    let settings = get_settings(&app);

    if let Some(custom_dir) = &settings.data_directory {
        Ok(custom_dir.clone())
    } else {
        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("Failed to get app data directory: {}", e))?;
        Ok(app_data_dir.to_string_lossy().to_string())
    }
}

/// Check if a custom data directory is configured.
#[specta::specta]
#[tauri::command]
pub fn has_custom_data_directory(app: AppHandle) -> bool {
    let settings = get_settings(&app);
    settings.data_directory.is_some()
}

/// Set a new data directory and optionally migrate existing data.
/// Returns true if migration was successful, false if the directory couldn't be used.
/// After calling this, the app should be restarted for changes to take effect.
#[specta::specta]
#[tauri::command]
pub fn set_data_directory(
    app: AppHandle,
    new_path: Option<String>,
    migrate_data: bool,
) -> Result<(), String> {
    let current_settings = get_settings(&app);
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    // Determine source directory (current data location)
    let source_dir = current_settings
        .data_directory
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or_else(|| app_data_dir.clone());

    // Determine target directory
    let target_dir = new_path
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or_else(|| app_data_dir.clone());

    // Validate the target directory
    if let Some(ref path) = new_path {
        let target = PathBuf::from(path);
        // Check if we can write to this directory
        if !target.exists() {
            std::fs::create_dir_all(&target)
                .map_err(|e| format!("Failed to create directory: {}", e))?;
        }

        // Test write permission
        let test_file = target.join(".talky_test");
        std::fs::write(&test_file, "test")
            .map_err(|e| format!("Cannot write to directory: {}", e))?;
        std::fs::remove_file(&test_file).ok();
    }

    // Migrate data if requested
    if migrate_data && source_dir != target_dir {
        // Copy sessions.db
        let source_sessions = source_dir.join("sessions.db");
        let target_sessions = target_dir.join("sessions.db");
        if source_sessions.exists() && !target_sessions.exists() {
            std::fs::copy(&source_sessions, &target_sessions)
                .map_err(|e| format!("Failed to copy sessions.db: {}", e))?;
            log::info!(
                "Migrated sessions.db from {:?} to {:?}",
                source_sessions,
                target_sessions
            );
        }

        // Copy history.db
        let source_history = source_dir.join("history.db");
        let target_history = target_dir.join("history.db");
        if source_history.exists() && !target_history.exists() {
            std::fs::copy(&source_history, &target_history)
                .map_err(|e| format!("Failed to copy history.db: {}", e))?;
            log::info!(
                "Migrated history.db from {:?} to {:?}",
                source_history,
                target_history
            );
        }

        // Also copy WAL files if they exist (for SQLite)
        for wal_ext in &["-wal", "-shm"] {
            let source_sessions_wal = source_dir.join(format!("sessions.db{}", wal_ext));
            let target_sessions_wal = target_dir.join(format!("sessions.db{}", wal_ext));
            if source_sessions_wal.exists() {
                std::fs::copy(&source_sessions_wal, &target_sessions_wal).ok();
            }

            let source_history_wal = source_dir.join(format!("history.db{}", wal_ext));
            let target_history_wal = target_dir.join(format!("history.db{}", wal_ext));
            if source_history_wal.exists() {
                std::fs::copy(&source_history_wal, &target_history_wal).ok();
            }
        }
    }

    // Update settings
    let mut settings = current_settings;
    settings.data_directory = new_path;
    write_settings(&app, settings);

    log::info!("Data directory updated. App restart required.");
    Ok(())
}

/// Read and clear `pending_promotion`. Frontend calls this on mount: if the
/// previous `setup()` promoted `selected_model` to the Core ML id, this
/// returns true once and false thereafter. Decouples the banner from an
/// unreliable startup event emit.
#[specta::specta]
#[tauri::command]
pub fn consume_pending_promotion(app: AppHandle) -> bool {
    let mut settings = get_settings(&app);
    if settings.pending_promotion {
        settings.pending_promotion = false;
        write_settings(&app, settings);
        true
    } else {
        false
    }
}

/// List all stored error events, newest first. Drives the Recent Events
/// settings section.
#[specta::specta]
#[tauri::command]
pub fn list_error_events(app: AppHandle) -> Vec<UserVisibleError> {
    error_events::list(&app)
}

/// Mark a specific error event as dismissed. Its banner won't show again; the
/// Recent Events list still retains the entry.
#[specta::specta]
#[tauri::command]
pub fn dismiss_error_event(app: AppHandle, id: String) {
    error_events::dismiss(&app, &id);
}

/// Wipe every stored error event.
#[specta::specta]
#[tauri::command]
pub fn clear_error_events(app: AppHandle) {
    error_events::clear(&app);
}

/// Reveal `talky.log` in Finder (selected, not just the folder) and open a
/// pre-filled mailto. The user attaches the log file themselves from the
/// Finder window — mailto body limits on macOS are flaky, so we don't try to
/// embed log contents.
#[specta::specta]
#[tauri::command]
pub fn send_logs_to_developer(app: AppHandle, error_kind: Option<ErrorKind>) -> Result<(), String> {
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("Failed to resolve log directory: {}", e))?;
    let log_file = log_dir.join("talky.log");

    // Reveal with `open -R` so the log is selected. tauri-plugin-opener's
    // open_path only opens the parent dir.
    if log_file.exists() {
        if let Err(e) = std::process::Command::new("open")
            .args(["-R", &log_file.to_string_lossy()])
            .spawn()
        {
            log::warn!("Failed to reveal log in Finder: {}", e);
        }
    } else {
        log::warn!("talky.log does not exist at {:?}", log_file);
    }

    let version = app.package_info().version.to_string();
    let subject_tag = match error_kind {
        Some(ErrorKind::NativeCrash) => "Talky crash — native",
        Some(ErrorKind::SidecarCrashed) => "Talky crash — Core ML sidecar",
        Some(ErrorKind::ModelLoadFailed) => "Talky — model load failure",
        None => "Talky logs",
    };
    let subject = format!("{} — v{}", subject_tag, version);
    let body =
        "Please attach the talky.log file from the Finder window that just opened.\n\nShort description of what happened:\n";

    let mailto = format!(
        "mailto:{}?subject={}&body={}",
        env!("TALKY_SUPPORT_EMAIL"),
        percent_encode_mailto_component(&subject),
        percent_encode_mailto_component(body)
    );

    app.opener()
        .open_url(mailto, None::<String>)
        .map_err(|e| format!("Failed to open mail client: {}", e))?;

    Ok(())
}

/// Percent-encode an RFC 6068 mailto component (subject / body). Unreserved
/// characters pass through; everything else becomes `%XX`.
fn percent_encode_mailto_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => {
                out.push_str(&format!("%{:02X}", b));
            }
        }
    }
    out
}

/// Open the current user data directory in Finder/Explorer.
#[specta::specta]
#[tauri::command]
pub fn open_user_data_directory(app: AppHandle) -> Result<(), String> {
    let settings = get_settings(&app);

    let path = if let Some(custom_dir) = &settings.data_directory {
        custom_dir.clone()
    } else {
        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("Failed to get app data directory: {}", e))?;
        app_data_dir.to_string_lossy().to_string()
    };

    app.opener()
        .open_path(path, None::<String>)
        .map_err(|e| format!("Failed to open data directory: {}", e))?;

    Ok(())
}
