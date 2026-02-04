//! Power event monitoring for macOS.
//! Listens for system sleep notifications and stops recording gracefully.

use std::ptr::NonNull;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

use crate::managers::audio::AudioRecordingManager;
use crate::managers::session::SessionManager;
use crate::tray;

/// Start monitoring for power events (system sleep/wake).
/// Spawns a background thread that listens for NSWorkspaceWillSleepNotification.
pub fn start_monitoring(app: AppHandle) {
    std::thread::spawn(move || {
        use block2::RcBlock;
        use objc2_app_kit::NSWorkspace;
        use objc2_foundation::{NSDate, NSNotification, NSRunLoop, NSString};

        // Get the shared workspace and its notification center
        let workspace = NSWorkspace::sharedWorkspace();
        let notification_center = workspace.notificationCenter();

        // NSWorkspaceWillSleepNotification - create from static string
        let notification_name = NSString::from_str("NSWorkspaceWillSleepNotification");

        // Clone app handle for the block
        let app_for_block = app.clone();

        // Create the observer block with correct signature
        // Spawn work on a separate thread to avoid blocking the notification callback
        let block = RcBlock::new(move |_notification: NonNull<NSNotification>| {
            let app_clone = app_for_block.clone();
            std::thread::spawn(move || {
                handle_will_sleep(&app_clone);
            });
        });

        // Register the observer
        unsafe {
            notification_center.addObserverForName_object_queue_usingBlock(
                Some(&notification_name),
                None,
                None,
                &block,
            );
        }

        log::info!("Power event monitoring started");

        // Run the run loop to receive notifications
        // This thread will run indefinitely
        loop {
            let run_loop = NSRunLoop::currentRunLoop();
            // Run until a future date (effectively forever per iteration)
            let distant_future = NSDate::distantFuture();
            run_loop.runUntilDate(&distant_future);
        }
    });
}

/// Handle the system will sleep notification.
/// Stops recording gracefully if active.
fn handle_will_sleep(app: &AppHandle) {
    let rm = app.state::<Arc<AudioRecordingManager>>();
    let sm = app.state::<Arc<SessionManager>>();

    if rm.is_recording() {
        log::info!("System will sleep - stopping recording");

        // Stop speaker capture first
        sm.stop_speaker_capture();

        // Stop mic recording (this preserves samples already captured)
        let _ = rm.stop_session_recording();

        // Update tray icon to idle state
        tray::change_tray_icon(app, tray::TrayIconState::Idle);
        tray::stop_recording_indicator(app);

        // Emit event to frontend so UI updates
        let _ = app.emit("system-will-sleep", ());
    }
}
