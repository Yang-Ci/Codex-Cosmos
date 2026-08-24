//! 星际通讯站 (Cosmos Relay) — 局域网文件投递，接收端 MVP。
//!
//! 协议严格对齐 LocalSend v2.2（来自 localsend 源码 `packages/core`）：
//! - 多播组 `224.0.0.167`（DEFAULT_MULTICAST_GROUP），端口 `53317`。
//! - 发现是 **announce-only**：设备发 UDP 多播 announce，收到他人 announce 后
//!   通过 **HTTP `POST /api/localsend/v2/register`** 单播回复自己信息。
//! - 每个网络接口绑一个 socket（`SO_REUSEADDR` + `IP_MULTICAST_IF` +
//!   loopback on + ttl 1），多播 loopback 开启以便同机实例互见。
//!
//! 这样手机上已安装的 LocalSend 可直接把文件投递给本机黑洞。

use axum::{
    body::Body,
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use futures::StreamExt;
use if_addrs::IfAddr;
use serde::{Deserialize, Serialize};
use socket2::{Domain, Protocol, Socket, Type};
use std::{
    collections::HashMap,
    fs,
    net::{Ipv4Addr, SocketAddr, SocketAddrV4},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{
    io::AsyncWriteExt,
    net::UdpSocket,
};
use uuid::Uuid;

/// LocalSend v2.2 默认多播组。位于 224.0.0.0/24，因部分 Android 只能收该范围多播。
const DEFAULT_PORT: u16 = 53317;
const MULTICAST_GROUP: Ipv4Addr = Ipv4Addr::new(224, 0, 0, 167);
const ANNOUNCE_INTERVAL_SECS: u64 = 5;
const DEVICE_TTL_SECS: u64 = 30;
const MAX_RELAY_FILES: usize = 100;
const MAX_RELAY_FILE_SIZE: u64 = 4 * 1024 * 1024 * 1024; // 单文件 4 GiB
const MAX_RELAY_BATCH_BYTES: u64 = 16 * 1024 * 1024 * 1024; // 单批 16 GiB
const MAX_NAME_LEN: usize = 512;
const RECENT_LIMIT: usize = 50;
const PROGRESS_EMIT_BYTES: u64 = 512 * 1024;
const RECEIVE_BUFFER_SIZE: usize = 65536;
const REGISTER_TIMEOUT_SECS: u64 = 5;

/// 设备信息。用于多播 announce、register 请求体、prepare-upload 的 info 字段。
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub alias: String,
    pub version: String,
    pub device_model: String,
    pub device_type: String,
    pub fingerprint: String,
    pub port: u16,
    pub protocol: String,
    #[serde(default)]
    pub download: bool,
}

/// 多播 announce 消息：DeviceInfo + 旧版 `announce` 标志（v2 协议要求）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AnnouncedMessage {
    #[serde(flatten)]
    info: DeviceInfo,
    announce: bool,
}

/// info 响应 / register 响应：不含 port 与 protocol（LocalSend 的 InfoResponseDtoV2 / RegisterResponseDtoV2）。
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceInfoLite {
    pub alias: String,
    pub version: String,
    pub device_model: String,
    pub device_type: String,
    pub fingerprint: String,
    #[serde(default)]
    pub download: bool,
}

/// prepare-upload 请求中每个文件的元信息（对齐 LocalSend FileDto）。
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileMeta {
    #[allow(dead_code)]
    pub id: String,
    pub file_name: String,
    pub size: u64,
    #[serde(default)]
    #[allow(dead_code)]
    pub file_type: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    pub preview: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrepareUploadRequest {
    pub info: DeviceInfo,
    pub files: HashMap<String, FileMeta>,
}

/// prepare-upload 响应：session_id + 每文件 token（对齐 PrepareUploadResponseDtoV2）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PrepareUploadResponse {
    pub session_id: String,
    pub files: HashMap<String, String>,
}

#[derive(Deserialize)]
struct UploadQuery {
    #[serde(rename = "fileId")]
    #[allow(dead_code)]
    file_id: String,
    #[serde(rename = "sessionId")]
    #[allow(dead_code)]
    session_id: Option<String>,
    token: String,
}

#[derive(Clone)]
struct UploadSession {
    #[allow(dead_code)]
    file_id: String,
    info: FileMeta,
    sender: DeviceInfo,
}

