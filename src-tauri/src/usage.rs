use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    io::Read,
    path::PathBuf,
    time::Duration,
};
use tauri::Manager;

const KEYRING_SERVICE: &str = "codex-cosmos";
const KEYRING_USER: &str = "usage-api-authorization";
const MAX_RESPONSE_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeaderPair {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageProviderConfig {
    pub enabled: bool,
    pub name: String,
    pub url: String,
    pub method: String,
    #[serde(default)]
    pub body: Option<String>,
    pub used_path: String,
    pub total_path: String,
    #[serde(default)]
    pub breakdown_path: Option<String>,
    #[serde(default)]
    pub refresh_minutes: u64,
    #[serde(default)]
    pub headers: Vec<HeaderPair>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_authorization: Option<bool>,
}

impl Default for UsageProviderConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            name: String::new(),
            url: String::new(),
            method: "GET".to_string(),
            body: None,
            used_path: "/used".to_string(),
            total_path: "/total".to_string(),
            breakdown_path: None,
            refresh_minutes: 5,
            headers: Vec::new(),
            has_authorization: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSegment {
    pub label: String,
    pub tokens: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    pub used_tokens: f64,
    pub total_tokens: f64,
    pub breakdown: Vec<UsageSegment>,
    pub sampled_at: String,
    pub source: String,
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("无法找到应用数据目录: {error}"))
        .map(|dir| dir.join("usage-provider.json"))
}

fn load_config(app: &tauri::AppHandle) -> UsageProviderConfig {
    let Ok(path) = config_path(app) else {
        return UsageProviderConfig::default();
    };
    fs::read_to_string(&path)
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default()
}

fn save_config(app: &tauri::AppHandle, config: &UsageProviderConfig) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建配置目录失败: {error}"))?;
    }
    let content =
        serde_json::to_string_pretty(config).map_err(|error| format!("序列化配置失败: {error}"))?;
    fs::write(&path, content).map_err(|error| format!("保存配置失败: {error}"))
}

fn credential() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|error| format!("初始化凭据失败: {error}"))
}

fn read_authorization() -> Option<String> {
    credential().ok()?.get_password().ok()
}

fn write_authorization(value: &str) -> Result<(), String> {
    credential()?
        .set_password(value)
        .map_err(|error| format!("保存凭据失败: {error}"))
}

fn clear_authorization() {
    if let Ok(entry) = credential() {
        let _ = entry.delete_credential();
    }
}

fn normalize_pointer(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed == "/" {
        return "/".to_string();
    }
    if trimmed.starts_with('/') {
        trimmed.to_string()
    } else {
        format!("/{trimmed}")
    }
}

fn map_usage(config: &UsageProviderConfig, body: &str) -> Result<UsageSnapshot, String> {
    let value: Value =
        serde_json::from_str(body).map_err(|error| format!("响应不是有效 JSON: {error}"))?;
    let used = value
        .pointer(&normalize_pointer(&config.used_path))
        .and_then(Value::as_f64)
        .ok_or_else(|| "usedPath 未命中或不是数字".to_string())?;
    let total = value
        .pointer(&normalize_pointer(&config.total_path))
        .and_then(Value::as_f64)
        .ok_or_else(|| "totalPath 未命中或不是数字".to_string())?;

    let breakdown = match &config.breakdown_path {
        Some(path) if !path.trim().is_empty() => value
            .pointer(&normalize_pointer(path))
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        let label = item.get("label")?.as_str()?.to_string();
                        let tokens = item.get("tokens")?.as_f64()?;
                        Some(UsageSegment { label, tokens })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default(),
        _ => Vec::new(),
    };

    let source = if config.name.trim().is_empty() {
        "custom-api".to_string()
    } else {
        config.name.trim().to_string()
    };

    Ok(UsageSnapshot {
        used_tokens: used,
        total_tokens: total,
        breakdown,
        sampled_at: chrono::Utc::now().to_rfc3339(),
        source,
    })
}

