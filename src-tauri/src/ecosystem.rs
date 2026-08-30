use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, State};

const MAX_WORMHOLE_ITEMS: usize = 32;
const MAX_ZIP_ENTRIES: usize = 10_000;
const MAX_EXTRACTED_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EcosystemStats {
    pub total_recycled: u64,
    pub total_wormhole_moves: u64,
    #[serde(default)]
    pub total_forged: u64,
    pub wormhole_destination: String,
    #[serde(default = "default_destination_string")]
    pub forge_destination: String,
}

#[derive(Default)]
pub struct EcosystemState {
    stats: Mutex<EcosystemStats>,
}

impl Default for EcosystemStats {
    fn default() -> Self {
        let destination = default_destination_string();
        Self {
            total_recycled: 0,
            total_wormhole_moves: 0,
            total_forged: 0,
            wormhole_destination: destination.clone(),
            forge_destination: destination,
        }
    }
}

fn default_destination_string() -> String {
    dirs::download_dir()
        .or_else(dirs::document_dir)
        .unwrap_or_else(std::env::temp_dir)
        .to_string_lossy()
        .into_owned()
}

impl EcosystemState {
    pub fn load(app: &AppHandle) -> Self {
        let stats = state_path(app)
            .ok()
            .and_then(|path| fs::read_to_string(path).ok())
            .and_then(|content| serde_json::from_str(&content).ok())
            .unwrap_or_default();
        Self {
            stats: Mutex::new(stats),
        }
    }