struct DeviceRecord {
    info: DeviceInfo,
    last_seen: Instant,
}

/// 星际通讯站持久化配置。fingerprint 为设备唯一指纹，首次生成后存盘。
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default = "default_alias")]
    pub alias: String,
    #[serde(default = "default_destination_string")]
    pub destination: String,
    #[serde(default = "default_auto_accept")]
    pub auto_accept: bool,
    #[serde(default)]
    pub fingerprint: String,
}

fn default_port() -> u16 {
    DEFAULT_PORT
}

fn default_alias() -> String {
    "Codex Cosmos".into()
}

fn default_auto_accept() -> bool {
    true
}

fn default_destination_string() -> String {
    dirs::download_dir()
        .or_else(dirs::document_dir)
        .unwrap_or_else(std::env::temp_dir)
        .to_string_lossy()
        .into_owned()
}

impl Default for RelayConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            port: DEFAULT_PORT,
            alias: default_alias(),
            destination: default_destination_string(),
            auto_accept: true,
            fingerprint: String::new(),
        }
    }
}

/// 接收记录，用于前端展示最近投递。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayRecentRecord {
    pub filename: String,
    pub bytes: u64,
    pub sender: String,
    pub received_at: i64,
    pub destination: String,
}

/// 通讯站统计。
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayStats {
    pub total_received: u64,
    pub total_bytes: u64,
    pub recent: Vec<RelayRecentRecord>,
}

struct RelayInner {
    config: RelayConfig,
    devices: HashMap<String, DeviceRecord>,
    sessions: HashMap<String, UploadSession>,
    stats: RelayStats,
    udp_handle: Option<tauri::async_runtime::JoinHandle<()>>,
    http_handle: Option<tauri::async_runtime::JoinHandle<()>>,
}

/// Tauri managed 状态。
pub struct RelayState {
    inner: Arc<Mutex<RelayInner>>,
}

/// axum handler 共享状态。AppHandle 与内部 Arc 都可 Clone。
#[derive(Clone)]
struct AxumState {
    app: AppHandle,
    relay: Arc<Mutex<RelayInner>>,
}

impl RelayState {
    pub fn load(app: &AppHandle) -> Self {
        let config = load_config(app).unwrap_or_else(|_| {
            let mut config = RelayConfig::default();
            config.fingerprint = Uuid::new_v4().to_string();
            let _ = save_config(app, &config);
            config
        });
        let config = if config.fingerprint.is_empty() {
            let mut config = config;
            config.fingerprint = Uuid::new_v4().to_string();
            let _ = save_config(app, &config);
            config
        } else {
            config
        };
        Self {
            inner: Arc::new(Mutex::new(RelayInner {
                config,
                devices: HashMap::new(),
                sessions: HashMap::new(),
                stats: RelayStats::default(),
                udp_handle: None,
                http_handle: None,
            })),
        }
    }
}

fn self_device_info(config: &RelayConfig) -> DeviceInfo {
    DeviceInfo {
        alias: if config.alias.trim().is_empty() {
            default_alias()
        } else {
            config.alias.clone()
        },
        version: "2.2".into(),
        fingerprint: config.fingerprint.clone(),
        port: config.port,
        protocol: "http".into(),
        device_model: "Codex Cosmos".into(),
        device_type: "desktop".into(),
        download: false,
    }
}

fn self_device_lite(config: &RelayConfig) -> DeviceInfoLite {
    let info = self_device_info(config);
    DeviceInfoLite {
        alias: info.alias,
        version: info.version,
        device_model: info.device_model,
        device_type: info.device_type,
        fingerprint: info.fingerprint,
        download: info.download,
    }
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    Ok(directory.join("relay.json"))
}

fn load_config(app: &AppHandle) -> Result<RelayConfig, String> {
    let path = config_path(app)?;
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str::<RelayConfig>(&content).map_err(|e| e.to_string())
}

fn save_config(app: &AppHandle, config: &RelayConfig) -> Result<(), String> {
    let content = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(config_path(app)?, content).map_err(|e| e.to_string())
}

// ─── Tauri commands ───────────────────────────────────────────────────────

#[tauri::command]
pub fn get_relay_config(state: tauri::State<'_, RelayState>) -> Result<RelayConfig, String> {
    state
        .inner
        .lock()
        .map(|inner| inner.config.clone())
        .map_err(|_| "星际通讯站暂不可用".into())
}

