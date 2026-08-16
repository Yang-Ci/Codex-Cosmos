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
const KEYRING_USER: &str = "balance-api-key";
const MAX_RESPONSE_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceProviderConfig {
    pub enabled: bool,
    pub name: String,
    pub preset: String,
    pub base_url: String,
    #[serde(default)]
    pub refresh_minutes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_api_key: Option<bool>,
}

impl Default for BalanceProviderConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            name: "DeepSeek".to_string(),
            preset: "deepseek".to_string(),
            base_url: String::new(),
            refresh_minutes: 30,
            has_api_key: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceSnapshot {
    pub currency: String,
    pub total_balance: String,
    pub granted_balance: String,
    pub topped_up_balance: String,
    pub source: String,
    pub sampled_at: String,
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("无法找到应用数据目录: {error}"))
        .map(|dir| dir.join("balance-provider.json"))
}

fn load_config(app: &tauri::AppHandle) -> BalanceProviderConfig {
    let Ok(path) = config_path(app) else {
        return BalanceProviderConfig::default();
    };
    fs::read_to_string(&path)
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default()
}

fn save_config(app: &tauri::AppHandle, config: &BalanceProviderConfig) -> Result<(), String> {
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

fn read_api_key() -> Option<String> {
    credential().ok()?.get_password().ok()
}

fn write_api_key(value: &str) -> Result<(), String> {
    credential()?
        .set_password(value)
        .map_err(|error| format!("保存 API Key 失败: {error}"))
}

fn clear_api_key() {
    if let Ok(entry) = credential() {
        let _ = entry.delete_credential();
    }
}

fn balance_url(config: &BalanceProviderConfig) -> String {
    match config.preset.as_str() {
        "openai-compatible" => format!("{}/user/balance", config.base_url.trim().trim_end_matches('/')),
        _ => "https://api.deepseek.com/user/balance".to_string(),
    }
}

fn value_as_string(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => number.to_string(),
        _ => String::new(),
    }
}

fn parse_balance(value: Value, config: &BalanceProviderConfig) -> Result<BalanceSnapshot, String> {
    let infos = value
        .pointer("/balance_infos")
        .and_then(Value::as_array)
        .ok_or_else(|| "响应缺少 balance_infos 字段".to_string())?;
    let first = infos.first().ok_or_else(|| "balance_infos 为空".to_string())?;

    let source = if config.name.trim().is_empty() {
        "DeepSeek".to_string()
    } else {
        config.name.trim().to_string()
    };

    Ok(BalanceSnapshot {
        currency: first
            .get("currency")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        total_balance: value_as_string(first.get("total_balance")),
        granted_balance: value_as_string(first.get("granted_balance")),
        topped_up_balance: value_as_string(first.get("topped_up_balance")),
        source,
        sampled_at: chrono::Utc::now().to_rfc3339(),
    })
}

fn fetch_balance(
    config: &BalanceProviderConfig,
    api_key: &str,
) -> Result<BalanceSnapshot, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(10))
        .build();
    let response = agent
        .get(&balance_url(config))
        .set("Authorization", &format!("Bearer {api_key}"))
        .call()
        .map_err(|error| format!("请求失败: {error}"))?;
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
    let body = String::from_utf8(bytes).map_err(|error| format!("响应编码不是 UTF-8: {error}"))?;
    let value: Value = serde_json::from_str(&body).map_err(|error| format!("响应不是有效 JSON: {error}"))?;
    parse_balance(value, config)
}

#[tauri::command]
pub fn set_balance_provider(
    app: tauri::AppHandle,
    config: BalanceProviderConfig,
    api_key: Option<String>,
) -> Result<BalanceProviderConfig, String> {
    match api_key {
        Some(value) if !value.trim().is_empty() => write_api_key(value.trim())?,
        Some(_) => clear_api_key(),
        None => {}
    }
    let mut config = config;
    config.has_api_key = None;
    save_config(&app, &config)?;
    config.has_api_key = Some(read_api_key().is_some());
    Ok(config)
}

#[tauri::command]
pub fn get_balance_provider(app: tauri::AppHandle) -> Result<BalanceProviderConfig, String> {
    let mut config = load_config(&app);
    config.has_api_key = Some(read_api_key().is_some());
    Ok(config)
}

#[tauri::command]
pub fn fetch_balance_snapshot(app: tauri::AppHandle) -> Result<BalanceSnapshot, String> {
    let config = load_config(&app);
    if !config.enabled {
        return Err("余额查询未启用".to_string());
    }
    let api_key = read_api_key().ok_or_else(|| "未配置 API Key".to_string())?;
    fetch_balance(&config, &api_key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_deepseek_balance() {
        let value: Value = serde_json::from_str(
            r#"{"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"100.50","granted_balance":"50.00","topped_up_balance":"50.50"}]}"#,
        )
        .unwrap();
        let snapshot = parse_balance(value, &BalanceProviderConfig::default()).unwrap();
        assert_eq!(snapshot.currency, "CNY");
        assert_eq!(snapshot.total_balance, "100.50");
        assert_eq!(snapshot.granted_balance, "50.00");
    }

    #[test]
    fn handles_numeric_balance() {
        let value: Value =
            serde_json::from_str(r#"{"balance_infos":[{"currency":"USD","total_balance":100}]}"#).unwrap();
        let snapshot = parse_balance(value, &BalanceProviderConfig::default()).unwrap();
        assert_eq!(snapshot.total_balance, "100");
    }

    #[test]
    fn rejects_missing_balance_infos() {
        let value: Value = serde_json::from_str(r#"{"foo":1}"#).unwrap();
        assert!(parse_balance(value, &BalanceProviderConfig::default()).is_err());
    }
}
