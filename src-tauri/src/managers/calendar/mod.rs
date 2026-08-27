//! Calendar integration.
//!
//! `CalendarSource` is the seam. EventKit is the only implementation today and
//! covers every provider the user actually has — macOS reads Google, Exchange /
//! M365, iCloud and CalDAV into one system store, so there is no per-provider
//! code, no OAuth, no tokens and no network traffic from Talky. Anything above
//! this module works in terms of `CalendarEvent` / `CalendarAttendee` and never
//! touches a platform API.

#[cfg(target_os = "macos")]
pub mod eventkit;

use anyhow::Result;
use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
pub enum CalendarAuthStatus {
    /// This build has no calendar integration (everything but macOS today).
    Unavailable,
    /// Never asked. The only state from which requesting access shows a prompt.
    NotDetermined,
    Denied,
    /// Blocked by MDM or parental controls. Asking again will not help.
    Restricted,
    /// macOS 14+ write-only grant: we can add events but not read them, which
    /// is useless to us. Kept distinct from `Denied` so the UI can explain it.
    WriteOnly,
    Authorized,
}

impl CalendarAuthStatus {
    pub fn can_read(self) -> bool {
        matches!(self, CalendarAuthStatus::Authorized)
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type, Default)]
#[serde(rename_all = "snake_case")]
pub enum AttendeeRole {
    #[default]
    Unknown,
    Required,
    Optional,
    Chair,
    NonParticipant,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type, Default)]
#[serde(rename_all = "snake_case")]
pub enum AttendeeStatus {
    #[default]
    Unknown,
    Pending,
    Accepted,
    Declined,
    Tentative,
    Delegated,
    Completed,
    InProcess,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Type)]
pub struct CalendarAttendee {
    /// Display name exactly as the calendar server reports it.
    pub name: Option<String>,
    /// Lowercased address from the participant's `mailto:` URL. This is the
    /// stable identity a person is keyed on — names are not unique and change.
    pub email: Option<String>,
    pub role: AttendeeRole,
    pub status: AttendeeStatus,
    pub is_current_user: bool,
    pub is_organizer: bool,
    /// Best available human name, derived once at capture time by
    /// [`derive_display_name`]. Stored rather than computed on read so the UI
    /// and the speaker naming pass agree, and so a snapshot keeps the name it
    /// was captured with.
    #[serde(default)]
    pub display_name: Option<String>,
}

impl CalendarAttendee {
    pub fn new(
        name: Option<String>,
        email: Option<String>,
        role: AttendeeRole,
        status: AttendeeStatus,
        is_current_user: bool,
        is_organizer: bool,
    ) -> Self {
        let display_name = derive_display_name(name.as_deref(), email.as_deref());
        Self {
            name,
            email,
            role,
            status,
            is_current_user,
            is_organizer,
            display_name,
        }
    }
}

/// Best available human name for a participant.
///
/// Calendar servers routinely put the email address in the `name` field —
/// Google does it for anyone not in your contacts, and the spike saw it on
/// most participants. Passing that through would give the speaker naming pass
/// a candidate list of addresses instead of names, so when `name` is missing
/// or is just the address again, derive one from the local part:
/// `anna.schmidt@…` becomes `Anna Schmidt`.
pub fn derive_display_name(name: Option<&str>, email: Option<&str>) -> Option<String> {
    if let Some(name) = name {
        let looks_like_the_address =
            email.is_some_and(|e| e.eq_ignore_ascii_case(name)) || name.contains('@');
        if !looks_like_the_address && !name.trim().is_empty() {
            return Some(name.trim().to_string());
        }
    }
    // No fallback to the raw `name` here: at this point it is an email address,
    // and handing an address back as a display name is exactly the failure this
    // function exists to prevent. `None` lets the UI render the address as an
    // address, and gives the naming pass one fewer false candidate.
    email.and_then(name_from_email)
}

