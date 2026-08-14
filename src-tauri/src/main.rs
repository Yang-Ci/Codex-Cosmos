#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

fn main() {
    // WebKitGTK's Wayland backend renders the WebGPU black-hole canvas
    // incorrectly — the shadow / event horizon disappears even though the
    // WGSL compiles cleanly, so the Canvas2D fallback never triggers.
    // The AppImage already forces X11 via its AppRun hook; replicate that
    // for the installed .deb binary so .desktop launches and autostart
    // behave identically.  The AppImage sets GDK_BACKEND=x11 unconditionally,
    // so we do the same when a Wayland session is detected — overriding even
    // a desktop-environment default of "wayland" that breaks WebGPU rendering.
    #[cfg(target_os = "linux")]
    if std::env::var("WAYLAND_DISPLAY").is_ok()
    {
        std::env::set_var("GDK_BACKEND", "x11");
    }

    codex_cosmos_lib::run();
}
