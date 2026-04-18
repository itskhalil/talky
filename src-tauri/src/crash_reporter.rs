/// On startup, scans ~/Library/Logs/DiagnosticReports for any Talky crash reports
/// from previous sessions and appends them to the current log file. Silent — no UI.
///
/// Uses a small tracking file in the log directory to avoid re-logging the same
/// report across multiple startups.
#[cfg(target_os = "macos")]
pub fn check_for_crash_reports(app: &tauri::AppHandle) {
    use std::collections::HashSet;
    use std::fs;
    use std::path::PathBuf;
    use tauri::Manager;

    let log_dir: PathBuf = match app.path().app_log_dir() {
        Ok(d) => d,
        Err(e) => {
            log::debug!("CrashReporter: could not resolve log dir: {}", e);
            return;
        }
    };

    let home = match std::env::var("HOME") {
        Ok(h) => PathBuf::from(h),
        Err(_) => return,
    };

    let diag_dir = home.join("Library/Logs/DiagnosticReports");
    if !diag_dir.exists() {
        return;
    }

    // Load the set of crash reports we've already logged
    let seen_file = log_dir.join(".processed_crashes");
    let mut seen: HashSet<String> = fs::read_to_string(&seen_file)
        .unwrap_or_default()
        .lines()
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect();

    let entries = match fs::read_dir(&diag_dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    let mut newly_seen: Vec<String> = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };

        // Match only Talky crash reports (.ips = modern macOS, .crash = older)
        let lower = name.to_lowercase();
        if !lower.starts_with("talky") {
            continue;
        }
        if !lower.ends_with(".ips") && !lower.ends_with(".crash") {
            continue;
        }

        if seen.contains(&name) {
            continue;
        }

        newly_seen.push(name.clone());

        log::warn!("=== PREVIOUS CRASH REPORT: {} ===", name);
        let mut summary_line: Option<String> = None;
        match fs::read_to_string(&path) {
            Ok(content) => {
                let lines: Vec<&str> = content.lines().collect();
                let limit = lines.len().min(80);
                for line in &lines[..limit] {
                    log::warn!("  {}", line);
                }
                if lines.len() > 80 {
                    log::warn!(
                        "  ... ({} more lines — full report at {})",
                        lines.len() - 80,
                        path.display()
                    );
                }
                // Grab the first non-empty line as a short detail for the banner.
                summary_line = lines
                    .iter()
                    .find(|l| !l.trim().is_empty())
                    .map(|s| s.to_string());
            }
            Err(e) => {
                log::warn!("  (could not read report: {})", e);
            }
        }
        log::warn!("=== END CRASH REPORT ===");

        // Surface the crash in the user-visible error-events banner. Keeps
        // the log-append path (above) intact; adds a UI signal on top of it.
        crate::error_events::record(
            app,
            crate::error_events::ErrorKind::NativeCrash,
            "Talky crashed previously",
            summary_line.unwrap_or_else(|| format!("Crash report saved at {}", path.display())),
        );
    }

    if !newly_seen.is_empty() {
        for name in &newly_seen {
            seen.insert(name.clone());
        }
        let content = seen
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>()
            .join("\n");
        let _ = fs::write(&seen_file, content);
    }
}

#[cfg(not(target_os = "macos"))]
pub fn check_for_crash_reports(_app: &tauri::AppHandle) {}
