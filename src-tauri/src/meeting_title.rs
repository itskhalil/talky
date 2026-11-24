//! Best-effort detection of the current meeting's name from window titles.
//!
//! Meeting apps usually put the meeting subject in the title of the call
//! window. The parsing rules below are pure functions (unit-tested, all
//! platforms). Reading the window titles is platform-specific: on macOS it
//! uses the Accessibility API, which needs the Accessibility permission.
//!
//! Observed title formats (macOS unless noted):
//! - Teams (new, `com.microsoft.teams2`): call window = `<subject>`; main
//!   window = `<Section> | <Name>` (e.g. `Chat | Jane Doe`); helper window =
//!   `Window`. On Windows the call window is
//!   `<subject> | <org> | <account> | Microsoft Teams`.
//! - Teams / Google Meet in a browser: the active tab's title, e.g.
//!   `<subject> | Microsoft Teams` or `Meet - <name or code>`.
//! - Slack: pop-out huddle window = `Huddle: <channel/people> - <workspace> - Slack`.
//! - Signal: every window is titled `Signal` (no meeting name available).
//! - Zoom: generic titles (`Zoom Meeting`, `Zoom Workplace`).

// Window enumeration is macOS-only for now; the parsers are kept
// cross-platform so a Windows implementation can reuse them.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

/// Generic Teams window titles / sections that are never a meeting subject.
const TEAMS_GENERIC: &[&str] = &[
    "",
    "window",
    "microsoft teams",
    "notification",
    "chat",
    "calendar",
    "activity",
    "teams",
    "calls",
    "files",
    "apps",
    "onedrive",
    "copilot",
    "communities",
    "people",
    "assignments",
    "meet",
    "settings",
    "search",
    "home",
];

const TEAMS_SUFFIX: &str = "Microsoft Teams";

/// Window title suffixes some browsers append (mostly on Windows/Linux).
const BROWSER_SUFFIXES: &[&str] = &[
    "Google Chrome",
    "Chromium",
    "Microsoft Edge",
    "Microsoft\u{200b} Edge",
    "Brave",
    "Mozilla Firefox",
    "Opera",
    "Safari",
];

fn is_teams_generic(s: &str) -> bool {
    TEAMS_GENERIC.contains(&s.trim().to_lowercase().as_str())
}

fn split_segments<'a>(title: &'a str, sep: &str) -> Vec<&'a str> {
    title.split(sep).map(str::trim).collect()
}

/// Subject of a Teams call window, if `title` looks like one.
pub fn teams_subject(title: &str) -> Option<String> {
    let title = title.trim();
    let segments = split_segments(title, " | ");
    let subject = match segments.as_slice() {
        // macOS desktop call window: a single, non-generic segment.
        [only] => *only,
        // Windows desktop / browser: "<subject> | ... | Microsoft Teams".
        [first, .., last] if last.eq_ignore_ascii_case(TEAMS_SUFFIX) => *first,
        // macOS main window ("Chat | Jane Doe") or anything else.
        _ => return None,
    };
    if is_teams_generic(subject) {
        return None;
    }
    Some(subject.to_string())
}

/// Name of a Slack huddle, if `title` is a huddle window.
pub fn slack_huddle_name(title: &str) -> Option<String> {
    let title = title.trim();
    let prefix = "huddle:";
    if title.len() < prefix.len() || !title[..prefix.len()].eq_ignore_ascii_case(prefix) {
        return None;
    }
    let rest = title[prefix.len()..].trim();
    let mut segments = split_segments(rest, " - ");
    if segments
        .last()
        .is_some_and(|s| s.eq_ignore_ascii_case("Slack"))
    {
        segments.pop();
        // What remains is "<name> - <workspace>"; drop the workspace.
        if segments.len() >= 2 {
            segments.pop();
        }
    }
    let name = segments.join(" - ");
    (!name.is_empty()).then_some(name)
}

/// True for an auto-generated Google Meet code such as `abc-defg-hij`.
fn is_meet_code(s: &str) -> bool {
    let parts: Vec<&str> = s.split('-').collect();
    parts.len() == 3
        && parts.iter().map(|p| p.len()).eq([3, 4, 3])
        && parts
            .iter()
            .all(|p| p.chars().all(|c| c.is_ascii_lowercase()))
}

fn strip_browser_suffix(title: &str) -> &str {
    let title = title.trim();
    for suffix in BROWSER_SUFFIXES {
        for sep in [" - ", " — ", " – "] {
            if let Some(stripped) = title.strip_suffix(&format!("{sep}{suffix}")) {
                return stripped.trim();
            }
        }
    }
    title
}

/// Meeting name from a Google Meet tab title (`Meet - <name>`).
/// Returns `None` for bare meeting codes, which aren't useful names.
pub fn google_meet_name(title: &str) -> Option<String> {
    let title = strip_browser_suffix(title);
    let rest = ["Meet - ", "Meet – ", "Meet — "]
        .iter()
        .find_map(|p| title.strip_prefix(p))?
        .trim();
    if rest.is_empty() || is_meet_code(rest) {
        return None;
    }
    Some(rest.to_string())
}