/// Derive a plausible personal name from an email local part.
///
/// Returns `None` rather than guessing when the local part does not look like
/// a person: role addresses, anything with digits, or a single opaque token.
/// A wrong candidate name is worse than a missing one — it gives the naming
/// pass something confident and false to latch onto.
fn name_from_email(email: &str) -> Option<String> {
    const ROLE_ADDRESSES: &[&str] = &[
        "noreply",
        "no-reply",
        "donotreply",
        "info",
        "support",
        "hello",
        "team",
        "admin",
        "calendar",
        "invites",
        "notifications",
    ];

    let local = email.split('@').next()?.trim();
    if local.is_empty() {
        return None;
    }
    let lowered = local.to_ascii_lowercase();
    if ROLE_ADDRESSES.contains(&lowered.as_str()) {
        return None;
    }
    if local.chars().any(|c| c.is_ascii_digit()) {
        return None;
    }

    let tokens: Vec<&str> = local
        .split(['.', '_', '-', '+'])
        .filter(|t| !t.is_empty())
        .collect();
    // A single token is an opaque handle as often as it is a first name, and
    // 5+ tokens is a mailing list. Neither is worth a guess.
    if tokens.len() < 2 || tokens.len() > 4 {
        return None;
    }
    if !tokens.iter().all(|t| t.chars().all(|c| c.is_alphabetic())) {
        return None;
    }

    Some(
        tokens
            .iter()
            .map(|t| capitalize(t))
            .collect::<Vec<_>>()
            .join(" "),
    )
}

fn capitalize(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + &chars.as_str().to_lowercase(),
        None => String::new(),
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Type)]
pub struct CalendarEvent {
    /// Device-local identifier. Stable on this Mac only — persist
    /// `external_id` instead.
    pub id: String,
    /// Identifier from the calendar server, shared across devices. Every
    /// occurrence of a recurring series shares it, so a stored link pairs it
    /// with `start_ms` to name one occurrence.
    pub external_id: Option<String>,
    pub title: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub is_all_day: bool,
    pub calendar_title: Option<String>,
    pub location: Option<String>,
    /// The invite body — where the agenda and, usually, the join link live.
    pub notes: Option<String>,
    pub url: Option<String>,
    /// Video-call link, taken from `url` or found in `location` / `notes`.
    /// The spike found `EKEvent.url` empty on every real event, so in practice
    /// this comes from the notes.
    pub conference_url: Option<String>,
    pub organizer: Option<CalendarAttendee>,
    pub attendees: Vec<CalendarAttendee>,
    pub is_recurring: bool,
}

impl CalendarEvent {
    /// Everyone on the invite who isn't the user.
    pub fn others(&self) -> Vec<&CalendarAttendee> {
        self.attendees
            .iter()
            .filter(|a| !a.is_current_user)
            .collect()
    }

    /// Whether this looks like a meeting with people rather than a personal
    /// block. "Gym", "Focus time" and birthdays all land on the calendar and
    /// none of them should offer to become a note.
    pub fn is_meeting(&self) -> bool {
        if self.is_all_day {
            return false;
        }
        !self.others().is_empty() || self.conference_url.is_some()
    }
}

