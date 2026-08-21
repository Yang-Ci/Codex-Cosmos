use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    path::PathBuf,
    time::Duration,
};
use tauri::Manager;

const KEYRING_SERVICE: &str = "codex-cosmos";
const KEYRING_USER: &str = "balance-api-key";
const KEYRING_ACCOUNT_USER: &str = "balance-account-access-token";
const MAX_RESPONSE_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceProviderConfig {
    pub enabled: bool,
    pub name: String,
    pub preset: String,
    pub base_url: String,
    #[serde(default)]
    pub account_user_id: String,
    #[serde(default)]
    pub refresh_minutes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_api_key: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_account_token: Option<bool>,
}

impl Default for BalanceProviderConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            name: "DeepSeek".to_string(),
            preset: "deepseek".to_string(),
            base_url: String::new(),
            account_user_id: String::new(),
            refresh_minutes: 30,
            has_api_key: None,
            has_account_token: None,
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceHistoryPoint {
    pub timestamp: i64,
    pub usage: f64,
    pub requests: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceDetailsSnapshot {
    pub remaining_balance: String,
    pub recent_usage: String,
    pub historical_usage: String,
    pub request_count: u64,
    pub currency: String,
    pub history: Vec<BalanceHistoryPoint>,
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

fn credential(user: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, user).map_err(|error| format!("初始化凭据失败: {error}"))
}

fn read_credential(user: &str, label: &str) -> Result<Option<String>, String> {
    match credential(user)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("读取 {label} 失败: {error}")),
    }
}

fn write_credential(user: &str, label: &str, value: &str) -> Result<(), String> {
    credential(user)?
        .set_password(value)
        .map_err(|error| format!("保存 {label} 失败: {error}"))
}

fn clear_credential(user: &str) {
    if let Ok(entry) = credential(user) {
        let _ = entry.delete_credential();
    }
}

fn read_api_key() -> Result<Option<String>, String> {
    read_credential(KEYRING_USER, "API Key")
}

fn read_account_token() -> Result<Option<String>, String> {
    read_credential(KEYRING_ACCOUNT_USER, "账户访问令牌")
}

