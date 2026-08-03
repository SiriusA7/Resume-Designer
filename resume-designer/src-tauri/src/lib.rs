mod commands;

// `Manager` is used by the desktop `app.manage(...)` call in `setup` and by the
// macOS-only Reopen handler below. Gating to `desktop` keeps it out of mobile
// builds (where neither exists) without tripping an unused-import warning.
#[cfg(desktop)]
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_os::init())
        .manage(commands::PendingPdfPath::default())
        .manage(commands::PreviewPdfPath::default())
        .manage(commands::bridge::BridgePending::default())
        .setup(|app| {
            #[cfg(desktop)]
            {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
                app.manage(commands::updater::PendingUpdate::default());

                // Companion-extension bridge: loopback HTTP listener that
                // forwards requests to the webview (see commands/bridge.rs).
                commands::bridge::start(app.handle().clone());
            }

            // Add "Settings…" and "Check for Updates…" to the application
            // (app-name) menu, just under "About" and above the Services separator.
            // We start from the platform default menu so every standard item (Edit,
            // Window, Hide, Quit, …) is preserved, and only insert the two extra
            // items. Each click emits an event the frontend routes to the existing
            // flow (Settings dialog / manual update-check).
            //
            // macOS ONLY: on Windows/Linux Tauri renders app menus INSIDE the
            // window, which would stack an unexpected menu bar over the app's
            // custom header. Those platforms reach Settings / Check for Updates
            // through the in-app UI instead (Settings dialog + Updates tab).
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{Menu, MenuItem};
                use tauri::Emitter;
                let menu = Menu::default(app.handle())?;
                let settings = MenuItem::with_id(
                    app.handle(),
                    "open-settings",
                    "Settings…",
                    true,
                    None::<&str>,
                )?;
                let check_updates = MenuItem::with_id(
                    app.handle(),
                    "check-updates",
                    "Check for Updates…",
                    true,
                    None::<&str>,
                )?;
                let items = menu.items()?;
                if let Some(app_menu) = items.first().and_then(|item| item.as_submenu()) {
                    // Insert just under "About" (index 0): Settings…, then Check for Updates…
                    app_menu.insert(&settings, 1)?;
                    app_menu.insert(&check_updates, 2)?;
                }
                app.set_menu(menu)?;
                app.on_menu_event(|app_handle, event| match event.id().as_ref() {
                    "open-settings" => {
                        let _ = app_handle.emit("menu:open-settings", ());
                    }
                    "check-updates" => {
                        let _ = app_handle.emit("menu:check-updates", ());
                    }
                    _ => {}
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::pick_pdf_save_path,
            commands::capture_pdf_from_window,
            commands::read_pdf_preview,
            commands::save_pdf_preview,
            commands::discard_pdf_preview,
            commands::migration::probe_legacy_electron_data,
            commands::migration::import_legacy_electron_data,
            commands::storage::storage_load_all,
            commands::storage::storage_write,
            commands::storage::storage_delete,
            commands::storage::storage_clear,
            commands::secret::secret_get,
            commands::secret::secret_set,
            commands::bridge::bridge_respond,
            #[cfg(desktop)]
            commands::updater::check_update_on_channel,
            #[cfg(desktop)]
            commands::updater::install_pending_update
        ]);

    builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows,
                ..
            } = event
            {
                if !has_visible_windows {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
            let _ = (app_handle, event);
        });
}
