//! Calendar commands.
//!
//! Every command that talks to EventKit is `#[tauri::command(async)]`: Tauri
//! runs plain sync commands on the main thread, and EventKit's query API is
//! synchronous and documented as needing to run somewhere else.

use crate::managers::calendar::{self, CalendarAuthStatus, CalendarEvent};
use crate::managers::session::SessionManager;
use crate::settings::{get_settings, write_settings};
use std::sync::Arc;
use tauri::{AppHandle, Manager};

/// How far either side of "now" a meeting can sit and still be the one this
/// note is about. Wide enough for the note you open two minutes before the
/// call and the one you start writing ten minutes in.
const LINK_WINDOW_BEFORE_MS: i64 = 10 * 60 * 1000;
const LINK_WINDOW_AFTER_MS: i64 = 10 * 60 * 1000;

#[tauri::command]
#[specta::specta]
pub fn get_calendar_auth_status() -> CalendarAuthStatus {
    calendar::source().authorization_status()
}

/// Show the system permission prompt. Returns the resulting status, which is
/// the same value `get_calendar_auth_status` would return afterwards.
#[tauri::command(async)]
#[specta::specta]
pub fn request_calendar_access() -> Result<CalendarAuthStatus, String> {
    calendar::source()
        .request_access()
        .map_err(|e| e.to_string())
}

/// Turn the feature on or off. Enabling requests access if it hasn't been
/// granted, so the toggle and the permission are one action rather than two
/// steps the user has to connect for themselves.
#[tauri::command(async)]
#[specta::specta]
pub fn set_calendar_enabled(app: AppHandle, enabled: bool) -> Result<CalendarAuthStatus, String> {
    let status = if enabled {
        calendar::source()
            .request_access()
            .map_err(|e| e.to_string())?
    } else {
        calendar::source().authorization_status()
    };

    let mut settings = get_settings(&app);
    // Don't record the feature as on when the grant didn't happen — the UI
    // would show a working toggle over a calendar it cannot read.
    settings.calendar_enabled = enabled && status.can_read();
    write_settings(&app, settings);

    Ok(status)
}

/// Events overlapping the given epoch-millisecond range.
#[tauri::command(async)]
#[specta::specta]
pub fn get_calendar_events(start_ms: i64, end_ms: i64) -> Result<Vec<CalendarEvent>, String> {
    calendar::source()
        .events_between(start_ms, end_ms)
        .map_err(|e| e.to_string())
}

/// Meetings — not personal blocks — within a window around `center_ms`,
/// nearest first. Drives both the auto-link on note creation and the picker
/// the user gets when it guesses wrong.
#[tauri::command(async)]
#[specta::specta]
pub fn get_meetings_near(
    center_ms: i64,
    before_minutes: i64,
    after_minutes: i64,
) -> Result<Vec<CalendarEvent>, String> {
    let before_ms = before_minutes.max(0) * 60 * 1000;
    let after_ms = after_minutes.max(0) * 60 * 1000;
    meetings_near(center_ms, before_ms, after_ms).map_err(|e| e.to_string())
}

fn meetings_near(
    center_ms: i64,
    before_ms: i64,
    after_ms: i64,
) -> anyhow::Result<Vec<CalendarEvent>> {
    // Query wider than the window: an event only has to overlap the window to
    // be a candidate, and a two-hour meeting that started before it would be
    // missed by a query that starts at the window edge.
    let query_start = center_ms - before_ms - 12 * 60 * 60 * 1000;
    let query_end = center_ms + after_ms + 12 * 60 * 60 * 1000;

    let window_start = center_ms - before_ms;
    let window_end = center_ms + after_ms;

    let mut events: Vec<CalendarEvent> = calendar::source()
        .events_between(query_start, query_end)?
        .into_iter()
        .filter(|e| e.is_meeting())
        // Overlap, not containment: a meeting in progress counts.
        .filter(|e| e.start_ms <= window_end && e.end_ms >= window_start)
        .collect();

    // Nearest start to `center_ms` first — the meeting you are in beats the
    // one that ended nine minutes ago.
    events.sort_by_key(|e| (e.start_ms - center_ms).abs());
    Ok(events)
}

/// The meeting a note is linked to, from the snapshot taken at link time.
#[tauri::command]
#[specta::specta]
pub fn get_session_meeting(
    app: AppHandle,
    session_id: String,
) -> Result<Option<CalendarEvent>, String> {
    let sm = app.state::<Arc<SessionManager>>();
    sm.get_session_calendar_event(&session_id)
        .map_err(|e| e.to_string())
}

/// Link a note to a meeting. `event` is one the frontend got from
/// `get_meetings_near` or `get_calendar_events`; it is stored verbatim as the
/// note's durable record of who was invited.
#[tauri::command]
#[specta::specta]
pub fn link_session_to_meeting(
    app: AppHandle,
    session_id: String,
    event: CalendarEvent,
) -> Result<(), String> {
    let sm = app.state::<Arc<SessionManager>>();
    sm.link_session_to_calendar_event(&session_id, &event)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn unlink_session_meeting(app: AppHandle, session_id: String) -> Result<(), String> {
    let sm = app.state::<Arc<SessionManager>>();
    sm.unlink_session_calendar_event(&session_id)
        .map_err(|e| e.to_string())
}

/// Best guess at the meeting a note created right now is about, or `None`.
///
/// Returns nothing when the nearest meeting already has a note: two notes for
/// one meeting splits the record, and the user who wanted that can still link
/// by hand.
#[tauri::command(async)]
#[specta::specta]
pub fn suggest_meeting_for_now(app: AppHandle) -> Result<Option<CalendarEvent>, String> {
    let settings = get_settings(&app);
    if !settings.calendar_enabled {
        return Ok(None);
    }
    if !calendar::source().authorization_status().can_read() {
        return Ok(None);
    }

    let now_ms = chrono::Utc::now().timestamp_millis();
    let candidates = meetings_near(now_ms, LINK_WINDOW_BEFORE_MS, LINK_WINDOW_AFTER_MS)
        .map_err(|e| e.to_string())?;

    let sm = app.state::<Arc<SessionManager>>();
    for event in candidates {
        let external_id = event
            .external_id
            .clone()
            .unwrap_or_else(|| event.id.clone());
        let taken = sm
            .find_session_for_calendar_event(&external_id, event.start_ms)
            .map_err(|e| e.to_string())?
            .is_some();
        if !taken {
            return Ok(Some(event));
        }
    }
    Ok(None)
}
