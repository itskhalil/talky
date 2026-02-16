mod actions;
mod aec;
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
mod apple_intelligence;
pub mod audio_toolkit;
mod commands;
mod helpers;
mod llm_client;
mod managers;
mod menu;
#[cfg(target_os = "macos")]
mod mic_detect;
mod platform;
#[cfg(target_os = "macos")]
mod power_events;
mod settings;
mod tray;
mod tray_i18n;
mod utils;
use specta_typescript::{BigIntExportBehavior, Typescript};
use tauri_specta::{collect_commands, Builder};

use env_filter::Builder as EnvFilterBuilder;
use managers::audio::AudioRecordingManager;
use managers::history::HistoryManager;
use managers::model::ModelManager;
use managers::session::SessionManager;
use managers::transcription::TranscriptionManager;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;
use tauri::image::Image;

use tauri::tray::TrayIconBuilder;
use tauri::Emitter;
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_log::{Builder as LogBuilder, RotationStrategy, Target, TargetKind};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

use crate::settings::get_settings;
use std::path::PathBuf;

/// Returns the directory where user data (sessions.db, history.db) should be stored.
/// Uses the custom data directory from settings if set, otherwise the default app data directory.
fn get_user_data_dir(app_handle: &AppHandle) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let settings = get_settings(app_handle);

    if let Some(custom_dir) = settings.data_directory {
        let path = PathBuf::from(&custom_dir);
        // Ensure the directory exists
        if !path.exists() {
            std::fs::create_dir_all(&path)?;
        }
        Ok(path)
    } else {
        // Use the default app data directory
        Ok(app_handle.path().app_data_dir()?)
    }
}

// Global atomic to store the file log level filter
// We use u8 to store the log::LevelFilter as a number
pub static FILE_LOG_LEVEL: AtomicU8 = AtomicU8::new(log::LevelFilter::Debug as u8);

fn level_filter_from_u8(value: u8) -> log::LevelFilter {
    match value {
        0 => log::LevelFilter::Off,
        1 => log::LevelFilter::Error,
        2 => log::LevelFilter::Warn,
        3 => log::LevelFilter::Info,
        4 => log::LevelFilter::Debug,
        5 => log::LevelFilter::Trace,
        _ => log::LevelFilter::Trace,
    }
}

fn build_console_filter() -> env_filter::Filter {
    let mut builder = EnvFilterBuilder::new();

    match std::env::var("RUST_LOG") {
        Ok(spec) if !spec.trim().is_empty() => {
            if let Err(err) = builder.try_parse(&spec) {
                log::warn!(
                    "Ignoring invalid RUST_LOG value '{}': {}. Falling back to info-level console logging",
                    spec,
                    err
                );
                builder.filter_level(log::LevelFilter::Info);
                // Suppress noisy whisper/ggml logs by default
                builder.filter_module("whisper_rs", log::LevelFilter::Warn);
            }
        }
        _ => {
            builder.filter_level(log::LevelFilter::Info);
            // Suppress noisy whisper/ggml logs by default
            builder.filter_module("whisper_rs", log::LevelFilter::Warn);
        }
    }

    builder.build()
}

fn show_main_window(app: &AppHandle) {
    if let Some(main_window) = app.get_webview_window("main") {
        // First, ensure the window is visible
        if let Err(e) = main_window.show() {
            log::error!("Failed to show window: {}", e);
        }
        // Then, bring it to the front and give it focus
        if let Err(e) = main_window.set_focus() {
            log::error!("Failed to focus window: {}", e);
        }
    } else {
        log::error!("Main window not found.");
    }
}

/// Checks if a position is on any currently connected monitor
fn is_position_on_valid_monitor(app: &AppHandle, position: tauri::PhysicalPosition<i32>) -> bool {
    if let Ok(monitors) = app.available_monitors() {
        for monitor in monitors {
            let pos = monitor.position();
            let size = monitor.size();
            let x = position.x;
            let y = position.y;
            if x >= pos.x
                && x < pos.x + size.width as i32
                && y >= pos.y
                && y < pos.y + size.height as i32
            {
                return true;
            }
        }
    }
    false
}

