use crate::managers::audio::AudioRecordingManager;
use crate::managers::transcription::TranscriptionManager;
use log::info;
use std::sync::Arc;
use tauri::{AppHandle, Manager};

use tauri::Emitter;

pub use crate::tray::*;

pub fn emit_levels(app_handle: &AppHandle, levels: &Vec<f32>) {
    let _ = app_handle.emit("mic-level", levels);
}

/// Centralized cancellation function that can be called from anywhere in the app.
/// Handles cancelling both recording and transcription operations and updates UI state.
pub fn cancel_current_operation(app: &AppHandle) {
    info!("Initiating operation cancellation...");

    // Cancel any ongoing recording
    let audio_manager = app.state::<Arc<AudioRecordingManager>>();
    audio_manager.cancel_recording();

    // Update tray icon
    change_tray_icon(app, crate::tray::TrayIconState::Idle);
    stop_recording_indicator(app);

    // Unload model if immediate unload is enabled
    let tm = app.state::<Arc<TranscriptionManager>>();
    tm.maybe_unload_immediately("cancellation");

    info!("Operation cancellation completed - returned to idle state");
}

/// Check if using the Wayland display server protocol
#[cfg(target_os = "linux")]
pub fn is_wayland() -> bool {
    std::env::var("WAYLAND_DISPLAY").is_ok()
        || std::env::var("XDG_SESSION_TYPE")
            .map(|v| v.to_lowercase() == "wayland")
            .unwrap_or(false)
}
