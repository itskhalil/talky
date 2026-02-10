use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Wry};

pub fn create_app_menu(app: &AppHandle) -> Menu<Wry> {
    // macOS app menu (first menu, named after the app)
    #[cfg(target_os = "macos")]
    let app_menu = SubmenuBuilder::new(app, "Talky")
        .item(&PredefinedMenuItem::about(app, None, None).expect("Failed to build about"))
        .separator()
        .item(&PredefinedMenuItem::services(app, None).expect("Failed to build services"))
        .separator()
        .item(&PredefinedMenuItem::hide(app, None).expect("Failed to build hide"))
        .item(&PredefinedMenuItem::hide_others(app, None).expect("Failed to build hide others"))
        .item(&PredefinedMenuItem::show_all(app, None).expect("Failed to build show all"))
        .separator()
        .item(&PredefinedMenuItem::quit(app, None).expect("Failed to build quit"))
        .build()
        .expect("Failed to build app menu");

    // File menu with export options
    let export_current = MenuItemBuilder::with_id("export_current", "Export Current Note...")
        .build(app)
        .expect("Failed to build export current menu item");

    let export_all = MenuItemBuilder::with_id("export_all", "Export All Notes...")
        .build(app)
        .expect("Failed to build export all menu item");

    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&export_current)
        .item(&export_all)
        .separator()
        .item(&PredefinedMenuItem::close_window(app, None).expect("Failed to build close item"))
        .build()
        .expect("Failed to build File menu");

    // Edit menu with standard items
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None).expect("Failed to build undo"))
        .item(&PredefinedMenuItem::redo(app, None).expect("Failed to build redo"))
        .separator()
        .item(&PredefinedMenuItem::cut(app, None).expect("Failed to build cut"))
        .item(&PredefinedMenuItem::copy(app, None).expect("Failed to build copy"))
        .item(&PredefinedMenuItem::paste(app, None).expect("Failed to build paste"))
        .item(&PredefinedMenuItem::select_all(app, None).expect("Failed to build select all"))
        .build()
        .expect("Failed to build Edit menu");

    // View menu
    #[cfg(target_os = "macos")]
    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&PredefinedMenuItem::fullscreen(app, None).expect("Failed to build fullscreen"))
        .build()
        .expect("Failed to build View menu");

    // Window menu
    #[cfg(target_os = "macos")]
    let window_menu = SubmenuBuilder::new(app, "Window")
        .item(&PredefinedMenuItem::minimize(app, None).expect("Failed to build minimize"))
        .item(&PredefinedMenuItem::maximize(app, None).expect("Failed to build maximize"))
        .separator()
        .item(&PredefinedMenuItem::close_window(app, None).expect("Failed to build close"))
        .build()
        .expect("Failed to build Window menu");

    // Build the complete menu
    #[cfg(target_os = "macos")]
    {
        MenuBuilder::new(app)
            .item(&app_menu)
            .item(&file_menu)
            .item(&edit_menu)
            .item(&view_menu)
            .item(&window_menu)
            .build()
            .expect("Failed to build menu")
    }

    #[cfg(not(target_os = "macos"))]
    {
        MenuBuilder::new(app)
            .item(&file_menu)
            .item(&edit_menu)
            .build()
            .expect("Failed to build menu")
    }
}

pub fn setup_menu_events(app: &AppHandle) {
    let app_handle = app.clone();
    app.on_menu_event(move |_app, event| {
        let id = event.id().as_ref();
        match id {
            "export_current" => {
                let _ = app_handle.emit("menu-export-current", ());
            }
            "export_all" => {
                let _ = app_handle.emit("menu-export-all", ());
            }
            _ => {}
        }
    });
}