#[tauri::command]
pub fn set_relay_config(
    app: AppHandle,
    state: tauri::State<'_, RelayState>,
    config: RelayConfig,
) -> Result<RelayConfig, String> {
    {
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| "星际通讯站暂不可用".to_string())?;
        inner.config = config.clone();
        save_config(&app, &inner.config)?;
    }
    stop(&state);
    start(app, &state);
    Ok(config)
}

#[tauri::command]
pub fn relay_devices(state: tauri::State<'_, RelayState>) -> Result<Vec<DeviceInfo>, String> {
    let inner = state.inner.lock().map_err(|_| "星际通讯站暂不可用".to_string())?;
    let now = Instant::now();
    let mut devices: Vec<DeviceInfo> = inner
        .devices
        .iter()
        .filter(|(_, record)| now.duration_since(record.last_seen).as_secs() < DEVICE_TTL_SECS)
        .map(|(_, record)| record.info.clone())
        .collect();
    devices.sort_by(|a, b| a.alias.cmp(&b.alias));
    Ok(devices)
}

#[tauri::command]
pub fn relay_stats(state: tauri::State<'_, RelayState>) -> Result<RelayStats, String> {
    let inner = state.inner.lock().map_err(|_| "星际通讯站暂不可用".to_string())?;
    Ok(inner.stats.clone())
}

#[tauri::command]
pub fn relay_recent(state: tauri::State<'_, RelayState>) -> Result<Vec<RelayRecentRecord>, String> {
    let inner = state.inner.lock().map_err(|_| "星际通讯站暂不可用".to_string())?;
    Ok(inner.stats.recent.clone())
}

#[tauri::command]
pub fn clear_relay_recent(state: tauri::State<'_, RelayState>) -> Result<(), String> {
    let mut inner = state.inner.lock().map_err(|_| "星际通讯站暂不可用".to_string())?;
    inner.stats.recent.clear();
    Ok(())
}

// ─── 服务启停 ───────────────────────────────────────────────────────────

pub fn start(app: AppHandle, state: &RelayState) {
    let (port, enabled) = {
        let inner = match state.inner.lock() {
            Ok(inner) => inner,
            Err(_) => return,
        };
        (inner.config.port, inner.config.enabled)
    };
    if !enabled {
        return;
    }
    let axum_state = AxumState {
        app: app.clone(),
        relay: state.inner.clone(),
    };
    let udp_handle = tauri::async_runtime::spawn(udp_loop(axum_state.clone(), port));
    let http_handle = tauri::async_runtime::spawn(http_serve(axum_state, port));
    if let Ok(mut inner) = state.inner.lock() {
        inner.udp_handle = Some(udp_handle);
        inner.http_handle = Some(http_handle);
    }
}

fn stop(state: &RelayState) {
    if let Ok(mut inner) = state.inner.lock() {
        if let Some(handle) = inner.udp_handle.take() {
            handle.abort();
        }
        if let Some(handle) = inner.http_handle.take() {
            handle.abort();
        }
    }
}

// ─── HTTP server ──────────────────────────────────────────────────────────

fn router(state: AxumState) -> Router {
    Router::new()
        .route("/api/localsend/v2/info", get(info))
        .route("/api/localsend/v2/register", post(register))
        .route("/api/localsend/v2/prepare-upload", post(prepare_upload))
        .route("/api/localsend/v2/upload", post(upload))
        .route("/api/localsend/v2/cancel-upload", post(cancel_upload))
        .with_state(state)
}

async fn http_serve(state: AxumState, port: u16) {
    let listener = match TcpListener::bind(("0.0.0.0", port)).await {
        Ok(listener) => listener,
        Err(error) => {
            let _ = state.app.emit(
                "relay-status",
                serde_json::json!({ "running": false, "port": port, "error": format!("端口 {port} 绑定失败：{error}") }),
            );
            return;
        }
    };
    let _ = state.app.emit(
        "relay-status",
        serde_json::json!({ "running": true, "port": port, "error": null }),
    );
    let app = router(state.clone());
    if let Err(error) = axum::serve(listener, app).await {
        let _ = state.app.emit(
            "relay-status",
            serde_json::json!({ "running": false, "port": port, "error": format!("服务停止：{error}") }),
        );
    }
}