fn balance_url(config: &BalanceProviderConfig) -> String {
    match config.preset.as_str() {
        "openai-compatible" => format!(
            "{}/api/usage/token/",
            config.base_url.trim().trim_end_matches('/')
        ),
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

fn format_amount(value: f64) -> String {
    let mut formatted = format!("{value:.4}");
    while formatted.contains('.') && formatted.ends_with('0') {
        formatted.pop();
    }
    if formatted.ends_with('.') {
        formatted.pop();
    }
    formatted
}

fn format_display_amount(value: f64, currency: &str) -> String {
    if matches!(currency, "CNY" | "USD") {
        format!("{value:.2}")
    } else {
        format_amount(value)
    }
}

fn new_api_display_conversion(status: Option<&Value>) -> (f64, &'static str) {
    let status_data = status.and_then(|item| item.get("data"));
    let quota_per_unit = status_data
        .and_then(|item| item.get("quota_per_unit"))
        .and_then(Value::as_f64)
        .filter(|value| *value > 0.0)
        .unwrap_or(500_000.0);
    let display_type = status_data
        .and_then(|item| item.get("quota_display_type"))
        .and_then(Value::as_str)
        .unwrap_or("USD");
    let exchange_rate = status_data
        .and_then(|item| item.get("usd_exchange_rate"))
        .and_then(Value::as_f64)
        .unwrap_or(1.0);
    match display_type {
        "CNY" => (exchange_rate / quota_per_unit, "CNY"),
        "TOKENS" => (1.0, "tokens"),
        _ => (1.0 / quota_per_unit, "USD"),
    }
}

fn parse_new_api_account(
    value: &Value,
    status: Option<&Value>,
    config: &BalanceProviderConfig,
) -> Result<BalanceSnapshot, String> {
    if value.get("success").and_then(Value::as_bool) == Some(false) {
        return Err(value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("账户余额查询失败")
            .to_string());
    }
    let data = value.get("data").unwrap_or(value);
    let remaining_raw = data
        .get("quota")
        .and_then(Value::as_f64)
        .ok_or_else(|| "账户响应缺少 data.quota 字段".to_string())?;
    let used_raw = data
        .get("used_quota")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let (multiplier, currency) = new_api_display_conversion(status);
    let source = if config.name.trim().is_empty() {
        "New API".to_string()
    } else {
        config.name.trim().to_string()
    };
    Ok(BalanceSnapshot {
        currency: currency.to_string(),
        total_balance: format_display_amount(remaining_raw * multiplier, currency),
        granted_balance: format_display_amount((remaining_raw + used_raw) * multiplier, currency),
        topped_up_balance: format_display_amount(used_raw * multiplier, currency),
        source,
        sampled_at: chrono::Utc::now().to_rfc3339(),
    })
}

fn parse_new_api_details(
    account: &Value,
    status: Option<&Value>,
    usage_history: &Value,
) -> Result<BalanceDetailsSnapshot, String> {
    if account.get("success").and_then(Value::as_bool) == Some(false) {
        return Err(account
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("账户详情查询失败")
            .to_string());
    }
    if usage_history.get("success").and_then(Value::as_bool) == Some(false) {
        return Err(usage_history
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("24 小时用量查询失败")
            .to_string());
    }
    let data = account.get("data").unwrap_or(account);
    let remaining_raw = data
        .get("quota")
        .and_then(Value::as_f64)
        .ok_or_else(|| "账户响应缺少 data.quota 字段".to_string())?;
    let historical_raw = data
        .get("used_quota")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let request_count = data
        .get("request_count")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let (multiplier, currency) = new_api_display_conversion(status);
    let mut buckets: BTreeMap<i64, (f64, u64)> = BTreeMap::new();
    for item in usage_history
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let timestamp = item
            .get("created_at")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        if timestamp <= 0 {
            continue;
        }
        let usage = item.get("quota").and_then(Value::as_f64).unwrap_or(0.0);
        let requests = item.get("count").and_then(Value::as_u64).unwrap_or(0);
        let bucket = buckets.entry(timestamp).or_insert((0.0, 0));
        bucket.0 += usage;
        bucket.1 = bucket.1.saturating_add(requests);
    }
    let recent_raw: f64 = buckets.values().map(|(usage, _)| *usage).sum();
    let history = buckets
        .into_iter()
        .map(|(timestamp, (usage, requests))| BalanceHistoryPoint {
            timestamp,
            usage: usage * multiplier,
            requests,
        })
        .collect();
    Ok(BalanceDetailsSnapshot {
        remaining_balance: format_display_amount(remaining_raw * multiplier, currency),
        recent_usage: format_display_amount(recent_raw * multiplier, currency),
        historical_usage: format_display_amount(historical_raw * multiplier, currency),
        request_count,
        currency: currency.to_string(),
        history,
        sampled_at: chrono::Utc::now().to_rfc3339(),
    })
}

fn parse_balance(value: Value, config: &BalanceProviderConfig) -> Result<BalanceSnapshot, String> {
    let source = if config.name.trim().is_empty() {
        if config.preset == "openai-compatible" {
            "New API".to_string()
        } else {
            "DeepSeek".to_string()
        }
    } else {
        config.name.trim().to_string()
    };

    if config.preset == "openai-compatible" {
        if value.get("code").and_then(Value::as_bool) == Some(false)
            || value.get("success").and_then(Value::as_bool) == Some(false)
        {
            return Err(value
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("New API 返回查询失败")
                .to_string());
        }
        let data = value.get("data").unwrap_or(&value);
        let unlimited = data
            .get("unlimited_quota")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let available = value_as_string(data.get("total_available"));
        if !unlimited && available.is_empty() {
            return Err("响应缺少 data.total_available 字段".to_string());
        }
        return Ok(BalanceSnapshot {
            currency: "额度".to_string(),
            total_balance: if unlimited { "∞".to_string() } else { available },
            granted_balance: value_as_string(data.get("total_granted")),
            topped_up_balance: value_as_string(data.get("total_used")),
            source,
            sampled_at: chrono::Utc::now().to_rfc3339(),
        });
    }

    let infos = value
        .pointer("/balance_infos")
        .and_then(Value::as_array)
        .ok_or_else(|| "响应缺少 balance_infos 字段".to_string())?;
    let first = infos.first().ok_or_else(|| "balance_infos 为空".to_string())?;

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

fn read_response_bytes(response: ureq::Response) -> Result<Vec<u8>, String> {
    let mut bytes: Vec<u8> = Vec::new();
    response
        .into_reader()
        .take(MAX_RESPONSE_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("读取响应失败: {error}"))?;
    Ok(bytes)
}

fn response_error(status: u16, response: ureq::Response) -> String {
    let Ok(bytes) = read_response_bytes(response) else {
        return format!("HTTP {status}");
    };
    let body = String::from_utf8_lossy(&bytes);
    let message = serde_json::from_slice::<Value>(&bytes)
        .ok()
        .and_then(|value| {
            value
                .get("message")
                .or_else(|| value.pointer("/error/message"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| body.chars().take(200).collect());
    if message.trim().is_empty() {
        format!("HTTP {status}")
    } else {
        format!("HTTP {status}: {}", message.trim())
    }
}

fn fetch_json_with_user_id(
    agent: &ureq::Agent,
    url: &str,
    api_key: &str,
    account_user_id: Option<&str>,
) -> Result<Value, String> {
    let mut request = agent
        .get(url)
        .set("Authorization", &format!("Bearer {api_key}"));
    if let Some(user_id) = account_user_id.filter(|value| !value.trim().is_empty()) {
        request = request.set("New-Api-User", user_id.trim());
    }
    let response = match request.call() {
        Ok(response) => response,
        Err(ureq::Error::Status(status, response)) => {
            return Err(response_error(status, response));
        }
        Err(error) => return Err(format!("请求失败: {error}")),
    };
    let bytes = read_response_bytes(response)?;
    let body = String::from_utf8(bytes).map_err(|error| format!("响应编码不是 UTF-8: {error}"))?;
    serde_json::from_str(&body).map_err(|error| {
        let preview: String = body.chars().take(120).collect();
        if preview.trim_start().starts_with("<!doctype html")
            || preview.trim_start().starts_with("<html")
        {
            format!("接口返回了网页而不是 JSON，请检查中转站类型和地址: {error}")
        } else {
            format!("响应不是有效 JSON: {error}; 内容: {preview}")
        }
    })
}

fn fetch_json(agent: &ureq::Agent, url: &str, api_key: &str) -> Result<Value, String> {
    fetch_json_with_user_id(agent, url, api_key, None)
}

fn account_request_error(error: String, account_user_id: &str) -> String {
    if !error.starts_with("HTTP 401") {
        return error;
    }
    if account_user_id.trim().is_empty() {
        format!("{error}；此中转站版本还需要填写数字用户 ID")
    } else {
        format!("{error}；请确认用户 ID 与访问令牌属于同一账户，并重新生成已失效的令牌")
    }
}

fn fetch_balance(
    config: &BalanceProviderConfig,
    credential_value: &str,
) -> Result<BalanceSnapshot, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(10))
        .build();
    if config.preset == "openai-compatible" {
        let base = config.base_url.trim().trim_end_matches('/');
        let account = fetch_json_with_user_id(
            &agent,
            &format!("{base}/api/user/self"),
            credential_value,
            Some(&config.account_user_id),
        )
        .map_err(|error| {
            format!(
                "账户余额读取失败: {}",
                account_request_error(error, &config.account_user_id)
            )
        })?;
        let status = fetch_json(&agent, &format!("{base}/api/status"), credential_value).ok();
        return parse_new_api_account(&account, status.as_ref(), config)
            .map_err(|error| format!("账户余额读取失败: {error}"));
    }
    let value = fetch_json(&agent, &balance_url(config), credential_value)?;
    parse_balance(value, config)
}

#[tauri::command]
pub fn set_balance_provider(
    app: tauri::AppHandle,
    config: BalanceProviderConfig,
    api_key: Option<String>,
    account_token: Option<String>,
) -> Result<BalanceProviderConfig, String> {
    match api_key {
        Some(value) if !value.trim().is_empty() => write_credential(KEYRING_USER, "API Key", value.trim())?,
        Some(_) => clear_credential(KEYRING_USER),
        None => {}
    }
    match account_token {
        Some(value) if !value.trim().is_empty() => write_credential(KEYRING_ACCOUNT_USER, "账户访问令牌", value.trim())?,
        Some(_) => clear_credential(KEYRING_ACCOUNT_USER),
        None => {}
    }
    let mut config = config;
    config.has_api_key = None;
    config.has_account_token = None;
    save_config(&app, &config)?;
    config.has_api_key = Some(read_api_key()?.is_some());
    config.has_account_token = Some(read_account_token()?.is_some());
    Ok(config)
}

#[tauri::command]
pub fn get_balance_provider(app: tauri::AppHandle) -> Result<BalanceProviderConfig, String> {
    let mut config = load_config(&app);
    config.has_api_key = Some(read_api_key()?.is_some());
    config.has_account_token = Some(read_account_token()?.is_some());
    Ok(config)
}

#[tauri::command]
pub fn fetch_balance_snapshot(app: tauri::AppHandle) -> Result<BalanceSnapshot, String> {
    let config = load_config(&app);
    if !config.enabled {
        return Err("余额查询未启用".to_string());
    }
    let credential_value = if config.preset == "openai-compatible" {
        read_account_token()?.ok_or_else(|| {
            "真实账户余额需要账户访问令牌（PAT），请在余额设置中填写".to_string()
        })?
    } else {
        read_api_key()?.ok_or_else(|| "未配置 API Key".to_string())?
    };
    fetch_balance(&config, &credential_value)
}

#[tauri::command]
pub fn fetch_balance_details(app: tauri::AppHandle) -> Result<BalanceDetailsSnapshot, String> {
    let config = load_config(&app);
    if !config.enabled || config.preset != "openai-compatible" {
        return Err("余额详情仅支持已启用的 New API 中转站".to_string());
    }
    let account_token = read_account_token()?.ok_or_else(|| {
        "余额详情需要账户访问令牌（PAT），请在余额设置中填写".to_string()
    })?;
    let base = config.base_url.trim().trim_end_matches('/');
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(10))
        .build();
    let account = fetch_json_with_user_id(
        &agent,
        &format!("{base}/api/user/self"),
        &account_token,
        Some(&config.account_user_id),
    )
    .map_err(|error| {
        format!(
            "账户详情读取失败: {}",
            account_request_error(error, &config.account_user_id)
        )
    })?;
    let status = fetch_json(&agent, &format!("{base}/api/status"), &account_token).ok();
    let end_timestamp = chrono::Utc::now().timestamp();
    let start_timestamp = end_timestamp - 24 * 60 * 60;
    let usage_history = fetch_json_with_user_id(
        &agent,
        &format!(
            "{base}/api/data/self?start_timestamp={start_timestamp}&end_timestamp={end_timestamp}&default_time=hour"
        ),
        &account_token,
        Some(&config.account_user_id),
    )
    .map_err(|error| format!("24 小时用量读取失败: {error}"))?;
    parse_new_api_details(&account, status.as_ref(), &usage_history)
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

    #[test]
    fn parses_new_api_token_usage() {
        let value: Value = serde_json::from_str(
            r#"{"code":true,"message":"ok","data":{"total_granted":1000000,"total_used":12345,"total_available":987655,"unlimited_quota":false}}"#,
        )
        .unwrap();
        let config = BalanceProviderConfig {
            preset: "openai-compatible".to_string(),
            name: "家庭中转站".to_string(),
            ..BalanceProviderConfig::default()
        };
        let snapshot = parse_balance(value, &config).unwrap();
        assert_eq!(snapshot.total_balance, "987655");
        assert_eq!(snapshot.granted_balance, "1000000");
        assert_eq!(snapshot.topped_up_balance, "12345");
        assert_eq!(snapshot.currency, "额度");
    }

    #[test]
    fn uses_new_api_endpoint_without_redirect() {
        let config = BalanceProviderConfig {
            preset: "openai-compatible".to_string(),
            base_url: "http://gateway.example.test/".to_string(),
            ..BalanceProviderConfig::default()
        };
        assert_eq!(
            balance_url(&config),
            "http://gateway.example.test/api/usage/token/"
        );
    }

    #[test]
    fn parses_new_api_account_quota_in_cny() {
        let account: Value = serde_json::from_str(
            r#"{"success":true,"data":{"quota":686353000,"used_quota":110662000}}"#,
        )
        .unwrap();
        let status: Value = serde_json::from_str(
            r#"{"data":{"quota_display_type":"CNY","quota_per_unit":500000,"usd_exchange_rate":6.7}}"#,
        )
        .unwrap();
        let config = BalanceProviderConfig {
            preset: "openai-compatible".to_string(),
            ..BalanceProviderConfig::default()
        };
        let snapshot = parse_new_api_account(&account, Some(&status), &config).unwrap();
        assert_eq!(snapshot.total_balance, "9197.13");
        assert_eq!(snapshot.currency, "CNY");
    }

    #[test]
    fn parses_new_api_account_details_and_hourly_history() {
        let account: Value = serde_json::from_str(
            r#"{"success":true,"data":{"quota":686353000,"used_quota":110662000,"request_count":12282}}"#,
        )
        .unwrap();
        let status: Value = serde_json::from_str(
            r#"{"data":{"quota_display_type":"CNY","quota_per_unit":500000,"usd_exchange_rate":6.7}}"#,
        )
        .unwrap();
        let history: Value = serde_json::from_str(
            r#"{"success":true,"data":[{"created_at":1000,"quota":4000000,"count":8},{"created_at":1000,"quota":1000000,"count":2},{"created_at":4600,"quota":3838060,"count":5}]}"#,
        )
        .unwrap();
        let details = parse_new_api_details(&account, Some(&status), &history).unwrap();
        assert_eq!(details.remaining_balance, "9197.13");
        assert_eq!(details.historical_usage, "1482.87");
        assert_eq!(details.recent_usage, "118.43");
        assert_eq!(details.request_count, 12282);
        assert_eq!(details.history.len(), 2);
        assert_eq!(details.history[0].requests, 10);
    }

    #[test]
    fn old_config_defaults_account_user_id() {
        let config: BalanceProviderConfig = serde_json::from_str(
            r#"{"enabled":true,"name":"New API","preset":"openai-compatible","baseUrl":"http://127.0.0.1","refreshMinutes":30}"#,
        )
        .unwrap();
        assert!(config.account_user_id.is_empty());
    }

    #[test]
    fn explains_legacy_new_api_unauthorized_response() {
        let missing_id = account_request_error("HTTP 401: Unauthorized".to_string(), "");
        assert!(missing_id.contains("数字用户 ID"));
        let mismatched = account_request_error("HTTP 401: Unauthorized".to_string(), "7");
        assert!(mismatched.contains("同一账户"));
    }
}
