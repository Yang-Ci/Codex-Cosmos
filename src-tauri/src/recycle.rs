use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, State};
use crate::ecosystem::EcosystemState;

const MAX_DROP_ITEMS: usize = 64;
const MAX_HISTORY_ITEMS: usize = 20;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecycleBatch {
    pub paths: Vec<String>,
    pub names: Vec<String>,
    pub recycled_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecycleResult {
    pub count: usize,
    pub names: Vec<String>,
    pub recycled_at: i64,
}

#[derive(Default)]
pub struct RecycleState {
    history: Mutex<VecDeque<RecycleBatch>>,
}

impl RecycleState {
    pub fn load(app: &AppHandle) -> Self {
        let history = history_path(app)
            .ok()
            .and_then(|path| std::fs::read_to_string(path).ok())
            .and_then(|content| serde_json::from_str::<VecDeque<RecycleBatch>>(&content).ok())
            .unwrap_or_default();
        Self {
            history: Mutex::new(history),
        }
    }
}

#[tauri::command]
pub async fn move_to_trash(
    app: AppHandle,
    state: State<'_, RecycleState>,
    ecosystem: State<'_, EcosystemState>,
    paths: Vec<String>,
) -> Result<RecycleResult, String> {
    let safe_paths = validate_paths(&paths)?;
    let operation_paths = safe_paths.clone();
    tauri::async_runtime::spawn_blocking(move || platform_recycle(operation_paths))
        .await
        .map_err(|error| format!("回收任务异常结束：{error}"))?
        .map_err(|error| format!("系统回收站拒绝了操作：{error}"))?;

    let recycled_at = unix_timestamp();
    let names = safe_paths
        .iter()
        .map(|path| display_name(path))
        .collect::<Vec<_>>();
    let batch = RecycleBatch {
        paths: safe_paths
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect(),
        names: names.clone(),
        recycled_at,
    };

    {
        let mut history = state
            .history
            .lock()
            .map_err(|_| "回收历史暂时不可用".to_string())?;
        history.push_front(batch);
        history.truncate(MAX_HISTORY_ITEMS);
        save_history(&app, &history)?;
    }

    ecosystem.record_recycled(&app, safe_paths.len())?;

    Ok(RecycleResult {
        count: safe_paths.len(),
        names,
        recycled_at,
    })
}

#[tauri::command]
pub fn recent_recycles(state: State<'_, RecycleState>) -> Result<Vec<RecycleBatch>, String> {
    let history = state
        .history
        .lock()
        .map_err(|_| "回收历史暂时不可用".to_string())?;
    Ok(history.iter().cloned().collect())
}

#[tauri::command]
pub async fn restore_last_recycle(
    app: AppHandle,
    state: State<'_, RecycleState>,
) -> Result<RecycleResult, String> {
    let batch = {
        let history = state
            .history
            .lock()
            .map_err(|_| "回收历史暂时不可用".to_string())?;
        history
            .front()
            .cloned()
            .ok_or_else(|| "还没有可恢复的回收记录".to_string())?
    };
    let wanted = batch
        .paths
        .iter()
        .map(PathBuf::from)
        .collect::<Vec<_>>();

    tauri::async_runtime::spawn_blocking(move || {
        let available = trash::os_limited::list()
            .map_err(|error| format!("无法读取系统回收站：{error}"))?;
        let mut matches = Vec::new();
        for path in &wanted {
            let wanted_name = path.file_name();
            let candidate = available
                .iter()
                .filter(|item| {
                    item.original_path() == *path
                        || (wanted_name.is_some_and(|name| item.name.as_os_str() == name)
                            && (item.time_deleted - batch.recycled_at).abs() <= 120)
                })
                .max_by_key(|item| item.time_deleted)
                .cloned()
                .ok_or_else(|| format!("回收站中找不到 {}", display_name(path)))?;
            matches.push(candidate);
        }
        trash::os_limited::restore_all(matches)
            .map_err(|error| format!("系统无法恢复文件：{error}"))
    })
    .await
    .map_err(|error| format!("恢复任务异常结束：{error}"))??;

    {
        let mut history = state
            .history
            .lock()
            .map_err(|_| "回收历史暂时不可用".to_string())?;
        history.pop_front();
        save_history(&app, &history)?;
    }

    Ok(RecycleResult {
        count: batch.paths.len(),
        names: batch.names,
        recycled_at: batch.recycled_at,
    })
}

#[tauri::command]
pub fn open_recycle_bin() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer.exe")
            .arg("shell:RecycleBinFolder")
            .spawn()
            .map_err(|error| format!("无法打开 Windows 回收站：{error}"))?;
        return Ok(());
    }

    #[cfg(target_os = "linux")]
    {
        let gio = Command::new("gio").args(["open", "trash:///"]).spawn();
        if gio.is_ok() {
            return Ok(());
        }
        Command::new("xdg-open")
            .arg("trash:///")
            .spawn()
            .map_err(|error| format!("无法打开 Linux 回收站：{error}"))?;
        return Ok(());
    }

    #[allow(unreachable_code)]
    Err("当前系统暂不支持打开回收站".into())
}

