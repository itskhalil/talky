use crate::settings;
use crate::tray_i18n::get_tray_translations;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIcon;
use tauri::{AppHandle, Manager, Theme};

/// State for the recording indicator animation
pub struct RecordingIndicatorState {
    is_running: AtomicBool,
}

impl Default for RecordingIndicatorState {
    fn default() -> Self {
        Self {
            is_running: AtomicBool::new(false),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum TrayIconState {
    Idle,
    Recording,
}

#[derive(Clone, Debug, PartialEq)]
pub enum AppTheme {
    Dark,
    Light,
    Colored, // Pink/colored theme for Linux
}

/// Gets the current app theme, with Linux defaulting to Colored theme
pub fn get_current_theme(app: &AppHandle) -> AppTheme {
    if cfg!(target_os = "linux") {
        // On Linux, always use the colored theme
        AppTheme::Colored
    } else {
        // On other platforms, map system theme to our app theme
        if let Some(main_window) = app.get_webview_window("main") {
            match main_window.theme().unwrap_or(Theme::Dark) {
                Theme::Light => AppTheme::Light,
                Theme::Dark => AppTheme::Dark,
                _ => AppTheme::Dark, // Default fallback
            }
        } else {
            AppTheme::Dark
        }
    }
}

/// Gets the appropriate icon path for the given theme and state
pub fn get_icon_path(theme: AppTheme, state: TrayIconState) -> &'static str {
    match (theme, state) {
        // Dark theme uses light icons
        (AppTheme::Dark, TrayIconState::Idle) => "resources/tray_idle.png",
        (AppTheme::Dark, TrayIconState::Recording) => "resources/tray_recording.png",
        // Light theme uses dark icons
        (AppTheme::Light, TrayIconState::Idle) => "resources/tray_idle_dark.png",
        (AppTheme::Light, TrayIconState::Recording) => "resources/tray_recording_dark.png",
        // Colored theme uses pink icons (for Linux)
        (AppTheme::Colored, TrayIconState::Idle) => "resources/talky.png",
        (AppTheme::Colored, TrayIconState::Recording) => "resources/recording.png",
    }
}

pub fn change_tray_icon(app: &AppHandle, icon: TrayIconState) {
    let tray = app.state::<TrayIcon>();
    let theme = get_current_theme(app);

    let icon_path = get_icon_path(theme, icon.clone());

    let _ = tray.set_icon(Some(
        Image::from_path(
            app.path()
                .resolve(icon_path, tauri::path::BaseDirectory::Resource)
                .expect("failed to resolve"),
        )
        .expect("failed to set icon"),
    ));

    // Update menu based on state
    update_tray_menu(app, &icon, None);
}

pub fn update_tray_menu(app: &AppHandle, state: &TrayIconState, locale: Option<&str>) {
    let settings = settings::get_settings(app);

    let locale = locale.unwrap_or(&settings.app_language);
    let strings = get_tray_translations(Some(locale.to_string()));

    // Platform-specific accelerators
    #[cfg(target_os = "macos")]
    let quit_accelerator = Some("Cmd+Q");
    #[cfg(not(target_os = "macos"))]
    let quit_accelerator = Some("Ctrl+Q");

    // Primary action: New Note when idle, Stop Recording when recording
    let primary_action = match state {
        TrayIconState::Idle => {
            MenuItem::with_id(app, "new_note", &strings.new_note, true, None::<&str>)
                .expect("failed to create new note item")
        }
        TrayIconState::Recording => MenuItem::with_id(
            app,
            "stop_recording",
            &strings.stop_recording,
            true,
            None::<&str>,
        )
        .expect("failed to create stop recording item"),
    };

    let app_name = MenuItem::with_id(app, "app_name", "Talky", false, None::<&str>)
        .expect("failed to create app name item");
    let quit_i = MenuItem::with_id(app, "quit", &strings.quit, true, quit_accelerator)
        .expect("failed to create quit item");
    let separator = || PredefinedMenuItem::separator(app).expect("failed to create separator");

    let menu = Menu::with_items(
        app,
        &[
            &app_name,
            &separator(),
            &primary_action,
            &separator(),
            &quit_i,
        ],
    )
    .expect("failed to create menu");

    let tray = app.state::<TrayIcon>();
    let _ = tray.set_menu(Some(menu));
    let _ = tray.set_icon_as_template(true);
}

/// Starts the pulsing recording indicator in the menu bar
pub fn start_recording_indicator(app: &AppHandle) {
    // Get or create the indicator state
    let state = match app.try_state::<Arc<RecordingIndicatorState>>() {
        Some(s) => s.inner().clone(),
        None => {
            let s = Arc::new(RecordingIndicatorState::default());
            app.manage(s.clone());
            s
        }
    };

    // If already running, don't start another loop
    if state.is_running.swap(true, Ordering::SeqCst) {
        return;
    }

    let app_handle = app.clone();
    let indicator_state = state;

    // Spawn the animation task
    tauri::async_runtime::spawn(async move {
        let mut toggle = true;

        loop {
            // Check FIRST if we should stop
            if !indicator_state.is_running.load(Ordering::SeqCst) {
                break;
            }

            // Update the tray title with pulsing red indicator
            #[cfg(target_os = "macos")]
            if let Some(tray) = app_handle.try_state::<TrayIcon>() {
                let title = if toggle { "🔴" } else { "⚪" };
                let _ = tray.set_title(Some(title));
            }

            toggle = !toggle;
            tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        }

        // Clear the title when the loop exits
        #[cfg(target_os = "macos")]
        if let Some(tray) = app_handle.try_state::<TrayIcon>() {
            let _ = tray.set_title(Some("")); // Empty string to clear
        }
    });
}

/// Stops the pulsing recording indicator
pub fn stop_recording_indicator(app: &AppHandle) {
    // Just set the flag - the loop will clear the title when it exits
    if let Some(state) = app.try_state::<Arc<RecordingIndicatorState>>() {
        state.is_running.store(false, Ordering::SeqCst);
    }
}
