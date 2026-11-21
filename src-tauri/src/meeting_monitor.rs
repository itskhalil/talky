//! Background meeting monitor for macOS.
//! Polls CoreAudio every 2 seconds to detect when known meeting apps start or
//! stop using the microphone, emitting `"meeting-started"` / `"meeting-ended"`.

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

use crate::{meeting_title, mic_detect, settings};

const POLL_INTERVAL: Duration = Duration::from_secs(2);
const GRACE_PERIOD: Duration = Duration::from_secs(2);

/// The call window can show up a moment after the mic starts; retry the
/// title lookup a few times before giving up.
const TITLE_ATTEMPTS: u32 = 3;
const TITLE_RETRY_DELAY: Duration = Duration::from_millis(1500);

#[derive(Debug, Clone, Serialize)]
pub struct MeetingStartedPayload {
    /// Friendly app name, e.g. "Teams".
    pub app_name: String,
    /// Meeting name read from the app's windows, if detection is enabled
    /// and a meeting window was found.
    pub title: Option<String>,
}

fn name_detection_enabled(app: &AppHandle) -> bool {
    settings::get_settings(app).meeting_name_detection
}

/// Best-effort meeting name for a new note: apps using the mic first, then
/// any running meeting app with a recognisable meeting window.
pub fn current_meeting_title(app: &AppHandle) -> Option<String> {
    if !name_detection_enabled(app) {
        return None;
    }
    let mut ids: Vec<String> = mic_detect::filter_meeting_apps(&mic_detect::get_mic_using_apps())
        .into_iter()
        .collect();
    for id in meeting_title::running_bundle_ids() {
        if mic_detect::is_meeting_app(&id) && !ids.contains(&id) {
            ids.push(id);
        }
    }
    meeting_title::detect_any(ids.iter().map(String::as_str)).map(|(_, title)| title)
}

/// Emit `meeting-started` for `bundle_id`, looking up the meeting name first
/// (off the monitor thread, since it may wait for the call window).
fn emit_meeting_started(app: &AppHandle, bundle_id: &str) {
    let app = app.clone();
    let bundle_id = bundle_id.to_string();
    std::thread::spawn(move || {
        let mut title = None;
        if name_detection_enabled(&app) {
            for attempt in 0..TITLE_ATTEMPTS {
                if attempt > 0 {
                    std::thread::sleep(TITLE_RETRY_DELAY);
                }
                title = meeting_title::detect(&bundle_id);
                if title.is_some() {
                    break;
                }
            }
        }
        let app_name = mic_detect::app_name(&bundle_id).to_string();
        log::info!(
            "{} meeting started (title {})",
            app_name,
            if title.is_some() {
                "found"
            } else {
                "not found"
            }
        );
        let _ = app.emit("meeting-started", MeetingStartedPayload { app_name, title });
    });
}

pub fn start_monitoring(app: AppHandle) {
    std::thread::spawn(move || {
        let mut known: HashSet<String> =
            mic_detect::filter_meeting_apps(&mic_detect::get_mic_using_apps());
        let mut pending: HashMap<String, Instant> = HashMap::new();

        if !known.is_empty() {
            log::info!("Meeting monitor started; active: {:?}", known);
        } else {
            log::info!("Meeting monitor started");
        }

        loop {
            std::thread::sleep(POLL_INTERVAL);

            let current = mic_detect::filter_meeting_apps(&mic_detect::get_mic_using_apps());

            // New apps: emit meeting-started immediately
            for id in current.difference(&known) {
                pending.remove(id); // cancel any pending disappearance
                log::info!("{} started using microphone", mic_detect::app_name(id));
                emit_meeting_started(&app, id);
            }
            known.extend(current.iter().cloned());

            // Gone apps: start grace period
            for id in known.difference(&current).cloned().collect::<Vec<_>>() {
                pending.entry(id).or_insert_with(Instant::now);
            }

            // Reappeared: cancel grace period
            for id in &current {
                pending.remove(id);
            }

            // Expired grace periods: emit meeting-ended
            let expired: Vec<String> = pending
                .iter()
                .filter(|(_, t)| t.elapsed() >= GRACE_PERIOD)
                .map(|(id, _)| id.clone())
                .collect();

            for id in expired {
                pending.remove(&id);
                known.remove(&id);
                let name = mic_detect::app_name(&id);
                log::info!("{} stopped using microphone", name);
                let _ = app.emit("meeting-ended", name);
            }
        }
    });
}