/// Positions the pill window on the same monitor as the main window (top-right with padding)
fn position_pill_on_main_monitor(app: &AppHandle) {
    let pill = match app.get_webview_window("pill") {
        Some(p) => p,
        None => return,
    };

    // Try to get the monitor from the main window first
    let monitor = app
        .get_webview_window("main")
        .and_then(|main| main.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())
        .or_else(|| {
            app.available_monitors()
                .ok()
                .and_then(|m| m.into_iter().next())
        });

    if let Some(monitor) = monitor {
        let pos = monitor.position();
        let size = monitor.size();
        if let Ok(pill_size) = pill.outer_size() {
            let padding = 20;
            let x = pos.x + size.width as i32 - pill_size.width as i32 - padding;
            let y = pos.y + padding;
            let _ = pill.set_position(tauri::PhysicalPosition::new(x, y));
        }
    }
}

pub fn show_pill_window(app: &AppHandle) {
    if let Some(pill) = app.get_webview_window("pill") {
        // Only reposition if the current position is off-screen (e.g., monitor disconnected)
        // The window-state plugin handles persistence automatically
        let needs_reposition = match pill.outer_position() {
            Ok(pos) => !is_position_on_valid_monitor(app, pos),
            Err(_) => true,
        };

        if needs_reposition {
            position_pill_on_main_monitor(app);
        }

        let _ = pill.show();
        // Don't call set_focus() - it causes focus cascade that hides the pill
    }
}

pub fn hide_pill_window(app: &AppHandle) {
    if let Some(pill) = app.get_webview_window("pill") {
        // Save window state before hiding so position is persisted
        let _ = app.save_window_state(StateFlags::POSITION);
        let _ = pill.hide();
    }
}

#[tauri::command]
#[specta::specta]
fn show_main_from_pill(app: AppHandle) {
    show_main_window(&app);
    hide_pill_window(&app);
}