    pub fn record_recycled(&self, app: &AppHandle, count: usize) -> Result<u64, String> {
        let mut stats = self.stats.lock().map_err(|_| "生态统计暂不可用".to_string())?;
        stats.total_recycled = stats.total_recycled.saturating_add(count as u64);
        save_state(app, &stats)?;
        Ok(stats.total_recycled)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WormholeResult {
    pub count: usize,
    pub names: Vec<String>,
    pub destination: String,
    pub moved_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeResult {
    pub count: usize,
    pub names: Vec<String>,
    pub destination: String,
    pub forged_at: i64,
}

#[tauri::command]
pub fn ecosystem_stats(state: State<'_, EcosystemState>) -> Result<EcosystemStats, String> {
    state
        .stats
        .lock()
        .map(|stats| stats.clone())
        .map_err(|_| "生态统计暂不可用".to_string())
}

#[tauri::command]
pub fn set_wormhole_destination(
    app: AppHandle,
    state: State<'_, EcosystemState>,
    destination: String,
) -> Result<EcosystemStats, String> {
    let path = PathBuf::from(destination.trim());
    if !path.is_absolute() || !path.is_dir() {
        return Err("虫洞目标必须是已经存在的绝对目录".into());
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("无法解析虫洞目标：{error}"))?;
    let mut stats = state.stats.lock().map_err(|_| "生态统计暂不可用".to_string())?;
    stats.wormhole_destination = shell_path(&canonical).to_string_lossy().into_owned();
    save_state(&app, &stats)?;
    Ok(stats.clone())
}

#[tauri::command]
pub fn set_forge_destination(
    app: AppHandle,
    state: State<'_, EcosystemState>,
    destination: String,
) -> Result<EcosystemStats, String> {
    let path = PathBuf::from(destination.trim());
    if !path.is_absolute() || !path.is_dir() {
        return Err("星炉目标必须是已经存在的绝对目录".into());
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("无法解析星炉目标：{error}"))?;
    let mut stats = state.stats.lock().map_err(|_| "生态统计暂不可用".to_string())?;
    stats.forge_destination = shell_path(&canonical).to_string_lossy().into_owned();
    save_state(&app, &stats)?;
    Ok(stats.clone())
}

#[tauri::command]
pub async fn move_through_wormhole(
    app: AppHandle,
    state: State<'_, EcosystemState>,
    paths: Vec<String>,
) -> Result<WormholeResult, String> {
    if paths.is_empty() || paths.len() > MAX_WORMHOLE_ITEMS {
        return Err(format!("虫洞一次支持 1–{MAX_WORMHOLE_ITEMS} 个项目"));
    }
    let destination = {
        let stats = state.stats.lock().map_err(|_| "生态统计暂不可用".to_string())?;
        PathBuf::from(&stats.wormhole_destination)
    };
    if !destination.is_dir() {
        return Err("虫洞目标目录已不存在，请在设置中重新指定".into());
    }
    let sources = paths
        .iter()
        .map(PathBuf::from)
        .map(|path| validate_move_source(&path, &destination))
        .collect::<Result<Vec<_>, _>>()?;
    let destination_clone = destination.clone();
    let names = tauri::async_runtime::spawn_blocking(move || {
        sources
            .iter()
            .map(|source| move_one(source, &destination_clone))
            .collect::<Result<Vec<_>, _>>()
    })
    .await
    .map_err(|error| format!("虫洞移动任务异常结束：{error}"))??;

    {
        let mut stats = state.stats.lock().map_err(|_| "生态统计暂不可用".to_string())?;
        stats.total_wormhole_moves = stats.total_wormhole_moves.saturating_add(names.len() as u64);
        save_state(&app, &stats)?;
    }
    Ok(WormholeResult {
        count: names.len(),
        names,
        destination: destination.to_string_lossy().into_owned(),
        moved_at: unix_timestamp(),
    })
}

#[tauri::command]
pub async fn forge_files(
    app: AppHandle,
    state: State<'_, EcosystemState>,
    paths: Vec<String>,
) -> Result<ForgeResult, String> {
    if paths.is_empty() || paths.len() > MAX_WORMHOLE_ITEMS {
        return Err(format!("星炉一次支持 1–{MAX_WORMHOLE_ITEMS} 个项目"));
    }
    let destination = {
        let stats = state.stats.lock().map_err(|_| "生态统计暂不可用".to_string())?;
        PathBuf::from(&stats.forge_destination)
    };
    if !destination.is_dir() {
        return Err("星炉输出目录已不存在，请在设置中重新指定".into());
    }
    let sources = paths
        .iter()
        .map(PathBuf::from)
        .map(|path| validate_forge_source(&path, &destination))
        .collect::<Result<Vec<_>, _>>()?;
    let destination_clone = destination.clone();
    let output_paths = tauri::async_runtime::spawn_blocking(move || {
        let mut created = Vec::new();
        for source in &sources {
            match forge_one(source, &destination_clone) {
                Ok(output) => created.push(output),
                Err(error) => {
                    for output in created.iter().rev() {
                        remove_output(output);
                    }
                    return Err(error);
                }
            }
        }
        Ok(created)
    })
    .await
    .map_err(|error| format!("星炉任务异常结束：{error}"))??;

    {
        let mut stats = state.stats.lock().map_err(|_| "生态统计暂不可用".to_string())?;
        stats.total_forged = stats.total_forged.saturating_add(output_paths.len() as u64);
        save_state(&app, &stats)?;
    }
    let names = output_paths
        .iter()
        .filter_map(|path| path.file_name())
        .map(|name| name.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    Ok(ForgeResult {
        count: names.len(),
        names,
        destination: shell_path(&destination).to_string_lossy().into_owned(),
        forged_at: unix_timestamp(),
    })
}

#[tauri::command]
pub fn clipboard_text() -> Result<String, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|error| format!("无法连接剪贴板：{error}"))?;
    clipboard.get_text().map_err(|_| "剪贴板中没有文本".into())
}

#[tauri::command]
pub fn set_clipboard_text(text: String) -> Result<(), String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|error| format!("无法连接剪贴板：{error}"))?;
    clipboard
        .set_text(text)
        .map_err(|error| format!("无法写入剪贴板：{error}"))
}