async fn info(State(state): State<AxumState>) -> impl IntoResponse {
    let inner = match state.relay.lock() {
        Ok(inner) => inner,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "状态暂不可用").into_response(),
    };
    Json(self_device_lite(&inner.config)).into_response()
}

/// POST /register：另一台设备在收到本机 announce 后单播回复自己信息。
/// 本机据此把对方加入设备列表。响应返回本机精简信息。
async fn register(
    State(state): State<AxumState>,
    Json(payload): Json<DeviceInfo>,
) -> impl IntoResponse {
    if !payload.fingerprint.is_empty() {
        let mut inner = match state.relay.lock() {
            Ok(inner) => inner,
            Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "状态暂不可用").into_response(),
        };
        if !inner.config.enabled {
            return (StatusCode::FORBIDDEN, "星际通讯站未启用").into_response();
        }
        inner.devices.insert(
            payload.fingerprint.clone(),
            DeviceRecord {
                info: payload.clone(),
                last_seen: Instant::now(),
            },
        );
        let now = Instant::now();
        inner.devices.retain(|_, r| now.duration_since(r.last_seen).as_secs() < DEVICE_TTL_SECS);
        let _ = state.app.emit("relay-device-discovered", &payload);
    }
    let lite = {
        let inner = match state.relay.lock() {
            Ok(inner) => inner,
            Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "状态暂不可用").into_response(),
        };
        self_device_lite(&inner.config)
    };
    Json(lite).into_response()
}

async fn prepare_upload(
    State(state): State<AxumState>,
    Json(req): Json<PrepareUploadRequest>,
) -> impl IntoResponse {
    let mut inner = match state.relay.lock() {
        Ok(inner) => inner,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "状态暂不可用").into_response(),
    };
    if !inner.config.enabled {
        return (StatusCode::FORBIDDEN, "星际通讯站未启用").into_response();
    }
    if !inner.config.auto_accept {
        return (StatusCode::FORBIDDEN, "需要手动确认，暂未开放").into_response();
    }
    if req.files.len() > MAX_RELAY_FILES {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            format!("单批最多 {MAX_RELAY_FILES} 个文件"),
        )
            .into_response();
    }
    let mut total: u64 = 0;
    for meta in req.files.values() {
        if meta.size > MAX_RELAY_FILE_SIZE {
            return (
                StatusCode::PAYLOAD_TOO_LARGE,
                format!("单文件超过 {} 上限", human_bytes(MAX_RELAY_FILE_SIZE)),
            )
                .into_response();
        }
        total = total.saturating_add(meta.size);
        if total > MAX_RELAY_BATCH_BYTES {
            return (
                StatusCode::PAYLOAD_TOO_LARGE,
                format!("单批超过 {} 上限", human_bytes(MAX_RELAY_BATCH_BYTES)),
            )
                .into_response();
        }
    }
    let session_id = Uuid::new_v4().to_string();
    let mut tokens: HashMap<String, String> = HashMap::new();
    for (id, meta) in req.files {
        let token = Uuid::new_v4().to_string();
        inner.sessions.insert(
            token.clone(),
            UploadSession {
                file_id: id.clone(),
                info: meta,
                sender: req.info.clone(),
            },
        );
        tokens.insert(id, token);
    }
    Json(PrepareUploadResponse {
        session_id,
        files: tokens,
    })
    .into_response()
}

