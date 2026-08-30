use serde::Serialize;
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopFrame {
    width: u32,
    height: u32,
    rgba: Vec<u8>,
    monitor_name: Option<String>,
    scale_factor: f64,
    capture_backend: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectCapabilities {
    platform: &'static str,
    session: String,
    desktop_capture: bool,
    programmatic_positioning: bool,
    always_on_top_supported: bool,
    fallback_reason: Option<String>,
}

#[tauri::command]
pub fn effect_capabilities() -> EffectCapabilities {
    #[cfg(target_os = "windows")]
    return EffectCapabilities {
        platform: "windows",
        session: "desktop".into(),
        desktop_capture: true,
        programmatic_positioning: true,
        always_on_top_supported: true,
        fallback_reason: None,
    };

    #[cfg(target_os = "linux")]
    {
        let session = std::env::var("XDG_SESSION_TYPE").unwrap_or_else(|_| "unknown".into());
        let wayland = session.eq_ignore_ascii_case("wayland")
            || std::env::var_os("WAYLAND_DISPLAY").is_some();
        return EffectCapabilities {
            platform: "linux",
            session,
            desktop_capture: false,
            programmatic_positioning: !wayland,
            always_on_top_supported: !wayland,
            fallback_reason: Some(if wayland {
                "Wayland 安全策略禁止无授权桌面采样，并可能限制窗口定位；使用内置星场与局部粒子"
                    .into()
            } else {
                "Linux 当前使用内置星场与局部粒子，避免依赖桌面合成器私有接口".into()
            }),
        };
    }

    #[cfg(target_os = "macos")]
    EffectCapabilities {
        platform: "macos",
        session: "quartz".into(),
        desktop_capture: false,
        programmatic_positioning: true,
        always_on_top_supported: true,
        fallback_reason: Some("macOS 当前使用内置星场与局部粒子".into()),
    }
}

#[tauri::command]
pub fn capture_desktop_under_widget(app: AppHandle) -> Result<DesktopFrame, String> {
    #[cfg(target_os = "windows")]
    {
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "找不到桌面组件窗口".to_string())?;
        let position = window
            .outer_position()
            .map_err(|error| format!("无法读取组件位置：{error}"))?;
        let size = window
            .outer_size()
            .map_err(|error| format!("无法读取组件尺寸：{error}"))?;
        let monitor = window.current_monitor().ok().flatten();
        let monitor_name = monitor.as_ref().and_then(|value| value.name().cloned());
        let scale_factor = monitor.as_ref().map(|value| value.scale_factor()).unwrap_or(1.0);
        return capture_windows(
            position.x,
            position.y,
            size.width,
            size.height,
            monitor_name,
            scale_factor,
        );
    }

    #[cfg(not(target_os = "windows"))]
    Err("当前平台使用内置引力星场".into())
}

#[cfg(target_os = "windows")]
fn capture_windows(
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    monitor_name: Option<String>,
    scale_factor: f64,
) -> Result<DesktopFrame, String> {
    use std::ffi::c_void;
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS,
        HGDIOBJ, SRCCOPY,
    };

    if width == 0 || height == 0 || width > 512 || height > 512 {
        return Err("仅在黑洞待机尺寸下采集桌面".into());
    }

    unsafe {
        let screen = GetDC(None);
        if screen.is_invalid() {
            return Err("无法连接桌面画布".into());
        }
        let memory = CreateCompatibleDC(Some(screen));
        if memory.is_invalid() {
            ReleaseDC(None, screen);
            return Err("无法创建桌面采集画布".into());
        }
        let bitmap = CreateCompatibleBitmap(screen, width as i32, height as i32);
        if bitmap.is_invalid() {
            let _ = DeleteDC(memory);
            ReleaseDC(None, screen);
            return Err("无法创建桌面采集位图".into());
        }
        let previous = SelectObject(memory, HGDIOBJ(bitmap.0));
        let copied = BitBlt(
            memory,
            0,
            0,
            width as i32,
            height as i32,
            Some(screen),
            x,
            y,
            SRCCOPY,
        )
        .is_ok();

        let mut pixels = vec![0_u8; width as usize * height as usize * 4];
        let mut info = BITMAPINFO::default();
        info.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width as i32,
            biHeight: -(height as i32),
            biPlanes: 1,
            biBitCount: 32,
            ..Default::default()
        };
        let lines = if copied {
            GetDIBits(
                memory,
                bitmap,
                0,
                height,
                Some(pixels.as_mut_ptr().cast::<c_void>()),
                &mut info,
                DIB_RGB_COLORS,
            )
        } else {
            0
        };

        SelectObject(memory, previous);
        let _ = DeleteObject(HGDIOBJ(bitmap.0));
        let _ = DeleteDC(memory);
        ReleaseDC(None, screen);

        if lines == 0 {
            return Err("桌面画面采集失败".into());
        }
        for pixel in pixels.chunks_exact_mut(4) {
            pixel.swap(0, 2);
            pixel[3] = 255;
        }
        Ok(DesktopFrame {
            width,
            height,
            rgba: pixels,
            monitor_name,
            scale_factor,
            capture_backend: "windows-gdi",
        })
    }
}

#[cfg(target_os = "windows")]
pub fn exclude_window_from_capture(window: &tauri::WebviewWindow) {
    let _ = apply_capture_exclusion(window, true);
}

#[cfg(not(target_os = "windows"))]
pub fn exclude_window_from_capture(_window: &tauri::WebviewWindow) {}

/// 前端按设置动态开关窗口截图隔离：true 排除（黑洞透镜采到真实桌面），
/// false 恢复正常可被截图与录屏，但透镜会显示自身界面。
#[tauri::command]
pub fn set_window_capture_exclusion(app: AppHandle, enabled: bool) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "找不到桌面组件窗口".to_string())?;
    apply_capture_exclusion(&window, enabled)
}

#[cfg(target_os = "windows")]
fn apply_capture_exclusion(window: &tauri::WebviewWindow, enabled: bool) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE, WDA_NONE,
    };
    let hwnd = window
        .hwnd()
        .map_err(|error| format!("无法读取窗口句柄：{error}"))?;
    let affinity = if enabled { WDA_EXCLUDEFROMCAPTURE } else { WDA_NONE };
    unsafe { SetWindowDisplayAffinity(hwnd, affinity) }
        .map_err(|error| format!("无法更新窗口截图隔离：{error}"))
}

#[cfg(not(target_os = "windows"))]
fn apply_capture_exclusion(_window: &tauri::WebviewWindow, _enabled: bool) -> Result<(), String> {
    Ok(())
}