fn validate_move_source(path: &Path, destination: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() || !path.exists() {
        return Err(format!("移动源不存在：{}", path.display()));
    }
    if path.symlink_metadata().map(|metadata| metadata.file_type().is_symlink()).unwrap_or(false) {
        return Err("为避免跨平台链接歧义，虫洞暂不移动符号链接".into());
    }
    let source = path.canonicalize().map_err(|error| format!("无法解析移动源：{error}"))?;
    let destination = destination
        .canonicalize()
        .map_err(|error| format!("无法解析虫洞目标：{error}"))?;
    if source.file_name().is_none() || destination.starts_with(&source) {
        return Err("不能移动磁盘根目录，也不能把目录移动进它自己".into());
    }
    if source.parent() == Some(destination.as_path()) {
        return Err(format!("{} 已在虫洞目标中", source.display()));
    }
    Ok(shell_path(&source))
}

fn validate_forge_source(path: &Path, destination: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() || !path.exists() {
        return Err(format!("锻造源不存在：{}", path.display()));
    }
    if path.symlink_metadata().map(|metadata| metadata.file_type().is_symlink()).unwrap_or(false) {
        return Err("为避免递归链接，星炉暂不锻造符号链接".into());
    }
    let source = path.canonicalize().map_err(|error| format!("无法解析锻造源：{error}"))?;
    let destination = destination
        .canonicalize()
        .map_err(|error| format!("无法解析星炉目标：{error}"))?;
    if source.file_name().is_none() || destination.starts_with(&source) {
        return Err("不能锻造磁盘根目录，也不能把输出目录放在锻造源内部".into());
    }
    Ok(shell_path(&source))
}

fn move_one(source: &Path, destination: &Path) -> Result<String, String> {
    let file_name = source
        .file_name()
        .ok_or_else(|| "移动源没有文件名".to_string())?;
    let target = unique_target(destination, file_name);
    if fs::rename(source, &target).is_err() {
        if source.is_dir() {
            if let Err(error) = copy_directory(source, &target) {
                let _ = fs::remove_dir_all(&target);
                return Err(error);
            }
            fs::remove_dir_all(source).map_err(|error| format!("复制完成但无法移除原目录：{error}"))?;
        } else {
            if let Err(error) = copy_file_contents(source, &target) {
                let _ = fs::remove_file(&target);
                return Err(error);
            }
            fs::remove_file(source).map_err(|error| format!("复制完成但无法移除原文件：{error}"))?;
        }
    }
    Ok(target.file_name().unwrap_or(file_name).to_string_lossy().into_owned())
}

fn forge_one(source: &Path, destination: &Path) -> Result<PathBuf, String> {
    let is_zip = source.is_file()
        && source.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("zip"));
    if is_zip {
        extract_zip(source, destination)
    } else {
        compress_to_zip(source, destination)
    }
}

fn compress_to_zip(source: &Path, destination: &Path) -> Result<PathBuf, String> {
    let stem = source
        .file_stem()
        .or_else(|| source.file_name())
        .ok_or_else(|| "压缩源没有文件名".to_string())?
        .to_string_lossy();
    let target = unique_target(destination, std::ffi::OsStr::new(&format!("{stem}.zip")));
    let result = (|| -> Result<(), String> {
        let output = fs::File::create(&target).map_err(|error| format!("无法创建 ZIP：{error}"))?;
        let mut archive = zip::ZipWriter::new(output);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .unix_permissions(0o644);
        let base = source.parent().ok_or_else(|| "无法确定压缩根目录".to_string())?;
        for entry in walkdir::WalkDir::new(source).follow_links(false) {
            let entry = entry.map_err(|error| format!("无法读取压缩源：{error}"))?;
            if entry.file_type().is_symlink() {
                return Err(format!("压缩源包含符号链接，已安全停止：{}", entry.path().display()));
            }
            let relative = entry
                .path()
                .strip_prefix(base)
                .map_err(|error| format!("无法生成 ZIP 路径：{error}"))?;
            let name = relative.to_string_lossy().replace('\\', "/");
            if entry.file_type().is_dir() {
                archive
                    .add_directory(format!("{name}/"), options)
                    .map_err(|error| format!("无法写入 ZIP 目录：{error}"))?;
            } else if entry.file_type().is_file() {
                archive
                    .start_file(name, options)
                    .map_err(|error| format!("无法写入 ZIP 文件头：{error}"))?;
                let mut input = fs::File::open(entry.path())
                    .map_err(|error| format!("无法读取待压缩文件：{error}"))?;
                io::copy(&mut input, &mut archive)
                    .map_err(|error| format!("写入 ZIP 数据失败：{error}"))?;
            }
        }
        archive.finish().map_err(|error| format!("完成 ZIP 失败：{error}"))?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&target);
        return Err(error);
    }
    Ok(target)
}

