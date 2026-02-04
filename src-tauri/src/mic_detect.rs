//! Mic detection module for detecting when meeting apps release the microphone.
//! Uses CoreAudio's process tracking to identify which apps are using audio input.

use cidre::core_audio as ca;
use std::collections::HashSet;

/// Known meeting app bundle ID patterns
const MEETING_APPS: &[&str] = &[
    "us.zoom.xos",                // Zoom
    "com.microsoft.teams",        // Teams
    "com.google.Chrome",          // Chrome (Meet)
    "com.brave.Browser",          // Brave (Meet)
    "com.apple.Safari",           // Safari (Meet)
    "com.cisco.webexmeetingsapp", // WebEx
    "com.tinyspeck.slackmacgap",  // Slack
    "com.hnc.Discord",            // Discord
    "org.chromium.Chromium",      // Chromium
    "com.microsoft.edgemac",      // Edge (Meet)
    "org.mozilla.firefox",        // Firefox
    "com.operasoftware.Opera",    // Opera
];

/// Get bundle IDs of apps currently using the microphone input
pub fn get_mic_using_apps() -> HashSet<String> {
    let Ok(processes) = ca::System::processes() else {
        return HashSet::new();
    };

    processes
        .into_iter()
        .filter(|p| p.is_running_input().unwrap_or(false))
        .filter_map(|p| p.bundle_id().ok())
        .map(|s| s.to_string())
        .collect()
}

/// Filter a set of bundle IDs to only include known meeting apps
pub fn filter_meeting_apps(apps: &HashSet<String>) -> HashSet<String> {
    apps.iter()
        .filter(|id| MEETING_APPS.iter().any(|m| id.contains(m)))
        .cloned()
        .collect()
}

/// Get a friendly display name for a bundle ID
pub fn app_name(bundle_id: &str) -> &'static str {
    match bundle_id {
        s if s.contains("zoom") => "Zoom",
        s if s.contains("teams") => "Teams",
        s if s.contains("Chrome") || s.contains("Chromium") => "Chrome",
        s if s.contains("Safari") => "Safari",
        s if s.contains("webex") || s.contains("cisco") => "WebEx",
        s if s.contains("Slack") || s.contains("slackmacgap") => "Slack",
        s if s.contains("Discord") => "Discord",
        s if s.contains("edgemac") => "Edge",
        s if s.contains("firefox") => "Firefox",
        s if s.contains("Opera") => "Opera",
        s if s.contains("brave") || s.contains("Brave") => "Brave",
        _ => "Meeting app",
    }
}