fn fetch_text(config: &UsageProviderConfig, authorization: Option<&str>) -> Result<String, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(10))
        .build();
    let mut request = match config.method.trim().to_uppercase().as_str() {
        "POST" => agent.post(&config.url),
        _ => agent.get(&config.url),
    };
    for header in &config.headers {
        if !header.name.trim().is_empty() {
            request = request.set(&header.name, &header.value);
        }
    }
    if let Some(auth) = authorization {
        if !auth.is_empty() {
            request = request.set("Authorization", auth);
        }
    }
    let response = match config.body.as_deref() {
        Some(body) if !body.is_empty() => request
            .set("Content-Type", "application/json")
            .send_string(body)
            .map_err(|error| format!("请求失败: {error}"))?,
        _ => request.call().map_err(|error| format!("请求失败: {error}"))?,
    };
    let status = response.status();
    let mut bytes: Vec<u8> = Vec::new();
    response
        .into_reader()
        .take(MAX_RESPONSE_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("读取响应失败: {error}"))?;

    if status >= 400 {
        let preview: String = String::from_utf8_lossy(&bytes).chars().take(200).collect();
        return Err(format!("HTTP {status}: {preview}"));
    }
    String::from_utf8(bytes).map_err(|error| format!("响应编码不是 UTF-8: {error}"))
}

#[tauri::command]
pub fn set_usage_provider(
    app: tauri::AppHandle,
    config: UsageProviderConfig,
    authorization: Option<String>,
) -> Result<UsageProviderConfig, String> {
    match authorization {
        Some(value) if !value.is_empty() => write_authorization(&value)?,
        Some(_) => clear_authorization(),
        None => {}
    }
    let mut config = config;
    config.has_authorization = None;
    save_config(&app, &config)?;
    config.has_authorization = Some(read_authorization().is_some());
    Ok(config)
}

#[tauri::command]
pub fn get_usage_provider(app: tauri::AppHandle) -> Result<UsageProviderConfig, String> {
    let mut config = load_config(&app);
    config.has_authorization = Some(read_authorization().is_some());
    Ok(config)
}

#[tauri::command]
pub fn fetch_custom_usage(app: tauri::AppHandle) -> Result<UsageSnapshot, String> {
    let config = load_config(&app);
    if !config.enabled {
        return Err("自定义用量 API 未启用".to_string());
    }
    if config.url.trim().is_empty() {
        return Err("未配置 API 地址".to_string());
    }
    let authorization = read_authorization();
    let body = fetch_text(&config, authorization.as_deref())?;
    map_usage(&config, &body)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(used: &str, total: &str, breakdown: Option<&str>) -> UsageProviderConfig {
        UsageProviderConfig {
            used_path: used.to_string(),
            total_path: total.to_string(),
            breakdown_path: breakdown.map(str::to_string),
            ..UsageProviderConfig::default()
        }
    }

    #[test]
    fn maps_flat_usage() {
        let body = r#"{"used": 45000, "total": 128000}"#;
        let snapshot = map_usage(&config("/used", "/total", None), body).unwrap();
        assert_eq!(snapshot.used_tokens, 45_000.0);
        assert_eq!(snapshot.total_tokens, 128_000.0);
        assert!(snapshot.breakdown.is_empty());
    }

    #[test]
    fn maps_nested_with_breakdown() {
        let body = r#"{"data":{"used_tokens":100,"context_window":256,"parts":[{"label":"system","tokens":20},{"label":"tools","tokens":30}]}}"#;
        let snapshot = map_usage(
            &config("/data/used_tokens", "/data/context_window", Some("/data/parts")),
            body,
        )
        .unwrap();
        assert_eq!(snapshot.used_tokens, 100.0);
        assert_eq!(snapshot.total_tokens, 256.0);
        assert_eq!(snapshot.breakdown.len(), 2);
        assert_eq!(snapshot.breakdown[0].label, "system");
        assert_eq!(snapshot.breakdown[1].tokens, 30.0);
    }

    #[test]
    fn normalizes_missing_leading_slash() {
        let body = r#"{"used": 1, "total": 2}"#;
        let snapshot = map_usage(&config("used", "total", None), body).unwrap();
        assert_eq!(snapshot.used_tokens, 1.0);
    }

    #[test]
    fn rejects_missing_field() {
        let body = r#"{"used": 1}"#;
        assert!(map_usage(&config("/used", "/total", None), body).is_err());
    }
}