fn extract_zip(source: &Path, destination: &Path) -> Result<PathBuf, String> {
    let stem = source
        .file_stem()
        .ok_or_else(|| "ZIP 没有有效文件名".to_string())?;
    let target = unique_target(destination, stem);
    let result = (|| -> Result<(), String> {
        let input = fs::File::open(source).map_err(|error| format!("无法打开 ZIP：{error}"))?;
        let mut archive = zip::ZipArchive::new(input).map_err(|error| format!("ZIP 格式无效：{error}"))?;
        if archive.len() > MAX_ZIP_ENTRIES {
            return Err(format!("ZIP 条目过多，最多允许 {MAX_ZIP_ENTRIES} 个"));
        }
        let mut total_size = 0_u64;
        for index in 0..archive.len() {
            let entry = archive.by_index(index).map_err(|error| format!("无法检查 ZIP：{error}"))?;
            if entry.enclosed_name().is_none() {
                return Err("ZIP 包含越界路径，已拒绝解压".into());
            }
            if entry.unix_mode().is_some_and(|mode| mode & 0o170000 == 0o120000) {
                return Err("ZIP 包含符号链接，已拒绝解压".into());
            }
            total_size = total_size.saturating_add(entry.size());
            if total_size > MAX_EXTRACTED_BYTES {
                return Err("ZIP 解压后超过 2 GB 安全上限".into());
            }
        }
        fs::create_dir_all(&target).map_err(|error| format!("无法创建解压目录：{error}"))?;
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).map_err(|error| format!("无法读取 ZIP 条目：{error}"))?;
            let relative = entry.enclosed_name().ok_or_else(|| "ZIP 包含越界路径".to_string())?;
            let output = target.join(relative);
            if entry.is_dir() {
                fs::create_dir_all(&output).map_err(|error| format!("无法创建解压目录：{error}"))?;
                continue;
            }
            if let Some(parent) = output.parent() {
                fs::create_dir_all(parent).map_err(|error| format!("无法创建解压目录：{error}"))?;
            }
            let mut file = fs::File::create(&output).map_err(|error| format!("无法创建解压文件：{error}"))?;
            io::copy(&mut entry, &mut file).map_err(|error| format!("写入解压文件失败：{error}"))?;
            file.flush().map_err(|error| format!("刷新解压文件失败：{error}"))?;
        }
        Ok(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_dir_all(&target);
        return Err(error);
    }
    Ok(target)
}

fn remove_output(path: &Path) {
    if path.is_dir() {
        let _ = fs::remove_dir_all(path);
    } else {
        let _ = fs::remove_file(path);
    }
}

fn copy_directory(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir(target).map_err(|error| format!("无法创建目标目录：{error}"))?;
    for entry in fs::read_dir(source).map_err(|error| format!("无法读取源目录：{error}"))? {
        let entry = entry.map_err(|error| format!("无法读取目录项：{error}"))?;
        let child_target = target.join(entry.file_name());
        let file_type = entry.file_type().map_err(|error| format!("无法识别目录项类型：{error}"))?;
        if file_type.is_symlink() {
            return Err(format!("目录中包含符号链接，已安全停止：{}", entry.path().display()));
        }
        if file_type.is_dir() {
            copy_directory(&entry.path(), &child_target)?;
        } else if file_type.is_file() {
            copy_file_contents(&entry.path(), &child_target)?;
        } else {
            return Err(format!("目录中包含不支持的文件类型：{}", entry.path().display()));
        }
    }
    preserve_permissions(source, target);
    Ok(())
}