fn validate_paths(paths: &[String]) -> Result<Vec<PathBuf>, String> {
    if paths.is_empty() {
        return Err("没有收到文件或文件夹".into());
    }
    if paths.len() > MAX_DROP_ITEMS {
        return Err(format!("一次最多回收 {MAX_DROP_ITEMS} 个项目"));
    }
    paths.iter().map(|path| validate_path(Path::new(path))).collect()
}

#[cfg(target_os = "windows")]
fn platform_recycle(paths: Vec<PathBuf>) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        core::PCWSTR,
        Win32::{
            System::Com::{
                CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
                COINIT_APARTMENTTHREADED,
            },
            UI::Shell::{
                FileOperation, IFileOperation, IShellItem, SHCreateItemFromParsingName,
                FOFX_EARLYFAILURE, FOFX_RECYCLEONDELETE, FOF_NOCONFIRMATION, FOF_NOERRORUI,
                FOF_SILENT,
            },
        },
    };

    struct ComApartment;
    impl Drop for ComApartment {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }

    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
        .ok()
        .map_err(|error| format!("COM 初始化失败：{error}"))?;
    let _apartment = ComApartment;
    let operation: IFileOperation =
        unsafe { CoCreateInstance(&FileOperation, None, CLSCTX_INPROC_SERVER) }
            .map_err(|error| format!("无法创建系统文件操作：{error}"))?;

    unsafe {
        operation
            .SetOperationFlags(
                FOFX_RECYCLEONDELETE
                    | FOFX_EARLYFAILURE
                    | FOF_NOCONFIRMATION
                    | FOF_NOERRORUI
                    | FOF_SILENT,
            )
            .map_err(|error| format!("无法启用安全回收模式：{error}"))?;
        for path in paths {
            // `std::fs::canonicalize` returns verbatim paths (`\\?\C:\...`) on Windows.
            // IFileOperation's shell parser expects the regular DOS/UNC spelling instead.
            let shell_path = windows_shell_path(&path);
            let wide = shell_path
                .as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect::<Vec<_>>();
            let item: IShellItem = SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None)
                .map_err(|error| format!("系统无法识别 {}：{error}", shell_path.display()))?;
            operation
                .DeleteItem(&item, None)
                .map_err(|error| format!("无法加入回收队列 {}：{error}", shell_path.display()))?;
        }
        operation
            .PerformOperations()
            .map_err(|error| format!("系统回收操作失败：{error}"))?;
        if operation
            .GetAnyOperationsAborted()
            .map_err(|error| format!("无法确认回收结果：{error}"))?
            .as_bool()
        {
            return Err("系统取消了回收操作，原文件保持不变".into());
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn windows_shell_path(path: &Path) -> PathBuf {
    let value = path.as_os_str().to_string_lossy();
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = value.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        path.to_path_buf()
    }
}

#[cfg(not(target_os = "windows"))]
fn platform_recycle(paths: Vec<PathBuf>) -> Result<(), String> {
    trash::delete_all(paths).map_err(|error| error.to_string())
}

