use log::{info, warn};
use tauri::{AppHandle, Emitter};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

/// Validates that a shortcut string is acceptable.
/// Rejects modifier-only combos and bare function keys below F13.
fn validate_shortcut(shortcut: &str) -> Result<(), String> {
    let parts: Vec<&str> = shortcut.split('+').map(|s| s.trim()).collect();

    let modifiers = ["Ctrl", "Alt", "Shift", "Super", "Command", "Option"];
    let has_non_modifier = parts.iter().any(|p| !modifiers.contains(p));

    if !has_non_modifier {
        return Err("Shortcut must include a non-modifier key".to_string());
    }

    // Reject bare low function keys (F1-F12) without modifiers as they conflict with system
    if parts.len() == 1 {
        let key = parts[0].to_uppercase();
        if let Some(stripped) = key.strip_prefix('F') {
            if let Ok(n) = stripped.parse::<u32>() {
                if n <= 12 {
                    return Err(format!(
                        "F{} without modifiers may conflict with system shortcuts",
                        n
                    ));
                }
            }
        }
    }

    Ok(())
}

/// Registers a global shortcut that creates a new note and shows the main window.
pub fn register_new_recording_shortcut(app: &AppHandle, shortcut_str: &str) -> Result<(), String> {
    validate_shortcut(shortcut_str)?;

    let shortcut: tauri_plugin_global_shortcut::Shortcut = shortcut_str
        .parse()
        .map_err(|e| format!("Invalid shortcut '{}': {}", shortcut_str, e))?;

    let app_clone = app.clone();
    app.global_shortcut()
        .on_shortcut(shortcut, move |_app, _shortcut, event| {
            if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                info!("Global shortcut pressed: new recording");
                let _ = app_clone.emit("tray-new-note", ());
                crate::show_main_window(&app_clone);
            }
        })
        .map_err(|e| format!("Failed to register shortcut '{}': {}", shortcut_str, e))?;

    info!("Registered global shortcut: {}", shortcut_str);
    Ok(())
}

/// Unregisters all global shortcuts.
pub fn unregister_all_shortcuts(app: &AppHandle) -> Result<(), String> {
    app.global_shortcut()
        .unregister_all()
        .map_err(|e| format!("Failed to unregister shortcuts: {}", e))?;

    info!("Unregistered all global shortcuts");
    Ok(())
}

/// Initializes the global shortcut from saved settings (called at startup).
pub fn init_from_settings(app: &AppHandle) {
    let settings = crate::settings::get_settings(app);
    if let Some(ref shortcut_str) = settings.new_recording_shortcut {
        if let Err(e) = register_new_recording_shortcut(app, shortcut_str) {
            warn!(
                "Failed to register saved shortcut '{}': {}",
                shortcut_str, e
            );
        }
    }
}