async fn upload(
    State(state): State<AxumState>,
    Query(query): Query<UploadQuery>,
    body: Body,
) -> impl IntoResponse {
    let token = query.token;
    let session = {
        let inner = match state.relay.lock() {
            Ok(inner) => inner,
            Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "状态暂不可用").into_response(),
        };
        inner.sessions.get(&token).cloned()
    };
    let Some(session) = session else {
        return (StatusCode::FORBIDDEN, "投递令牌无效或已过期").into_response();
    };

    let destination = {
        let inner = match state.relay.lock() {
            Ok(inner) => inner,
            Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "状态暂不可用").into_response(),
        };
        inner.config.destination.clone()
    };
    let destination_path = PathBuf::from(&destination);
    if !destination_path.is_dir() {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "接收目录已不存在，请在设置中重新指定",
        )
            .into_response();
    }
    let safe_name = sanitize_filename(&session.info.file_name);
    let target = match safe_target(&destination_path, &safe_name) {
        Ok(path) => path,
        Err(error) => return (StatusCode::BAD_REQUEST, error).into_response(),
    };

    let total = session.info.size;
    match write_stream(body, &target, total, &state, &token, &safe_name).await {
        Ok(bytes) => {
            let record = RelayRecentRecord {
                filename: safe_name.clone(),
                bytes,
                sender: session.sender.alias.clone(),
                received_at: unix_timestamp(),
                destination: shell_path(&target).to_string_lossy().into_owned(),
            };
            let mut inner = match state.relay.lock() {
                Ok(inner) => inner,
                Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "状态暂不可用").into_response(),
            };
            inner.stats.total_received = inner.stats.total_received.saturating_add(1);
            inner.stats.total_bytes = inner.stats.total_bytes.saturating_add(bytes);
            inner.stats.recent.push(record.clone());
            let recent_len = inner.stats.recent.len();
            if recent_len > RECENT_LIMIT {
                inner.stats.recent.drain(0..recent_len - RECENT_LIMIT);
            }
            inner.sessions.remove(&token);
            let _ = state.app.emit(
                "relay-transfer-complete",
                serde_json::json!({
                    "token": token,
                    "filename": record.filename,
                    "bytes": record.bytes,
                    "sender": record.sender,
                    "destination": record.destination,
                }),
            );
            (StatusCode::OK, "ok").into_response()
        }
        Err(error) => {
            let _ = fs::remove_file(&target);
            let _ = state.app.emit(
                "relay-transfer-error",
                serde_json::json!({ "token": token, "filename": safe_name, "error": error }),
            );
            (StatusCode::INTERNAL_SERVER_ERROR, error).into_response()
        }
    }
}

async fn cancel_upload(State(state): State<AxumState>) -> impl IntoResponse {
    if let Ok(mut inner) = state.relay.lock() {
        // MVP：清理所有会话，对应 LocalSend 的 cancel 语义。
        inner.sessions.clear();
    }
    (StatusCode::OK, "ok").into_response()
}

async fn write_stream(
    body: Body,
    target: &std::path::Path,
    total: u64,
    state: &AxumState,
    token: &str,
    filename: &str,
) -> Result<u64, String> {
    let mut file = tokio::fs::File::create(target)
        .await
        .map_err(|error| format!("无法创建接收文件：{error}"))?;
    let mut stream = body.into_data_stream();
    let mut received: u64 = 0;
    let mut last_emit: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("读取投递数据失败：{error}"))?;
        if received + chunk.len() as u64 > total.saturating_add(1024 * 1024) {
            return Err(format!("投递体积超过声明的 {}，已中止", human_bytes(total)));
        }
        file.write_all(&chunk)
            .await
            .map_err(|error| format!("写入投递文件失败：{error}"))?;
        received += chunk.len() as u64;
        if received >= last_emit + PROGRESS_EMIT_BYTES {
            let _ = state.app.emit(
                "relay-transfer-progress",
                serde_json::json!({
                    "token": token,
                    "filename": filename,
                    "received": received,
                    "total": total,
                }),
            );
            last_emit = received;
        }
    }
    file.flush()
        .await
        .map_err(|error| format!("刷新投递文件失败：{error}"))?;
    Ok(received)
}

// ─── UDP 多播发现（socket2 每接口，对齐 LocalSend）─────────────────────────

use tokio::net::TcpListener;

/// 在每个非环回 IPv4 接口上绑定并加入多播组的 socket。
struct BoundSocket {
    socket: Arc<UdpSocket>,
    target: SocketAddr,
    description: String,
}

fn bind_multicast_socket_v4(
    group: Ipv4Addr,
    port: u16,
    interface: Ipv4Addr,
) -> std::io::Result<UdpSocket> {
    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    // 所有 socket 共用同一端口；Windows 无 SO_REUSEPORT，仅 SO_REUSEADDR。
    socket.set_reuse_address(true)?;
    // bind 通配地址，使 socket 能在匹配目的地址的平台上接收多播数据报。
    socket.bind(&SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, port).into())?;
    socket.join_multicast_v4(&group, &interface)?;
    // 把出站数据报固定到本接口，否则路由表决定，所有 socket 都从一个接口发出。
    socket.set_multicast_if_v4(&interface)?;
    // 保留 loopback，使同机多个实例互见；自己的消息靠 fingerprint 过滤。
    socket.set_multicast_loop_v4(true)?;
    // 发现仅限本地子网。
    socket.set_multicast_ttl_v4(1)?;
    socket.set_nonblocking(true)?;
    UdpSocket::from_std(socket.into())
}