// Do not use fs::copy here. On Linux it may use kernel copy optimizations and
// copy permission metadata that some FUSE, network, NTFS, and exFAT mounts do
// not support. A userspace read/write loop is slower, but it is a dependable
// fallback after rename reports that a move crosses filesystem boundaries.
fn copy_file_contents(source: &Path, target: &Path) -> Result<(), String> {
    let mut input = fs::File::open(source)
        .map_err(|error| format!("无法读取源文件 {}：{error}", source.display()))?;
    let mut output = create_copy_target(target)
        .map_err(|error| format!("无法创建目标文件 {}：{error}", target.display()))?;
    let mut buffer = vec![0_u8; 128 * 1024];
    loop {
        let count = input
            .read(&mut buffer)
            .map_err(|error| format!("读取源文件 {} 失败：{error}", source.display()))?;
        if count == 0 {
            break;
        }
        output
            .write_all(&buffer[..count])
            .map_err(|error| format!("写入目标文件 {} 失败：{error}", target.display()))?;
    }
    output
        .flush()
        .map_err(|error| format!("刷新目标文件 {} 失败：{error}", target.display()))?;
    drop(output);
    preserve_permissions(source, target);
    Ok(())
}

#[cfg(unix)]
fn create_copy_target(target: &Path) -> io::Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;

    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        // Keep the temporary result private until source permissions can be
        // applied. Filesystems without Unix permissions safely ignore this.
        .mode(0o600)
        .open(target)
}

#[cfg(not(unix))]
fn create_copy_target(target: &Path) -> io::Result<fs::File> {
    fs::OpenOptions::new().write(true).create_new(true).open(target)
}

fn preserve_permissions(source: &Path, target: &Path) {
    if let Ok(metadata) = source.metadata() {
        // Permission metadata is best-effort because several Linux-mounted
        // filesystems can store file data but do not implement chmod.
        let _ = fs::set_permissions(target, metadata.permissions());
    }
}

fn unique_target(directory: &Path, file_name: &std::ffi::OsStr) -> PathBuf {
    let initial = directory.join(file_name);
    if !initial.exists() {
        return initial;
    }
    let original = Path::new(file_name);
    let stem = original.file_stem().unwrap_or(file_name).to_string_lossy();
    let extension = original.extension().map(|value| value.to_string_lossy());
    for index in 2..10_000 {
        let name = match &extension {
            Some(extension) => format!("{stem} ({index}).{extension}"),
            None => format!("{stem} ({index})"),
        };
        let candidate = directory.join(name);
        if !candidate.exists() {
            return candidate;
        }
    }
    directory.join(format!("{stem}-{}", unix_timestamp()))
}

fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app.path().app_data_dir().map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join("ecosystem.json"))
}

fn save_state(app: &AppHandle, stats: &EcosystemStats) -> Result<(), String> {
    let content = serde_json::to_string_pretty(stats).map_err(|error| error.to_string())?;
    fs::write(state_path(app)?, content).map_err(|error| error.to_string())
}

