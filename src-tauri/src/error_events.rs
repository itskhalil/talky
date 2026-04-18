//! User-visible error events.
//!
//! Talky has no telemetry. This module is the user-facing substitute: record
//! anything we'd want to hear about, show a banner, let the user ship us logs
//! via the Send-logs flow. Three sources wire in today (sidecar crashes,
//! native app crashes, model-load failures); more can plug in the same way.

use log::{debug, warn};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

const STORE_FILENAME: &str = "error_events.json";
const MAX_ENTRIES: usize = 50;
const MAX_AGE_DAYS: u64 = 30;

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    /// Full-app crash recovered from ~/Library/Logs/DiagnosticReports/.
    NativeCrash,
    /// Core ML sidecar died unexpectedly.
    SidecarCrashed,
    /// A transcription model failed to load.
    ModelLoadFailed,
}

#[derive(Serialize, Deserialize, Debug, Clone, Type)]
pub struct UserVisibleError {
    pub id: String,
    pub kind: ErrorKind,
    pub title: String,
    pub detail: String,
    pub timestamp_ms: u64,
    #[serde(default)]
    pub dismissed_at: Option<u64>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    // Always the default app data directory — never the user-configurable
    // `data_directory`, which may point at iCloud and shouldn't sync
    // machine-specific crash history.
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolving app_data_dir: {}", e))?;
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("creating app_data_dir: {}", e))?;
    }
    Ok(dir.join(STORE_FILENAME))
}

fn read_store(app: &AppHandle) -> Vec<UserVisibleError> {
    let path = match store_path(app) {
        Ok(p) => p,
        Err(e) => {
            warn!("error_events: {}", e);
            return Vec::new();
        }
    };
    match fs::read_to_string(&path) {
        Ok(s) if s.trim().is_empty() => Vec::new(),
        Ok(s) => serde_json::from_str(&s).unwrap_or_else(|e| {
            warn!("error_events: parse failed, starting fresh: {}", e);
            Vec::new()
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => {
            warn!("error_events: read failed: {}", e);
            Vec::new()
        }
    }
}

fn write_store(app: &AppHandle, entries: &[UserVisibleError]) {
    let path = match store_path(app) {
        Ok(p) => p,
        Err(e) => {
            warn!("error_events: {}", e);
            return;
        }
    };
    match serde_json::to_string_pretty(entries) {
        Ok(s) => {
            if let Err(e) = fs::write(&path, s) {
                warn!("error_events: write failed: {}", e);
            }
        }
        Err(e) => warn!("error_events: serialize failed: {}", e),
    }
}

fn housekeep(entries: &mut Vec<UserVisibleError>) {
    let cutoff = now_ms().saturating_sub(MAX_AGE_DAYS * 24 * 60 * 60 * 1000);
    entries.retain(|e| e.timestamp_ms >= cutoff);
    if entries.len() > MAX_ENTRIES {
        entries.sort_by(|a, b| b.timestamp_ms.cmp(&a.timestamp_ms));
        entries.truncate(MAX_ENTRIES);
    }
}

// Serialize writes so concurrent records don't race on the JSON file.
static STORE_LOCK: Mutex<()> = Mutex::new(());

/// Append a new error event. Emits `error-event-recorded` so the frontend
/// banner surfaces it. Safe to call from any thread.
pub fn record(
    app: &AppHandle,
    kind: ErrorKind,
    title: impl Into<String>,
    detail: impl Into<String>,
) {
    let entry = UserVisibleError {
        id: uuid::Uuid::new_v4().to_string(),
        kind,
        title: title.into(),
        detail: detail.into(),
        timestamp_ms: now_ms(),
        dismissed_at: None,
    };
    debug!("error_events: recording {:?} — {}", entry.kind, entry.title);
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut entries = read_store(app);
    entries.push(entry.clone());
    housekeep(&mut entries);
    write_store(app, &entries);
    drop(_guard);
    if let Err(e) = app.emit("error-event-recorded", &entry) {
        warn!("error_events: emit failed: {}", e);
    }
}

/// Return all stored error events, newest first.
pub fn list(app: &AppHandle) -> Vec<UserVisibleError> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut entries = read_store(app);
    entries.sort_by(|a, b| b.timestamp_ms.cmp(&a.timestamp_ms));
    entries
}

/// Mark a specific event as dismissed. The banner never shows it again on any
/// future launch; the Recent Events list still retains it.
pub fn dismiss(app: &AppHandle, id: &str) {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut entries = read_store(app);
    let mut changed = false;
    for e in entries.iter_mut() {
        if e.id == id && e.dismissed_at.is_none() {
            e.dismissed_at = Some(now_ms());
            changed = true;
            break;
        }
    }
    if changed {
        write_store(app, &entries);
    }
}

/// Wipe all entries.
pub fn clear(app: &AppHandle) {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    write_store(app, &[]);
}

/// Housekeeping sweep — called once on startup so an abandoned app's file
/// doesn't grow unbounded.
pub fn startup_housekeeping(app: &AppHandle) {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut entries = read_store(app);
    let before = entries.len();
    housekeep(&mut entries);
    if entries.len() != before {
        write_store(app, &entries);
    }
}
