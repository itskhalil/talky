use crate::managers::audio::AudioRecordingManager;
use crate::managers::transcription::TranscriptionManager;
use log::{info, warn};
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::{AppHandle, Manager};

use tauri::Emitter;

pub use crate::tray::update_tray_menu;

/// Extension trait for `std::sync::Mutex` that recovers from poisoned state.
///
/// When a thread panics while holding a mutex, the mutex becomes "poisoned".
/// Using `.lock().unwrap()` would panic in this case, potentially crashing the app.
/// This trait provides `lock_or_recover()` which logs a warning and recovers the
/// inner data, allowing the application to continue operating.
pub trait MutexExt<T> {
    /// Locks the mutex, recovering from poisoned state if necessary.
    ///
    /// If the mutex was poisoned (a thread panicked while holding it),
    /// this logs a warning and returns the inner data anyway. This is
    /// safe because we're choosing to continue despite the potential
    /// inconsistent state.
    fn lock_or_recover(&self) -> MutexGuard<'_, T>;
}

impl<T> MutexExt<T> for Mutex<T> {
    fn lock_or_recover(&self) -> MutexGuard<'_, T> {
        match self.lock() {
            Ok(guard) => guard,
            Err(poisoned) => {
                warn!("Mutex was poisoned, recovering inner data");
                poisoned.into_inner()
            }
        }
    }
}

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