#[cfg(target_os = "windows")]
fn shell_path(path: &Path) -> PathBuf {
    let value = path.as_os_str().to_string_lossy();
    value
        .strip_prefix(r"\\?\")
        .map(PathBuf::from)
        .unwrap_or_else(|| path.to_path_buf())
}

#[cfg(not(target_os = "windows"))]
fn shell_path(path: &Path) -> PathBuf {
    path.to_path_buf()
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
    fn creates_collision_free_target() {
        let root = std::env::temp_dir().join(format!("codex-cosmos-wormhole-{}", unix_timestamp()));
        fs::create_dir_all(&root).expect("create test root");
        fs::write(root.join("note.txt"), b"first").expect("create collision");
        assert_eq!(unique_target(&root, std::ffi::OsStr::new("note.txt")), root.join("note (2).txt"));
        fs::remove_dir_all(root).expect("clean test root");
    }

    #[test]
    fn moves_file_without_overwriting_collision() {
        let root = std::env::temp_dir().join(format!(
            "codex-cosmos-wormhole-move-{}-{}",
            std::process::id(),
            unix_timestamp()
        ));
        let source_dir = root.join("source");
        let destination = root.join("destination");
        fs::create_dir_all(&source_dir).expect("create source directory");
        fs::create_dir_all(&destination).expect("create destination directory");
        let source = source_dir.join("note.txt");
        fs::write(&source, b"from wormhole").expect("create source file");
        fs::write(destination.join("note.txt"), b"keep me").expect("create collision");

        let moved_name = move_one(&source, &destination).expect("move through wormhole");

        assert_eq!(moved_name, "note (2).txt");
        assert!(!source.exists());
        assert_eq!(fs::read(destination.join("note.txt")).unwrap(), b"keep me");
        assert_eq!(
            fs::read(destination.join("note (2).txt")).unwrap(),
            b"from wormhole"
        );
        fs::remove_dir_all(root).expect("clean test root");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn moves_directory_across_linux_filesystems() {
        use std::os::unix::fs::MetadataExt;

        let shared_memory = Path::new("/dev/shm");
        if !shared_memory.is_dir()
            || fs::metadata(std::env::temp_dir()).map(|value| value.dev()).ok()
                == fs::metadata(shared_memory).map(|value| value.dev()).ok()
        {
            return;
        }

        let suffix = format!("{}-{}", std::process::id(), unix_timestamp());
        let source_root = std::env::temp_dir().join(format!("codex-cosmos-cross-source-{suffix}"));
        let destination = shared_memory.join(format!("codex-cosmos-cross-target-{suffix}"));
        let source = source_root.join("payload");
        fs::create_dir_all(source.join("nested")).expect("create source directory");
        fs::create_dir_all(&destination).expect("create destination directory");
        fs::write(source.join("nested/note.txt"), b"across filesystems")
            .expect("create source file");

        let moved_name = move_one(&source, &destination).expect("move across filesystems");

        assert_eq!(moved_name, "payload");
        assert!(!source.exists());
        assert_eq!(
            fs::read(destination.join("payload/nested/note.txt")).unwrap(),
            b"across filesystems"
        );
        fs::remove_dir_all(source_root).expect("clean source root");
        fs::remove_dir_all(destination).expect("clean destination root");
    }

    #[test]
    fn compresses_and_extracts_without_consuming_source() {
        let root = std::env::temp_dir().join(format!(
            "codex-cosmos-star-forge-{}-{}",
            std::process::id(),
            unix_timestamp()
        ));
        let compressed = root.join("compressed");
        let extracted = root.join("extracted");
        fs::create_dir_all(&compressed).expect("create compression directory");
        fs::create_dir_all(&extracted).expect("create extraction directory");
        let source = root.join("seed.txt");
        fs::write(&source, b"stellar seed").expect("create seed");

        let archive = forge_one(&source, &compressed).expect("compress file");
        let output = forge_one(&archive, &extracted).expect("extract archive");

        assert_eq!(fs::read(&source).unwrap(), b"stellar seed");
        assert_eq!(archive.file_name().unwrap(), "seed.zip");
        assert_eq!(fs::read(output.join("seed.txt")).unwrap(), b"stellar seed");
        fs::remove_dir_all(root).expect("clean test root");
    }

    #[test]
    fn rejects_zip_path_traversal() {
        let root = std::env::temp_dir().join(format!(
            "codex-cosmos-star-forge-slip-{}-{}",
            std::process::id(),
            unix_timestamp()
        ));
        let destination = root.join("destination");
        fs::create_dir_all(&destination).expect("create destination");
        let archive_path = root.join("unsafe.zip");
        let output = fs::File::create(&archive_path).expect("create unsafe archive");
        let mut archive = zip::ZipWriter::new(output);
        archive
            .start_file("../escape.txt", zip::write::SimpleFileOptions::default())
            .expect("start unsafe entry");
        archive.write_all(b"do not escape").expect("write unsafe entry");
        archive.finish().expect("finish unsafe archive");

        let result = extract_zip(&archive_path, &destination);

        assert!(result.is_err());
        assert!(!root.join("escape.txt").exists());
        fs::remove_dir_all(root).expect("clean test root");
    }
}