fn validate_path(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("只接受来自文件管理器的绝对路径".into());
    }
    if !path.exists() {
        return Err(format!("{} 已不存在", display_name(path)));
    }
    let raw_path = path.to_string_lossy();
    let is_unc = raw_path.starts_with(r"\\") && !raw_path.starts_with(r"\\?\");
    let is_verbatim_unc = raw_path.starts_with(r"\\?\UNC\");
    if is_unc || is_verbatim_unc {
        return Err("网络路径不能安全移入本机回收站".into());
    }

    let canonical = path
        .canonicalize()
        .map_err(|_| format!("无法解析路径：{}", path.display()))?;
    if canonical.file_name().is_none() {
        return Err("磁盘或文件系统根目录不能回收".into());
    }
    let metadata = std::fs::metadata(&canonical)
        .map_err(|_| format!("无法读取 {} 的信息", display_name(path)))?;
    if !(metadata.is_file() || metadata.is_dir()) {
        return Err("只支持普通文件和文件夹".into());
    }

    if let Ok(current_exe) = std::env::current_exe().and_then(|value| value.canonicalize()) {
        if canonical == current_exe {
            return Err("Codex Cosmos 不能回收正在运行的自己".into());
        }
    }

    #[cfg(target_os = "windows")]
    validate_windows_path(&canonical)?;
    #[cfg(target_os = "linux")]
    validate_linux_path(&canonical)?;

    #[cfg(target_os = "windows")]
    return Ok(windows_shell_path(&canonical));

    #[cfg(not(target_os = "windows"))]
    Ok(canonical)
}

#[cfg(target_os = "windows")]
fn validate_windows_path(path: &Path) -> Result<(), String> {
    if path.components().any(|part| {
        part.as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case("$Recycle.Bin")
    }) {
        return Err("该项目已经在回收站中".into());
    }
    if let Ok(windows_dir) = std::env::var("WINDIR") {
        if let Ok(windows_dir) = Path::new(&windows_dir).canonicalize() {
            if path.starts_with(windows_dir) {
                return Err("Windows 系统目录受到保护".into());
            }
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn validate_linux_path(path: &Path) -> Result<(), String> {
    const PROTECTED: &[&str] = &[
        "/bin", "/boot", "/dev", "/etc", "/lib", "/lib64", "/proc", "/run", "/sbin",
        "/sys", "/usr",
    ];
    if PROTECTED.iter().any(|root| path.starts_with(root)) {
        return Err("Linux 系统目录受到保护".into());
    }
    if path.components().any(|part| part.as_os_str() == "Trash")
        && path.to_string_lossy().contains("/.local/share/Trash/")
    {
        return Err("该项目已经在回收站中".into());
    }
    Ok(())
}

fn history_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))?;
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("无法创建应用数据目录：{error}"))?;
    Ok(directory.join("recycle-history.json"))
}

fn save_history(app: &AppHandle, history: &VecDeque<RecycleBatch>) -> Result<(), String> {
    let content = serde_json::to_string_pretty(history)
        .map_err(|error| format!("无法保存回收历史：{error}"))?;
    std::fs::write(history_path(app)?, content)
        .map_err(|error| format!("无法写入回收历史：{error}"))
}

fn display_name(path: &Path) -> String {
    path.file_name()
        .unwrap_or(path.as_os_str())
        .to_string_lossy()
        .into_owned()
}

fn unix_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_drop() {
        assert!(validate_paths(&[]).is_err());
    }

    #[test]
    fn rejects_relative_path() {
        assert!(validate_path(Path::new("relative-file.txt")).is_err());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn converts_verbatim_windows_paths_for_shell_parsing() {
        assert_eq!(
            windows_shell_path(Path::new(r"\\?\C:\Users\Codex\Desktop\sample.txt")),
            PathBuf::from(r"C:\Users\Codex\Desktop\sample.txt")
        );
        assert_eq!(
            windows_shell_path(Path::new(r"\\?\UNC\server\share\sample.txt")),
            PathBuf::from(r"\\server\share\sample.txt")
        );
    }

    #[test]
    fn accepts_existing_regular_file_without_deleting_it() {
        let path = std::env::temp_dir().join(format!(
            "codex-cosmos-validation-{}-{}.txt",
            std::process::id(),
            unix_timestamp()
        ));
        std::fs::write(&path, b"safe validation fixture").expect("create fixture");
        let validated = validate_path(&path).expect("fixture should validate");
        assert!(validated.exists());
        std::fs::remove_file(path).expect("remove fixture");
    }

    #[test]
    fn system_trash_roundtrip_for_owned_fixture() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let path = std::env::current_dir().expect("current directory").join(format!(
            "codex-cosmos-recycle-roundtrip-{}-{unique}.txt",
            std::process::id()
        ));
        std::fs::write(&path, b"Codex Cosmos recycle roundtrip fixture")
            .expect("create roundtrip fixture");

        let validated = validate_path(&path).expect("validate and normalize roundtrip fixture");
        platform_recycle(vec![validated]).expect("move owned fixture to system trash");
        assert!(!path.exists(), "fixture should leave its original path");

        let item = trash::os_limited::list()
            .expect("list system trash")
            .into_iter()
            .filter(|item| {
                item.original_path() == path
                    || item.name.as_os_str() == path.file_name().expect("fixture filename")
            })
            .max_by_key(|item| item.time_deleted)
            .expect("find fixture in system trash");
        trash::os_limited::restore_all([item]).expect("restore owned fixture");
        assert!(path.exists(), "fixture should be restored to its original path");
        std::fs::remove_file(path).expect("remove restored fixture");
    }
}