fn is_link_local(addr: &Ipv4Addr) -> bool {
    addr.octets()[0] == 169 && addr.octets()[1] == 254
}

async fn udp_loop(state: AxumState, port: u16) {
    let interfaces = if_addrs::get_if_addrs().unwrap_or_default();
    let mut sockets: Vec<BoundSocket> = Vec::new();
    for iface in interfaces {
        if let IfAddr::V4(v4) = &iface.addr {
            let ip = v4.ip;
            if ip.is_loopback() || is_link_local(&ip) {
                continue;
            }
            match bind_multicast_socket_v4(MULTICAST_GROUP, port, ip) {
                Ok(socket) => {
                    let description = format!("{} ({})", iface.name, ip);
                    let target = SocketAddr::V4(SocketAddrV4::new(MULTICAST_GROUP, port));
                    sockets.push(BoundSocket {
                        socket: Arc::new(socket),
                        target,
                        description,
                    });
                }
                Err(_) => {
                    // 单个虚拟接口绑定失败不应禁用整个发现，跳过。
                }
            }
        }
    }
    if sockets.is_empty() {
        let _ = state.app.emit(
            "relay-status",
            serde_json::json!({ "running": false, "port": port, "error": "没有可用的网络接口用于多播发现" }),
        );
        return;
    }

    // 每个接口一个接收任务。
    let mut tasks = tokio::task::JoinSet::new();
    for bound in &sockets {
        let socket = bound.socket.clone();
        let state_clone = state.clone();
        let description = bound.description.clone();
        tasks.spawn(async move {
            recv_loop(socket, state_clone, description, port).await;
        });
    }

    let mut tick = tokio::time::interval(Duration::from_secs(ANNOUNCE_INTERVAL_SECS));
    // 首次立即发送一次。
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            _ = tick.tick() => {
                let info = {
                    match state.relay.lock() {
                        Ok(inner) => self_device_info(&inner.config),
                        Err(_) => continue,
                    }
                };
                let message = AnnouncedMessage { info, announce: true };
                if let Ok(payload) = serde_json::to_vec(&message) {
                    for bound in &sockets {
                        let _ = bound.socket.send_to(&payload, bound.target).await;
                    }
                }
            }
        }
    }
}

/// 单接口接收循环：解析 announce，过滤自己，记录对方，并 HTTP register 回复。
async fn recv_loop(
    socket: Arc<UdpSocket>,
    state: AxumState,
    description: String,
    _port: u16,
) {
    let mut buffer = vec![0u8; RECEIVE_BUFFER_SIZE];
    loop {
        let received = socket.recv_from(&mut buffer).await;
        let (size, src) = match received {
            Ok(value) => value,
            Err(_) => {
                // 短暂错误（Windows 上一次发送的 ICMP 错误会在下次接收浮现）直接重试。
                continue;
            }
        };
        let info: DeviceInfo = match serde_json::from_slice(&buffer[..size]) {
            Ok(info) => info,
            Err(_) => continue,
        };
        let my_fingerprint = {
            match state.relay.lock() {
                Ok(inner) => inner.config.fingerprint.clone(),
                Err(_) => continue,
            }
        };
        if info.fingerprint.is_empty() || info.fingerprint == my_fingerprint {
            continue;
        }
        // 记录对方设备。
        {
            let mut inner = match state.relay.lock() {
                Ok(inner) => inner,
                Err(_) => continue,
            };
            inner.devices.insert(
                info.fingerprint.clone(),
                DeviceRecord {
                    info: info.clone(),
                    last_seen: Instant::now(),
                },
            );
            let now = Instant::now();
            inner
                .devices
                .retain(|_, r| now.duration_since(r.last_seen).as_secs() < DEVICE_TTL_SECS);
        }
        let _ = state.app.emit("relay-device-discovered", &info);
        // 协议要求：用 HTTP register 回复对方，让对方也能发现本机。
        let peer_ip = src.ip();
        let peer_port = info.port;
        let app = state.app.clone();
        let relay = state.relay.clone();
        let desc = description.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let self_info = match relay.lock() {
                Ok(inner) => self_device_info(&inner.config),
                Err(_) => return,
            };
            let body = match serde_json::to_string(&self_info) {
                Ok(body) => body,
                Err(_) => return,
            };
            let url = format!("http://{peer_ip}:{peer_port}/api/localsend/v2/register");
            let _ = ureq::post(&url)
                .set("Content-Type", "application/json")
                .timeout(Duration::from_secs(REGISTER_TIMEOUT_SECS))
                .send_string(&body);
            let _ = (&desc, &app);
        });
    }
}

