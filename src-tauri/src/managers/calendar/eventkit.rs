//! EventKit-backed `CalendarSource` (macOS).
//!
//! Runs in-process rather than in a sidecar so the TCC prompt is attributed to
//! Talky itself and uses Talky's own `NSCalendarsFullAccessUsageDescription`
//! string. A separate binary would prompt under its own identity.
//!
//! Access is read-only by design: `requestFullAccessToEvents` is the read
//! grant on macOS 14+ ("full" as opposed to write-only), and Talky never
//! writes to a calendar.

use anyhow::{anyhow, Result};
use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::Bool;
use objc2_event_kit::{
    EKAuthorizationStatus, EKEntityType, EKEvent, EKEventStore, EKParticipant, EKParticipantRole,
    EKParticipantStatus,
};
use objc2_foundation::{NSDate, NSError, NSString};
use std::sync::mpsc;
use std::time::Duration;

use super::{
    find_conference_url, AttendeeRole, AttendeeStatus, CalendarAttendee, CalendarAuthStatus,
    CalendarEvent, CalendarSource,
};

/// How long to wait for the user to answer the system permission prompt before
/// giving up and reporting the status as it stands. Generous: the dialog can
/// sit behind another window.
const PROMPT_TIMEOUT: Duration = Duration::from_secs(120);

/// EventKit's own limit on `predicateForEventsWithStartDate:endDate:calendars:`
/// is four years; anything wider is silently truncated. We cap well below that
/// — no caller wants more than a year of meetings in one query.
const MAX_RANGE_MS: i64 = 366 * 24 * 60 * 60 * 1000;

pub struct EventKitSource;

impl CalendarSource for EventKitSource {
    fn authorization_status(&self) -> CalendarAuthStatus {
        // SAFETY: class method with no arguments beyond a plain enum.
        let status = unsafe { EKEventStore::authorizationStatusForEntityType(EKEntityType::Event) };
        map_status(status)
    }

    fn request_access(&self) -> Result<CalendarAuthStatus> {
        let current = self.authorization_status();
        // Only `NotDetermined` produces a prompt. Re-asking in any other state
        // returns immediately with the same answer, so don't pretend otherwise.
        if current != CalendarAuthStatus::NotDetermined {
            return Ok(current);
        }

        let (tx, rx) = mpsc::channel::<(bool, Option<String>)>();
        // SAFETY: creating an event store is safe; the completion block is kept
        // alive by `RcBlock` for the duration of the call and EventKit retains
        // it until it fires.
        unsafe {
            let store = EKEventStore::new();
            let block = RcBlock::new(move |granted: Bool, error: *mut NSError| {
                let message = if error.is_null() {
                    None
                } else {
                    Some((*error).localizedDescription().to_string())
                };
                // A send failure just means we already timed out.
                let _ = tx.send((granted.as_bool(), message));
            });
            store.requestFullAccessToEventsWithCompletion(RcBlock::as_ptr(&block));

            match rx.recv_timeout(PROMPT_TIMEOUT) {
                Ok((granted, message)) => {
                    if let Some(m) = message {
                        log::warn!("[calendar] access request reported an error: {}", m);
                    }
                    log::info!("[calendar] access request completed, granted={}", granted);
                }
                Err(_) => {
                    log::warn!("[calendar] access request timed out waiting for the user");
                }
            }
        }

        // Trust the authorization status rather than the block's boolean: they
        // agree, and the status is what every later call reads.
        Ok(self.authorization_status())
    }

    fn events_between(&self, start_ms: i64, end_ms: i64) -> Result<Vec<CalendarEvent>> {
        if !self.authorization_status().can_read() {
            return Err(anyhow!("calendar access not granted"));
        }
        if end_ms <= start_ms {
            return Ok(Vec::new());
        }
        let end_ms = end_ms.min(start_ms.saturating_add(MAX_RANGE_MS));

        // A fresh store per call rather than a cached one: `EKEventStore` is not
        // thread-safe and needs `reset()` to see external edits, and measurement
        // says the caching would buy nothing — the first construction in a
        // process costs ~14 ms and every one after it is free, against ~16 ms
        // for the query itself.
        //
        // SAFETY: every call below is a plain Objective-C accessor on an object
        // we own. `eventsMatchingPredicate` is documented as synchronous, which
        // is why callers run this off the main thread.
        unsafe {
            let store = EKEventStore::new();
            let start = NSDate::dateWithTimeIntervalSince1970(start_ms as f64 / 1000.0);
            let end = NSDate::dateWithTimeIntervalSince1970(end_ms as f64 / 1000.0);
            let predicate =
                store.predicateForEventsWithStartDate_endDate_calendars(&start, &end, None);
            let events = store.eventsMatchingPredicate(&predicate);

            let mut out = Vec::with_capacity(events.len());
            for event in events.iter() {
                out.push(convert_event(&event));
            }
            // EventKit gives no ordering guarantee.
            out.sort_by_key(|e| e.start_ms);
            Ok(out)
        }
    }
}

