use crate::settings;
use crate::tray_i18n::get_tray_translations;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIcon;
use tauri::{AppHandle, Manager, Theme};

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

/// Gets the appropriate static icon path for the given theme
pub fn get_icon_path(theme: AppTheme) -> &'static str {
    match theme {
        // Dark theme uses light icons
        AppTheme::Dark => "resources/tray_idle.png",
        // Light theme uses dark icons
        AppTheme::Light => "resources/tray_idle_dark.png",
        // Colored theme uses pink icons (for Linux)
        AppTheme::Colored => "resources/talky.png",
    }
}

pub fn update_tray_menu(app: &AppHandle, locale: Option<&str>) {
    let settings = settings::get_settings(app);

    let locale = locale.unwrap_or(&settings.app_language);
    let strings = get_tray_translations(Some(locale.to_string()));

    // Platform-specific accelerators
    #[cfg(target_os = "macos")]
    let quit_accelerator = Some("Cmd+Q");
    #[cfg(not(target_os = "macos"))]
    let quit_accelerator = Some("Ctrl+Q");

    // Static menu items - both actions always available
    let new_note_item = MenuItem::with_id(app, "new_note", &strings.new_note, true, None::<&str>)
        .expect("failed to create new note item");
    let stop_recording_item = MenuItem::with_id(
        app,
        "stop_recording",
        &strings.stop_recording,
        true,
        None::<&str>,
    )
    .expect("failed to create stop recording item");

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
            &new_note_item,
            &stop_recording_item,
            &separator(),
            &quit_i,
        ],
    )
    .expect("failed to create menu");

    let tray = app.state::<TrayIcon>();
    let _ = tray.set_menu(Some(menu));
    let _ = tray.set_icon_as_template(true);
}