// ─── 文件名与路径安全 ────────────────────────────────────────────────────

fn sanitize_filename(name: &str) -> String {
    let name = name.trim();
    if name.is_empty() {
        return "untitled".into();
    }
    let normalized = name.replace('\\', "/");
    let basename = normalized.rsplit('/').next().unwrap_or(name).trim();
    let basename = basename.trim_start_matches(['.', ' ', '\t']);
    if basename.is_empty() {
        return "untitled".into();
    }
    basename
        .chars()
        .filter(|c| *c != '\0' && *c != '\n' && *c != '\r')
        .take(MAX_NAME_LEN)
        .collect()
}

fn safe_target(directory: &std::path::Path, file_name: &str) -> Result<PathBuf, String> {
    let canonical_dir = directory
        .canonicalize()
        .map_err(|error| format!("无法解析接收目录：{error}"))?;
    let target = unique_target(&canonical_dir, std::ffi::OsStr::new(file_name));
    if !target.starts_with(&canonical_dir) {
        return Err("接收路径越界，已拒绝".into());
    }
    Ok(target)
}

fn unique_target(directory: &std::path::Path, file_name: &std::ffi::OsStr) -> PathBuf {
    let initial = directory.join(file_name);
    if !initial.exists() {
        return initial;
    }
    let original = std::path::Path::new(file_name);
    let stem = original
        .file_stem()
        .unwrap_or(file_name)
        .to_string_lossy();
    let extension = original.extension().map(|value| value.to_string_lossy().into_owned());
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

#[cfg(target_os = "windows")]
fn shell_path(path: &std::path::Path) -> PathBuf {
    let value = path.as_os_str().to_string_lossy();
    value
        .strip_prefix(r"\\?\")
        .map(PathBuf::from)
        .unwrap_or_else(|| path.to_path_buf())
}

#[cfg(not(target_os = "windows"))]
fn shell_path(path: &std::path::Path) -> PathBuf {
    path.to_path_buf()
}

fn unix_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}

fn human_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit_index = 0;
    while value >= 1024.0 && unit_index < UNITS.len() - 1 {
        value /= 1024.0;
        unit_index += 1;
    }
    if unit_index == 0 {
        format!("{} {}", bytes, UNITS[0])
    } else {
        format!("{:.1} {}", value, UNITS[unit_index])
    }
}

// ─── 测试 ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_traversal_attempts() {
        assert_eq!(sanitize_filename("../escape.txt"), "escape.txt");
        assert_eq!(sanitize_filename("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_filename("a/b/c.txt"), "c.txt");
        assert_eq!(sanitize_filename("a\\b\\c.txt"), "c.txt");
        assert_eq!(sanitize_filename(".."), "untitled");
        assert_eq!(sanitize_filename(""), "untitled");
        assert_eq!(sanitize_filename("   "), "untitled");
    }

    #[test]
    fn avoids_collision() {
        let root = std::env::temp_dir().join(format!("codex-cosmos-relay-{}", unix_timestamp()));
        fs::create_dir_all(&root).expect("create test root");
        fs::write(root.join("note.txt"), b"first").expect("create collision");
        let target = safe_target(&root, "note.txt").expect("safe target");
        assert_eq!(target.file_name().unwrap(), "note (2).txt");
        fs::remove_dir_all(root).expect("clean test root");
    }

    #[test]
    fn announce_message_carries_legacy_flag() {
        let config = RelayConfig {
            fingerprint: "fp".into(),
            ..RelayConfig::default()
        };
        let info = self_device_info(&config);
        let json = serde_json::to_string(&AnnouncedMessage { info, announce: true }).unwrap();
        assert!(json.contains("\"announce\":true"));
        assert!(json.contains("\"fingerprint\":\"fp\""));
        assert!(json.contains("\"version\":\"2.2\""));
    }
}
