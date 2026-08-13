mod desktop_capture;
mod ecosystem;
mod quota;
mod recycle;

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager,
};
use tauri_plugin_autostart::MacosLauncher;

#[tauri::command]
fn get_pulse_data(app: tauri::AppHandle) -> Result<quota::PulseData, String> {
    quota::collect_pulse_data(&app)
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .setup(|app| {
            app.manage(recycle::RecycleState::load(app.handle()));
            app.manage(ecosystem::EcosystemState::load(app.handle()));
            let show = MenuItem::with_id(app, "show", "显示 Codex Cosmos", true, None::<&str>)?;
            let refresh = MenuItem::with_id(app, "refresh", "刷新额度", true, None::<&str>)?;
            let recycle_bin = MenuItem::with_id(app, "recycle-bin", "打开回收站", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &refresh, &recycle_bin, &quit])?;

            let mut tray_builder = TrayIconBuilder::with_id("main-tray");
            if let Some(icon) = app.default_window_icon().cloned() {
                tray_builder = tray_builder.icon(icon);
            }

            tray_builder
                .tooltip("Codex Cosmos")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                    "refresh" => {
                        let _ = app.emit("quota-refresh-requested", ());
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                        }
                    }
                    "recycle-bin" => {
                        let _ = recycle::open_recycle_bin();
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            if let Some(window) = app.get_webview_window("main") {
                desktop_capture::exclude_window_from_capture(&window);
                let window_clone = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = window_clone.hide();
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_pulse_data,
            quit_app,
            recycle::move_to_trash,
            recycle::recent_recycles,
            recycle::restore_last_recycle,
            recycle::open_recycle_bin,
            desktop_capture::capture_desktop_under_widget,
            desktop_capture::effect_capabilities,
            ecosystem::ecosystem_stats,
            ecosystem::set_wormhole_destination,
            ecosystem::set_forge_destination,
            ecosystem::move_through_wormhole,
            ecosystem::forge_files,
            ecosystem::clipboard_text,
            ecosystem::set_clipboard_text
        ])
        .run(tauri::generate_context!())
        .expect("error while running Codex Cosmos");
}