fn initialize_core_logic(app_handle: &AppHandle) {
    // Get custom data directory if configured
    let data_dir = get_user_data_dir(app_handle).ok();

    // Initialize the managers
    let recording_manager = Arc::new(
        AudioRecordingManager::new(app_handle).expect("Failed to initialize recording manager"),
    );
    let model_manager =
        Arc::new(ModelManager::new(app_handle).expect("Failed to initialize model manager"));
    let transcription_manager = Arc::new(
        TranscriptionManager::new(app_handle, model_manager.clone())
            .expect("Failed to initialize transcription manager"),
    );
    let history_manager = Arc::new(
        HistoryManager::new(app_handle, data_dir.clone())
            .expect("Failed to initialize history manager"),
    );
    let session_manager = Arc::new(
        SessionManager::new(app_handle, data_dir).expect("Failed to initialize session manager"),
    );

    // Add managers to Tauri's managed state
    app_handle.manage(recording_manager.clone());
    app_handle.manage(model_manager.clone());
    app_handle.manage(transcription_manager.clone());
    app_handle.manage(history_manager.clone());
    app_handle.manage(session_manager.clone());

    // Get the current theme to set the appropriate initial icon
    let initial_theme = tray::get_current_theme(app_handle);

    // Choose the appropriate icon based on theme
    let initial_icon_path = tray::get_icon_path(initial_theme);

    let tray = TrayIconBuilder::new()
        .icon(
            Image::from_path(
                app_handle
                    .path()
                    .resolve(initial_icon_path, tauri::path::BaseDirectory::Resource)
                    .unwrap(),
            )
            .unwrap(),
        )
        .show_menu_on_left_click(true)
        .icon_as_template(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "new_note" => {
                // Emit event so frontend uses same code path as UI (creates session + starts recording)
                let _ = app.emit("tray-new-note", ());
                show_main_window(app);
            }
            "stop_recording" => {
                // Tell frontend to stop recording (uses same code path as UI button)
                let _ = app.emit("tray-stop-recording", ());
                show_main_window(app);
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .build(app_handle)
        .unwrap();
    app_handle.manage(tray);

    // Initialize tray menu
    utils::update_tray_menu(app_handle, None);

    // Get the autostart manager and configure based on user setting
    let autostart_manager = app_handle.autolaunch();
    let settings = settings::get_settings(&app_handle);

    if settings.autostart_enabled {
        // Enable autostart if user has opted in
        let _ = autostart_manager.enable();
    } else {
        // Disable autostart if user has opted out
        let _ = autostart_manager.disable();
    }

    // Start power event monitoring (detects system sleep to stop recording gracefully)
    #[cfg(target_os = "macos")]
    power_events::start_monitoring(app_handle.clone());
}

#[tauri::command]
#[specta::specta]
fn trigger_update_check(app: AppHandle) -> Result<(), String> {
    let settings = settings::get_settings(&app);
    if !settings.update_checks_enabled {
        return Ok(());
    }
    app.emit("check-for-updates", ())
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Set up global panic hook to log panics before the app crashes
    // This ensures we capture crash information even if the app terminates
    std::panic::set_hook(Box::new(|panic_info| {
        let location = panic_info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown location".to_string());
        let message = panic_info
            .payload()
            .downcast_ref::<&str>()
            .copied()
            .or_else(|| {
                panic_info
                    .payload()
                    .downcast_ref::<String>()
                    .map(|s| s.as_str())
            })
            .unwrap_or("Unknown panic");
        // Use eprintln as a fallback since logging may not be initialized or may fail
        eprintln!("PANIC at {}: {}", location, message);
        // Also try to log it properly
        log::error!("PANIC at {}: {}", location, message);
    }));

    // Parse console logging directives from RUST_LOG, falling back to info-level logging
    // when the variable is unset
    let console_filter = build_console_filter();

    let specta_builder = Builder::<tauri::Wry>::new().commands(collect_commands![
        show_main_from_pill,
        commands::settings::change_user_name_setting,
        commands::settings::change_font_size_setting,
        commands::settings::change_autostart_setting,
        commands::settings::change_translate_to_english_setting,
        commands::settings::change_selected_language_setting,
        commands::settings::change_debug_mode_setting,
        commands::settings::change_post_process_enabled_setting,
        commands::settings::change_experimental_enabled_setting,
        commands::settings::add_post_process_prompt,
        commands::settings::update_post_process_prompt,
        commands::settings::delete_post_process_prompt,
        commands::settings::set_post_process_selected_prompt,
        commands::settings::update_custom_words,
        commands::settings::get_word_suggestions,
        commands::settings::approve_word_suggestion,
        commands::settings::dismiss_word_suggestion,
        commands::settings::add_word_suggestion,
        commands::settings::change_word_suggestions_enabled,
        commands::settings::change_speaker_energy_threshold_setting,
        commands::settings::change_skip_mic_on_speaker_energy_setting,
        commands::settings::change_app_language_setting,
        commands::settings::change_update_checks_setting,
        commands::settings::change_copy_as_bullets_setting,
        commands::settings::get_environments,
        commands::settings::create_environment,
        commands::settings::update_environment,
        commands::settings::delete_environment,
        commands::settings::set_default_environment,
        commands::settings::fetch_environment_models,
        trigger_update_check,
        commands::cancel_operation,
        commands::write_chat_debug_log,
        commands::get_app_dir_path,
        commands::get_app_settings,
        commands::get_default_settings,
        commands::get_log_dir_path,
        commands::set_log_level,
        commands::open_log_dir,
        commands::open_app_data_dir,
        commands::get_user_data_directory,
        commands::has_custom_data_directory,
        commands::set_data_directory,
        commands::open_user_data_directory,
        commands::check_apple_intelligence_available,
        commands::check_ollama_available,
        platform::get_platform_capabilities,
        commands::models::get_available_models,
        commands::models::get_model_info,
        commands::models::download_model,
        commands::models::delete_model,
        commands::models::cancel_download,
        commands::models::set_active_model,
        commands::models::get_current_model,
        commands::models::get_transcription_model_status,
        commands::models::is_model_loading,
        commands::models::has_any_models_available,
        commands::models::has_any_models_or_downloads,
        commands::models::get_recommended_first_model,
        commands::audio::get_available_microphones,
        commands::audio::set_selected_microphone,
        commands::audio::get_selected_microphone,
        commands::audio::get_available_output_devices,
        commands::audio::set_selected_output_device,
        commands::audio::get_selected_output_device,
        commands::audio::set_clamshell_microphone,
        commands::audio::get_clamshell_microphone,
        commands::audio::is_recording,
        commands::audio::request_system_audio_permission,
        commands::transcription::set_model_unload_timeout,
        commands::transcription::get_model_load_status,
        commands::transcription::unload_model_manually,
        commands::history::get_history_entries,
        commands::history::toggle_history_entry_saved,
        commands::history::delete_history_entry,
        commands::history::update_history_limit,
        commands::history::update_recording_retention_period,
        helpers::clamshell::is_laptop,
        commands::session::start_session,
        commands::session::start_session_recording,
        commands::session::stop_session_recording,
        commands::session::reactivate_session,
        commands::session::end_session,
        commands::session::search_sessions,
        commands::session::get_sessions,
        commands::session::get_session,
        commands::session::get_session_transcript,
        commands::session::get_active_session,
        commands::session::delete_session,
        commands::session::update_session_title,
        commands::session::update_session_environment,
        commands::session::get_meeting_notes,
        commands::session::save_meeting_notes,
        commands::session::save_user_notes,
        commands::session::save_enhanced_notes,
        commands::session::get_user_notes,
        commands::session::generate_session_summary,
        commands::session::generate_session_summary_stream,
        commands::session::get_session_summary,
        commands::session::flush_pending_audio,
        // Folder commands
        commands::session::create_folder,
        commands::session::update_folder,
        commands::session::delete_folder,
        commands::session::get_folders,
        commands::session::move_session_to_folder,
        commands::session::get_sessions_by_folder,
        // Tag commands
        commands::session::create_tag,
        commands::session::update_tag,
        commands::session::delete_tag,
        commands::session::get_tags,
        commands::session::add_tag_to_session,
        commands::session::remove_tag_from_session,
        commands::session::get_session_tags,
        commands::session::set_session_tags,
        commands::session::get_sessions_by_tag,
        // Attachment commands
        commands::session::add_attachment,
        commands::session::get_attachments,
        commands::session::get_attachment,
        commands::session::delete_attachment,
        commands::session::open_attachment,
        commands::session::extract_pdf_text,
        // Export commands
        commands::export::export_note_as_markdown,
        commands::export::export_all_notes_as_markdown,
    ]);

    #[cfg(debug_assertions)] // <- Only export on non-release builds
    specta_builder
        .export(
            Typescript::default().bigint(BigIntExportBehavior::Number),
            "../src/bindings.ts",
        )
        .expect("Failed to export typescript bindings");

    let builder = tauri::Builder::default().plugin(
        LogBuilder::new()
            .level(log::LevelFilter::Trace) // Set to most verbose level globally
            .max_file_size(500_000)
            .rotation_strategy(RotationStrategy::KeepAll)
            .clear_targets()
            .targets([
                // Console output respects RUST_LOG environment variable
                Target::new(TargetKind::Stdout).filter({
                    let console_filter = console_filter.clone();
                    move |metadata| console_filter.enabled(metadata)
                }),
                // File logs respect the user's settings (stored in FILE_LOG_LEVEL atomic)
                Target::new(TargetKind::LogDir {
                    file_name: Some("talky".into()),
                })
                .filter(|metadata| {
                    let file_level = FILE_LOG_LEVEL.load(Ordering::Relaxed);
                    metadata.level() <= level_filter_from_u8(file_level)
                }),
            ])
            .build(),
    );

    // Configure cross-platform plugins
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::SIZE,
                )
                .build(),
        );

    // Autostart plugin - MacosLauncher param only used on macOS, ignored on Windows/Linux
    let builder = builder.plugin(tauri_plugin_autostart::init(
        tauri_plugin_autostart::MacosLauncher::LaunchAgent,
        Some(vec![]),
    ));

    // Add macOS-specific plugins
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_plugin_macos_permissions::init());

    builder
        .setup(move |app| {
            let settings = get_settings(&app.handle());
            let tauri_log_level: tauri_plugin_log::LogLevel = settings.log_level.into();
            let file_log_level: log::Level = tauri_log_level.into();
            // Store the file log level in the atomic for the filter to use
            FILE_LOG_LEVEL.store(file_log_level.to_level_filter() as u8, Ordering::Relaxed);
            let app_handle = app.handle().clone();

            initialize_core_logic(&app_handle);

            // Set up application menu (macOS uses app-level menu bar)
            let app_menu = menu::create_app_menu(&app_handle);
            if let Err(e) = app_handle.set_menu(app_menu) {
                log::warn!("Failed to set menu: {}", e);
            }
            menu::setup_menu_events(&app_handle);

            // Show main window on startup
            if let Some(main_window) = app_handle.get_webview_window("main") {
                main_window.show().unwrap();
                main_window.set_focus().unwrap();
            }

            // Ensure pill window is hidden on startup (window-state may restore it)
            hide_pill_window(&app_handle);

            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                // Only handle main window close specially
                if window.label() == "main" {
                    #[cfg(target_os = "windows")]
                    {
                        // On Windows, close button should quit the app entirely
                        // The tray icon keeps the process alive, so we must explicitly exit
                        let _ = api; // Suppress unused warning
                        window.app_handle().exit(0);
                    }
                    #[cfg(not(target_os = "windows"))]
                    {
                        api.prevent_close();
                        let _ = window.hide();
                        // Show pill if currently recording (unless disabled by debug flag)
                        let settings = crate::settings::get_settings(&window.app_handle());
                        if !settings.debug_disable_pill_window {
                            let audio_manager =
                                window.app_handle().state::<Arc<AudioRecordingManager>>();
                            if audio_manager.is_recording() {
                                show_pill_window(&window.app_handle());
                            }
                        }
                    }
                }
            }
            tauri::WindowEvent::Focused(focused) => {
                if window.label() == "main" {
                    if *focused {
                        // Main window gained focus - hide the pill
                        hide_pill_window(&window.app_handle());
                    } else {
                        // Main window lost focus - show pill if recording (unless disabled by debug flag)
                        let settings = crate::settings::get_settings(&window.app_handle());
                        if !settings.debug_disable_pill_window {
                            let audio_manager =
                                window.app_handle().state::<Arc<AudioRecordingManager>>();
                            if audio_manager.is_recording() {
                                show_pill_window(&window.app_handle());
                            }
                        }
                    }
                }
            }
            tauri::WindowEvent::ThemeChanged(theme) => {
                log::info!("Theme changed to: {:?}", theme);
            }
            _ => {}
        })
        .invoke_handler(specta_builder.invoke_handler())
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Handle macOS dock icon click (Reopen event)
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                // Always show main window and hide pill when dock icon is clicked
                show_main_window(app_handle);
                hide_pill_window(app_handle);
            }

            // Suppress unused variable warning on non-macOS
            #[cfg(not(target_os = "macos"))]
            let _ = (app_handle, event);
        });
}