/// Meeting name from a Signal window, if it isn't the generic `Signal`.
pub fn signal_call_name(title: &str) -> Option<String> {
    let title = title.trim();
    if title.is_empty() || title.eq_ignore_ascii_case("Signal") {
        return None;
    }
    Some(title.to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AppKind {
    Teams,
    Slack,
    Signal,
    Browser,
    Other,
}

fn app_kind(bundle_id: &str) -> AppKind {
    let id = bundle_id.to_lowercase();
    if id.contains("teams") {
        AppKind::Teams
    } else if id.contains("slackmacgap") {
        AppKind::Slack
    } else if id.contains("signal") {
        AppKind::Signal
    } else if [
        "chrome", "chromium", "safari", "webkit", "edgemac", "brave", "firefox", "opera", "arc",
    ]
    .iter()
    .any(|b| id.contains(b))
    {
        AppKind::Browser
    } else {
        AppKind::Other
    }
}

/// Pick the meeting name out of an app's window titles.
pub fn title_from_windows<S: AsRef<str>>(bundle_id: &str, titles: &[S]) -> Option<String> {
    let parse: fn(&str) -> Option<String> = match app_kind(bundle_id) {
        AppKind::Teams => teams_subject,
        AppKind::Slack => slack_huddle_name,
        AppKind::Signal => signal_call_name,
        AppKind::Browser => |t| {
            // Teams-in-browser titles always carry the "| Microsoft Teams"
            // suffix, so a bare tab title never matches the macOS rule.
            let t = strip_browser_suffix(t);
            google_meet_name(t).or_else(|| t.contains(" | ").then(|| teams_subject(t)).flatten())
        },
        AppKind::Other => return None,
    };
    titles.iter().find_map(|t| parse(t.as_ref()))
}

#[cfg(target_os = "macos")]
mod platform {
    use cidre::{ax, cf};
    use objc2_app_kit::NSWorkspace;
    use std::time::Duration;

    /// Per-call timeout so an unresponsive app can't stall the caller.
    const AX_TIMEOUT: Duration = Duration::from_millis(250);

    pub fn is_trusted() -> bool {
        ax::is_process_trusted()
    }

    /// The app bundle that owns a (possibly helper) bundle ID, e.g.
    /// `com.google.Chrome.helper` -> `com.google.Chrome`.
    fn owner_matches(app_bundle: &str, mic_bundle: &str) -> bool {
        if mic_bundle.starts_with("com.apple.WebKit") {
            return app_bundle == "com.apple.Safari";
        }
        mic_bundle == app_bundle || mic_bundle.starts_with(&format!("{app_bundle}."))
    }

    /// Bundle IDs of all running apps.
    pub fn running_bundle_ids() -> Vec<String> {
        NSWorkspace::sharedWorkspace()
            .runningApplications()
            .iter()
            .filter(|app| !app.isTerminated())
            .filter_map(|app| app.bundleIdentifier().map(|b| b.to_string()))
            .collect()
    }

    /// PIDs of running apps that own `bundle_id`.
    fn pids_for(bundle_id: &str) -> Vec<i32> {
        let apps = NSWorkspace::sharedWorkspace().runningApplications();
        apps.iter()
            .filter(|app| !app.isTerminated())
            .filter(|app| {
                app.bundleIdentifier()
                    .is_some_and(|b| owner_matches(&b.to_string(), bundle_id))
            })
            .map(|app| app.processIdentifier())
            .collect()
    }

    fn window_titles_for_pid(pid: i32) -> Vec<String> {
        let app = ax::UiElement::with_app_pid(pid);
        let _ = app.set_messaging_timeout(AX_TIMEOUT);
        let Ok(value) = app.attr_value(ax::attr::windows()) else {
            return Vec::new();
        };
        if value.get_type_id() != cf::Array::type_id() {
            return Vec::new();
        }
        // SAFETY: type checked above; kAXWindowsAttribute is an array of
        // AXUIElements.
        let windows: &cf::ArrayOf<ax::UiElement> = unsafe { std::mem::transmute(&*value) };
        windows
            .iter()
            .filter_map(|w| {
                let t = w.attr_value(ax::attr::title()).ok()?;
                t.try_as_string().map(|s| s.to_string())
            })
            .collect()
    }

    pub fn window_titles(bundle_id: &str) -> Vec<String> {
        pids_for(bundle_id)
            .into_iter()
            .flat_map(window_titles_for_pid)
            .collect()
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    pub fn is_trusted() -> bool {
        false
    }
    pub fn running_bundle_ids() -> Vec<String> {
        Vec::new()
    }
    pub fn window_titles(_bundle_id: &str) -> Vec<String> {
        Vec::new()
    }
}

pub use platform::{is_trusted, running_bundle_ids, window_titles};

/// Detect the meeting name for an app (by bundle ID). `None` when the
/// permission is missing or no window title looks like a meeting.
pub fn detect(bundle_id: &str) -> Option<String> {
    if !is_trusted() {
        return None;
    }
    title_from_windows(bundle_id, &window_titles(bundle_id))
}

/// Why `detect` found no name for `bundle_id`, for logs. Window titles can
/// hold private meeting names, so they are only logged at debug level.
pub fn explain_miss(bundle_id: &str) -> String {
    if !is_trusted() {
        return "Accessibility permission not granted".to_string();
    }
    let titles = window_titles(bundle_id);
    log::debug!("{bundle_id} window titles: {titles:?}");
    format!("{} window(s), none looked like a meeting", titles.len())
}

/// Detect a meeting name across several apps, in priority order.
/// Returns `(bundle_id, title)` for the first match.
pub fn detect_any<'a, I>(bundle_ids: I) -> Option<(String, String)>
where
    I: IntoIterator<Item = &'a str>,
{
    if !is_trusted() {
        return None;
    }
    bundle_ids
        .into_iter()
        .find_map(|id| detect(id).map(|t| (id.to_string(), t)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn teams_mac_call_window() {
        assert_eq!(teams_subject("Weekly Sync"), Some("Weekly Sync".into()));
        assert_eq!(
            teams_subject("  Planning: Q3  "),
            Some("Planning: Q3".into())
        );
    }

    #[test]
    fn teams_mac_non_call_windows() {
        for t in [
            "Chat | Jane Doe",
            "Window",
            "Microsoft Teams",
            "Calendar",
            "",
        ] {
            assert_eq!(teams_subject(t), None, "{t:?}");
        }
    }

    #[test]
    fn teams_windows_format() {
        assert_eq!(
            teams_subject("Weekly Sync | Acme | jane@acme.com | Microsoft Teams"),
            Some("Weekly Sync".into())
        );
        assert_eq!(
            teams_subject("Weekly Sync | Microsoft Teams"),
            Some("Weekly Sync".into())
        );
        assert_eq!(
            teams_subject("Chat | Jane Doe | Acme | jane@acme.com | Microsoft Teams"),
            None
        );
        assert_eq!(teams_subject("Microsoft Teams | Weekly Sync"), None);
    }

    #[test]
    fn teams_picks_call_window_among_others() {
        let titles = ["Chat | Jane Doe", "Window", "Design review"];
        assert_eq!(
            title_from_windows("com.microsoft.teams2", &titles),
            Some("Design review".into())
        );
        let no_call = ["Chat | Jane Doe", "Window"];
        assert_eq!(title_from_windows("com.microsoft.teams2", &no_call), None);
    }

    #[test]
    fn slack_huddle() {
        assert_eq!(
            slack_huddle_name("Huddle: #design - Acme - Slack"),
            Some("#design".into())
        );
        assert_eq!(
            slack_huddle_name("Huddle: Jane Doe, John Roe - Acme - Slack"),
            Some("Jane Doe, John Roe".into())
        );
        assert_eq!(slack_huddle_name("huddle: #ops"), Some("#ops".into()));
        assert_eq!(slack_huddle_name("Huddles - Acme - Slack"), None);
        assert_eq!(slack_huddle_name("Jane Doe (DM) - Acme - Slack"), None);
        assert_eq!(slack_huddle_name("Huddle:"), None);
    }

    #[test]
    fn slack_ignores_main_window() {
        let titles = [
            "Jane Doe (DM) - Acme - Slack",
            "Huddle: #design - Acme - Slack",
        ];
        assert_eq!(
            title_from_windows("com.tinyspeck.slackmacgap", &titles),
            Some("#design".into())
        );
        assert_eq!(
            title_from_windows("com.tinyspeck.slackmacgap", &titles[..1]),
            None
        );
    }

    #[test]
    fn google_meet() {
        assert_eq!(
            google_meet_name("Meet - Team standup"),
            Some("Team standup".into())
        );
        assert_eq!(
            google_meet_name("Meet – Team standup - Google Chrome"),
            Some("Team standup".into())
        );
        assert_eq!(google_meet_name("Meet - abc-defg-hij"), None);
        assert_eq!(
            google_meet_name("Meet – abc-defg-hij - Google Chrome"),
            None
        );
        assert_eq!(google_meet_name("Google Meet"), None);
        assert_eq!(google_meet_name("Inbox (3) - Gmail"), None);
    }

    #[test]
    fn browser_teams_and_meet() {
        assert_eq!(
            title_from_windows("com.google.Chrome", &["Weekly Sync | Microsoft Teams"]),
            Some("Weekly Sync".into())
        );
        // A plain tab title must not be mistaken for a Teams subject.
        assert_eq!(
            title_from_windows("com.google.Chrome", &["Hacker News"]),
            None
        );
        assert_eq!(
            title_from_windows("com.apple.WebKit.GPU", &["Meet - Retro"]),
            Some("Retro".into())
        );
    }

    #[test]
    fn signal() {
        assert_eq!(signal_call_name("Signal"), None);
        assert_eq!(signal_call_name("Jane Doe"), Some("Jane Doe".into()));
    }

    #[test]
    fn unknown_apps_yield_nothing() {
        assert_eq!(title_from_windows("us.zoom.xos", &["Zoom Meeting"]), None);
        assert_eq!(
            title_from_windows("com.apple.FaceTime", &["FaceTime"]),
            None
        );
    }
}