/// # Safety
/// `event` must be a live `EKEvent` from a store that is still alive.
unsafe fn convert_event(event: &EKEvent) -> CalendarEvent {
    let organizer = event.organizer().map(|p| convert_participant(&p, true));
    let organizer_email = organizer.as_ref().and_then(|o| o.email.clone());

    let attendees: Vec<CalendarAttendee> = event
        .attendees()
        .map(|list| {
            list.iter()
                .map(|p| {
                    let mut a = convert_participant(&p, false);
                    // EKParticipant has no `isOrganizer`; match on address.
                    a.is_organizer = match (&a.email, &organizer_email) {
                        (Some(e), Some(o)) => e == o,
                        _ => false,
                    };
                    a
                })
                .collect()
        })
        .unwrap_or_default();

    let location = optional_string(event.location());
    let notes = optional_string(event.notes());
    let url = event
        .URL()
        .map(|u| u.absoluteString().map(|s| s.to_string()));
    let url = url.flatten();

    let conference_url = find_conference_url(url.as_deref(), location.as_deref(), notes.as_deref());

    CalendarEvent {
        id: optional_string(event.eventIdentifier()).unwrap_or_default(),
        external_id: optional_string(event.calendarItemExternalIdentifier()),
        title: event.title().to_string(),
        start_ms: date_to_ms(&event.startDate()),
        end_ms: date_to_ms(&event.endDate()),
        is_all_day: event.isAllDay(),
        calendar_title: event.calendar().map(|c| c.title().to_string()),
        location,
        notes,
        url,
        conference_url,
        organizer,
        attendees,
        is_recurring: event.hasRecurrenceRules(),
    }
}

/// # Safety
/// `p` must be a live `EKParticipant`.
unsafe fn convert_participant(p: &EKParticipant, is_organizer: bool) -> CalendarAttendee {
    // `EKParticipant.URL` is a `mailto:` URL for email-based participants and
    // something else entirely (or empty) for rooms and resources.
    let email = p
        .URL()
        .absoluteString()
        .map(|s| s.to_string())
        .and_then(|s| {
            s.strip_prefix("mailto:")
                .map(|addr| addr.trim().to_ascii_lowercase())
        })
        .filter(|s| !s.is_empty());

    let role = match p.participantRole() {
        EKParticipantRole::Required => AttendeeRole::Required,
        EKParticipantRole::Optional => AttendeeRole::Optional,
        EKParticipantRole::Chair => AttendeeRole::Chair,
        EKParticipantRole::NonParticipant => AttendeeRole::NonParticipant,
        _ => AttendeeRole::Unknown,
    };
    let status = match p.participantStatus() {
        EKParticipantStatus::Pending => AttendeeStatus::Pending,
        EKParticipantStatus::Accepted => AttendeeStatus::Accepted,
        EKParticipantStatus::Declined => AttendeeStatus::Declined,
        EKParticipantStatus::Tentative => AttendeeStatus::Tentative,
        EKParticipantStatus::Delegated => AttendeeStatus::Delegated,
        EKParticipantStatus::Completed => AttendeeStatus::Completed,
        EKParticipantStatus::InProcess => AttendeeStatus::InProcess,
        _ => AttendeeStatus::Unknown,
    };

    CalendarAttendee::new(
        optional_string(p.name()),
        email,
        role,
        status,
        p.isCurrentUser(),
        is_organizer,
    )
}

fn map_status(status: EKAuthorizationStatus) -> CalendarAuthStatus {
    match status {
        EKAuthorizationStatus::NotDetermined => CalendarAuthStatus::NotDetermined,
        EKAuthorizationStatus::Restricted => CalendarAuthStatus::Restricted,
        EKAuthorizationStatus::Denied => CalendarAuthStatus::Denied,
        EKAuthorizationStatus::FullAccess => CalendarAuthStatus::Authorized,
        EKAuthorizationStatus::WriteOnly => CalendarAuthStatus::WriteOnly,
        _ => CalendarAuthStatus::NotDetermined,
    }
}

/// # Safety
/// `date` must be a live `NSDate`.
unsafe fn date_to_ms(date: &NSDate) -> i64 {
    (date.timeIntervalSince1970() * 1000.0) as i64
}

fn optional_string(s: Option<Retained<NSString>>) -> Option<String> {
    s.map(|s| s.to_string())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Smoke test against the real calendar on this machine.
    ///
    /// Ignored by default: it needs a granted TCC permission and real data, so
    /// it can only ever be run by hand — `cargo test -- --ignored calendar`.
    /// Output is redacted to a first initial so running it never prints
    /// somebody's name or address into a terminal or a log.
    #[test]
    #[ignore = "requires calendar permission and real data"]
    fn reads_todays_meetings() {
        fn redact(s: Option<&str>) -> String {
            match s {
                Some(s) if !s.is_empty() => format!("{}… ({} chars)", &s[..1], s.len()),
                _ => "<none>".to_string(),
            }
        }

        let source = EventKitSource;
        let status = source.authorization_status();
        println!("authorization: {:?}", status);
        assert!(
            status.can_read(),
            "grant calendar access before running this"
        );

        let now = chrono::Utc::now().timestamp_millis();
        let day = 24 * 60 * 60 * 1000;
        let events = source
            .events_between(now - 30 * day, now + 14 * day)
            .expect("query calendars");

        let meetings: Vec<_> = events.iter().filter(|e| e.is_meeting()).collect();
        println!(
            "{} events, {} of them meetings",
            events.len(),
            meetings.len()
        );
        assert!(!events.is_empty(), "no events at all in [-30d, +14d]");

        let mut named = 0;
        let mut with_email = 0;
        for m in &meetings {
            for a in m.others() {
                if a.display_name.is_some() {
                    named += 1;
                }
                if a.email.is_some() {
                    with_email += 1;
                }
            }
        }
        println!(
            "guests: {} with an email, {} with a usable name",
            with_email, named
        );

        for m in meetings.iter().take(6) {
            println!(
                "\n{} | {} | recurring={} | conference={}",
                redact(Some(&m.title)),
                m.start_ms,
                m.is_recurring,
                m.conference_url.is_some()
            );
            println!("  external_id: {}", redact(m.external_id.as_deref()));
            for a in m.others() {
                println!(
                    "  - name={} email={} organizer={} status={:?}",
                    redact(a.display_name.as_deref()),
                    redact(a.email.as_deref()),
                    a.is_organizer,
                    a.status
                );
            }
        }
    }
}