static CONFERENCE_URL: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r#"(?ix)
        https://(?:
              [\w.-]*\.zoom\.us/(?:j|w|my|s)/[^\s<>"'\]]+
            | teams\.microsoft\.com/l/meetup-join/[^\s<>"'\]]+
            | teams\.live\.com/meet/[^\s<>"'\]]+
            | meet\.google\.com/[a-z]{3}-[a-z]{4}-[a-z]{3}
            | [\w.-]*\.webex\.com/[^\s<>"'\]]+
            | whereby\.com/[^\s<>"'\]]+
            | meet\.jit\.si/[^\s<>"'\]]+
            | [\w.-]*\.around\.co/[^\s<>"'\]]+
        )
        "#,
    )
    .expect("conference url regex")
});

/// Find a video-call link in the fields an invite might hide it in.
pub fn find_conference_url(
    url: Option<&str>,
    location: Option<&str>,
    notes: Option<&str>,
) -> Option<String> {
    for field in [url, location, notes].into_iter().flatten() {
        if let Some(m) = CONFERENCE_URL.find(field) {
            // Trailing punctuation from prose ("join at <url>.") is not part
            // of the link.
            return Some(
                m.as_str()
                    .trim_end_matches(['.', ',', ')', '>'])
                    .to_string(),
            );
        }
    }
    None
}

/// Read-only access to the user's calendars.
///
/// Read-only is deliberate and permanent: Talky has no reason to write to a
/// calendar, and asking for write access would widen the permission prompt for
/// nothing.
pub trait CalendarSource: Send + Sync {
    fn authorization_status(&self) -> CalendarAuthStatus;

    /// Show the system permission prompt if it hasn't been shown. Returns the
    /// status afterwards. Blocking — call off the main thread.
    fn request_access(&self) -> Result<CalendarAuthStatus>;

    /// Events overlapping `[start_ms, end_ms)`, in epoch milliseconds.
    fn events_between(&self, start_ms: i64, end_ms: i64) -> Result<Vec<CalendarEvent>>;
}

/// The calendar source for this platform.
pub fn source() -> Box<dyn CalendarSource> {
    #[cfg(target_os = "macos")]
    {
        Box::new(eventkit::EventKitSource)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Box::new(NoCalendar)
    }
}

/// Stand-in on platforms with no calendar integration. Reports `Unavailable`
/// so the UI can hide the feature rather than show a broken one.
#[cfg(not(target_os = "macos"))]
pub struct NoCalendar;

#[cfg(not(target_os = "macos"))]
impl CalendarSource for NoCalendar {
    fn authorization_status(&self) -> CalendarAuthStatus {
        CalendarAuthStatus::Unavailable
    }
    fn request_access(&self) -> Result<CalendarAuthStatus> {
        Ok(CalendarAuthStatus::Unavailable)
    }
    fn events_between(&self, _start_ms: i64, _end_ms: i64) -> Result<Vec<CalendarEvent>> {
        Ok(Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attendee(name: Option<&str>, email: Option<&str>) -> CalendarAttendee {
        CalendarAttendee::new(
            name.map(str::to_string),
            email.map(str::to_string),
            AttendeeRole::Required,
            AttendeeStatus::Accepted,
            false,
            false,
        )
    }

    #[test]
    fn real_name_wins() {
        let a = attendee(Some("Anna Schmidt"), Some("anna.s@example.com"));
        assert_eq!(a.display_name.as_deref(), Some("Anna Schmidt"));
    }

    #[test]
    fn address_masquerading_as_name_is_replaced() {
        // What Google actually sends for anyone not in your contacts.
        let a = attendee(
            Some("anna.schmidt@example.com"),
            Some("anna.schmidt@example.com"),
        );
        assert_eq!(a.display_name.as_deref(), Some("Anna Schmidt"));
    }

    #[test]
    fn an_unnameable_attendee_has_no_display_name() {
        let a = attendee(Some("xk9@example.com"), Some("xk9@example.com"));
        assert_eq!(a.display_name, None);
    }

    #[test]
    fn opaque_local_parts_are_not_guessed() {
        assert_eq!(name_from_email("annaschmidt@example.com"), None);
        assert_eq!(name_from_email("as2938@example.com"), None);
        assert_eq!(name_from_email("noreply@example.com"), None);
    }

    #[test]
    fn conference_links_come_out_of_the_notes() {
        let notes =
            "Agenda attached.\nJoin: https://us02web.zoom.us/j/8912345678?pwd=abc\nDial in…";
        assert_eq!(
            find_conference_url(None, None, Some(notes)).as_deref(),
            Some("https://us02web.zoom.us/j/8912345678?pwd=abc")
        );
        assert_eq!(
            find_conference_url(
                None,
                None,
                Some("see https://meet.google.com/abc-defg-hij.")
            )
            .as_deref(),
            Some("https://meet.google.com/abc-defg-hij")
        );
        assert_eq!(find_conference_url(None, None, Some("no link here")), None);
    }
}
