//! Background meeting monitor for macOS.
//! Polls CoreAudio every 2 seconds to detect when known meeting apps start or
//! stop using the microphone, emitting `"meeting-started"` / `"meeting-ended"`.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

use crate::mic_detect;

const POLL_INTERVAL: Duration = Duration::from_secs(2);
const GRACE_PERIOD: Duration = Duration::from_secs(2);

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
                let name = mic_detect::app_name(id);
                log::info!("{} started using microphone", name);
                let _ = app.emit("meeting-started", name);
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
