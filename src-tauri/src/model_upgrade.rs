//! One-time offer to move existing users from Parakeet v3 to Ultra, which
//! makes about a quarter fewer mistakes on meeting audio. The user accepts
//! from a toast; the download runs in the background, and Talky switches the
//! first time it's safe: when the download finishes, when a recording stops,
//! or at the next launch. People often accept just before a meeting, so the
//! switch can't depend on the window that showed the offer still being open.

use crate::error_events::{self, ErrorKind};
use crate::managers::audio::AudioRecordingManager;
use crate::managers::model::{ModelManager, ONNX_MODEL_ID, ONNX_ULTRA_MODEL_ID};
#[cfg(target_os = "macos")]
use crate::managers::model::{CORE_ML_MODEL_ID, CORE_ML_ULTRA_MODEL_ID};
use crate::managers::transcription::TranscriptionManager;
use crate::settings::{get_settings, write_settings, AppSettings};
use log::{info, warn};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

/// Set on a launch that already shows another model notice (the v0.13
/// Core ML migration), so the two don't stack.
static SUPPRESSED: AtomicBool = AtomicBool::new(false);

pub fn suppress_offer_this_launch() {
    SUPPRESSED.store(true, Ordering::Relaxed);
}

/// Ultra on the same engine as `selected`. A Mac user on ONNX moved off
/// Core ML deliberately, so they're offered ONNX Ultra.
fn upgrade_for(selected: &str) -> Option<&'static str> {
    #[cfg(target_os = "macos")]
    if selected == CORE_ML_MODEL_ID {
        return Some(CORE_ML_ULTRA_MODEL_ID);
    }
    (selected == ONNX_MODEL_ID).then_some(ONNX_ULTRA_MODEL_ID)
}

fn offer_for(settings: &AppSettings, suppressed: bool) -> Option<&'static str> {
    if suppressed || settings.model_upgrade_offered || settings.model_upgrade_target.is_some() {
        return None;
    }
    upgrade_for(&settings.selected_model)
}

/// The model to offer this user, if any.
pub fn offer(settings: &AppSettings) -> Option<&'static str> {
    offer_for(settings, SUPPRESSED.load(Ordering::Relaxed))
}

/// Record the user's answer. Accepting starts the download.
pub fn answer(app: &AppHandle, accept: bool) {
    let mut settings = get_settings(app);
    let Some(target) = offer(&settings) else {
        return;
    };
    settings.model_upgrade_offered = true;
    if accept {
        settings.model_upgrade_target = Some(target.to_string());
    }
    write_settings(app, settings);
    if accept {
        info!("Model upgrade accepted: {}", target);
        resume(app.clone());
    }
}

/// Download the accepted upgrade if needed, then switch to it. Called on
/// accept and at launch, which also resumes a download cut off by quitting.
pub fn resume(app: AppHandle) {
    let Some(target) = get_settings(&app).model_upgrade_target else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        let manager = app.state::<Arc<ModelManager>>().inner().clone();
        if let Err(e) = manager.download_model(&target).await {
            warn!("Model upgrade download failed: {}", e);
            // Offer it again next launch rather than spend the one ask.
            let mut settings = get_settings(&app);
            settings.model_upgrade_target = None;
            settings.model_upgrade_offered = false;
            write_settings(&app, settings);
            error_events::record(
                &app,
                ErrorKind::ModelLoadFailed,
                "Couldn't download the more accurate model",
                e.to_string(),
            );
            return;
        }
        apply_pending(&app);
    });
}

/// Switch to the accepted upgrade if it's downloaded and nothing is
/// recording; otherwise leave it for the next chance.
pub fn apply_pending(app: &AppHandle) {
    let Some(target) = get_settings(app).model_upgrade_target else {
        return;
    };
    if app.state::<Arc<AudioRecordingManager>>().is_recording() {
        return;
    }
    let downloaded = app
        .state::<Arc<ModelManager>>()
        .get_model_info(&target)
        .is_some_and(|m| m.is_downloaded);
    if !downloaded {
        return;
    }

    // Switch the setting and drop the old model rather than loading the new
    // one here: the next recording loads it the way it loads any model, so
    // this can't race a recording that starts during a long first load
    // (Core ML compiles Ultra on first use).
    let mut settings = get_settings(app);
    settings.selected_model = target.clone();
    settings.model_upgrade_target = None;
    write_settings(app, settings);
    let transcription = app.state::<Arc<TranscriptionManager>>();
    if transcription.is_model_loaded() {
        if let Err(e) = transcription.unload_model() {
            warn!("Couldn't unload the previous model: {}", e);
        }
    }
    info!("Switched to {}", target);
    let _ = app.emit("model-upgrade-applied", &target);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::get_default_settings;

    fn on(model: &str) -> AppSettings {
        AppSettings {
            selected_model: model.to_string(),
            model_upgrade_offered: false,
            ..get_default_settings()
        }
    }

    #[test]
    fn offers_ultra_on_the_same_engine_once() {
        assert_eq!(
            offer_for(&on(ONNX_MODEL_ID), false),
            Some(ONNX_ULTRA_MODEL_ID)
        );
        #[cfg(target_os = "macos")]
        assert_eq!(
            offer_for(&on(CORE_ML_MODEL_ID), false),
            Some(CORE_ML_ULTRA_MODEL_ID)
        );

        // Already on Ultra, or still onboarding.
        assert_eq!(offer_for(&on(ONNX_ULTRA_MODEL_ID), false), None);
        assert_eq!(offer_for(&on(""), false), None);

        // Answered, accepted and in progress, or another notice this launch.
        let answered = AppSettings {
            model_upgrade_offered: true,
            ..on(ONNX_MODEL_ID)
        };
        assert_eq!(offer_for(&answered, false), None);
        let pending = AppSettings {
            model_upgrade_target: Some(ONNX_ULTRA_MODEL_ID.to_string()),
            ..on(ONNX_MODEL_ID)
        };
        assert_eq!(offer_for(&pending, false), None);
        assert_eq!(offer_for(&on(ONNX_MODEL_ID), true), None);
    }

    #[test]
    fn fresh_installs_are_not_offered_but_existing_settings_are() {
        assert!(get_default_settings().model_upgrade_offered);
        let mut existing = serde_json::to_value(get_default_settings()).unwrap();
        existing
            .as_object_mut()
            .unwrap()
            .remove("model_upgrade_offered");
        let existing: AppSettings = serde_json::from_value(existing).unwrap();
        assert!(!existing.model_upgrade_offered);
    }
}
