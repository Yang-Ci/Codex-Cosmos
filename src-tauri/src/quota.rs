use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    cmp::Reverse,
    env,
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;
use walkdir::WalkDir;

const MAX_SESSION_FILES: usize = 50;
const MAX_TAIL_BYTES: u64 = 2 * 1024 * 1024;
const HISTORY_DAYS: i64 = 45;
const RESET_TIME_TOLERANCE_SECONDS: u64 = 5 * 60;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RateWindow {
    pub used_percent: f64,
    pub remaining_percent: f64,
    pub window_minutes: i64,
    pub resets_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreditStatus {
    pub has_credits: bool,
    pub unlimited: bool,
    pub balance: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaSnapshot {
    pub found: bool,
    pub sampled_at: String,
    pub plan_type: String,
    pub limit_id: String,
    pub primary: RateWindow,
    pub secondary: Option<RateWindow>,
    pub credits: Option<CreditStatus>,
    pub source: String,
    pub stale: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaHistoryPoint {
    pub sampled_at: i64,
    pub used_percent: f64,
    pub window_minutes: i64,
    #[serde(default)]
    pub resets_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthlyEstimate {
    pub used_percent: f64,
    pub confidence: String,
    pub samples: usize,
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PulseData {
    pub quota: Option<QuotaSnapshot>,
    pub history: Vec<QuotaHistoryPoint>,
    pub monthly_estimate: MonthlyEstimate,
    pub error: Option<String>,
}

#[derive(Debug)]
struct CandidateEvent {
    sampled_at: DateTime<Utc>,
    snapshot: QuotaSnapshot,
}

pub fn collect_pulse_data(app: &tauri::AppHandle) -> Result<PulseData, String> {
    let latest = find_latest_quota()?;
    let history_path = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法找到应用数据目录: {error}"))?
        .join("quota-history.json");

    let mut history = read_history(&history_path);
    if let Some(event) = latest.as_ref() {
        record_sample(&mut history, event);
        write_history(&history_path, &history)?;
    }

    let cutoff = Utc::now().timestamp() - HISTORY_DAYS * 86_400;
    history.retain(|point| point.sampled_at >= cutoff);
    let estimate = estimate_monthly_usage(&history);

    Ok(PulseData {
        quota: latest.map(|event| event.snapshot),
        history,
        monthly_estimate: estimate,
        error: None,
    })
}

fn codex_home() -> Result<PathBuf, String> {
    if let Ok(path) = env::var("CODEX_HOME") {
        if !path.trim().is_empty() {
            return Ok(PathBuf::from(path));
        }
    }
    dirs::home_dir()
        .map(|home| home.join(".codex"))
        .ok_or_else(|| "无法找到用户主目录".to_string())
}

fn find_latest_quota() -> Result<Option<CandidateEvent>, String> {
    let root = codex_home()?;
    let mut candidates: Vec<(SystemTime, PathBuf)> = Vec::new();

    for folder in [root.join("sessions"), root.join("archived_sessions")] {
        if !folder.exists() {
            continue;
        }
        for entry in WalkDir::new(folder).follow_links(false).into_iter().filter_map(Result::ok) {
            if !entry.file_type().is_file()
                || entry.path().extension().and_then(|value| value.to_str()) != Some("jsonl")
            {
                continue;
            }
            let modified = entry
                .metadata()
                .ok()
                .and_then(|metadata| metadata.modified().ok())
                .unwrap_or(UNIX_EPOCH);
            candidates.push((modified, entry.path().to_path_buf()));
        }
    }

    candidates.sort_by_key(|(modified, _)| Reverse(*modified));
    candidates.truncate(MAX_SESSION_FILES);

    let mut latest: Option<CandidateEvent> = None;
    for (_, path) in candidates {
        for line in read_tail_lines(&path)? {
            let Some(event) = parse_quota_event(&line) else {
                continue;
            };
            if latest
                .as_ref()
                .map(|current| event.sampled_at > current.sampled_at)
                .unwrap_or(true)
            {
                latest = Some(event);
            }
        }
    }

    Ok(latest)
}

fn read_tail_lines(path: &Path) -> Result<Vec<String>, String> {
    let mut file = File::open(path).map_err(|error| format!("读取 Codex 会话失败: {error}"))?;
    let length = file
        .metadata()
        .map_err(|error| format!("读取会话信息失败: {error}"))?
        .len();
    let start = length.saturating_sub(MAX_TAIL_BYTES);
    file.seek(SeekFrom::Start(start))
        .map_err(|error| format!("定位会话文件失败: {error}"))?;
    let mut buffer = Vec::with_capacity((length - start) as usize);
    file.read_to_end(&mut buffer)
        .map_err(|error| format!("读取会话尾部失败: {error}"))?;
    let text = String::from_utf8_lossy(&buffer);
    let mut lines = text.lines();
    if start > 0 {
        let _ = lines.next();
    }
    Ok(lines
        .filter(|line| line.contains("\"rate_limits\"") && line.contains("\"token_count\""))
        .map(str::to_owned)
        .collect())
}

fn parse_quota_event(line: &str) -> Option<CandidateEvent> {
    let value: Value = serde_json::from_str(line).ok()?;
    if value.get("type")?.as_str()? != "event_msg"
        || value.pointer("/payload/type")?.as_str()? != "token_count"
    {
        return None;
    }

    let sampled_at = DateTime::parse_from_rfc3339(value.get("timestamp")?.as_str()?)
        .ok()?
        .with_timezone(&Utc);
    let limits = value.pointer("/payload/rate_limits")?;
    let primary = parse_window(limits.get("primary")?)?;
    let secondary = limits.get("secondary").and_then(parse_window);
    let credits = limits.get("credits").and_then(|credits| {
        Some(CreditStatus {
            has_credits: credits.get("has_credits")?.as_bool().unwrap_or(false),
            unlimited: credits.get("unlimited")?.as_bool().unwrap_or(false),
            balance: value_as_string(credits.get("balance")),
        })
    });
    let stale = Utc::now()
        .signed_duration_since(sampled_at)
        .num_hours()
        >= 6;

    Some(CandidateEvent {
        sampled_at,
        snapshot: QuotaSnapshot {
            found: true,
            sampled_at: sampled_at.to_rfc3339(),
            plan_type: limits
                .get("plan_type")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string(),
            limit_id: limits
                .get("limit_id")
                .and_then(Value::as_str)
                .unwrap_or("codex")
                .to_string(),
            primary,
            secondary,
            credits,
            source: "local-session".to_string(),
            stale,
        },
    })
}

fn parse_window(value: &Value) -> Option<RateWindow> {
    let used = value.get("used_percent")?.as_f64()?;
    Some(RateWindow {
        used_percent: used,
        remaining_percent: (100.0 - used).clamp(0.0, 100.0),
        window_minutes: value.get("window_minutes")?.as_i64()?,
        resets_at: value.get("resets_at")?.as_i64()?,
    })
}

fn value_as_string(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => number.to_string(),
        _ => String::new(),
    }
}

fn read_history(path: &Path) -> Vec<QuotaHistoryPoint> {
    fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default()
}

fn write_history(path: &Path, history: &[QuotaHistoryPoint]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建历史目录失败: {error}"))?;
    }
    let content = serde_json::to_string(history).map_err(|error| format!("序列化历史失败: {error}"))?;
    fs::write(path, content).map_err(|error| format!("保存额度历史失败: {error}"))
}

fn record_sample(history: &mut Vec<QuotaHistoryPoint>, event: &CandidateEvent) {
    let point = QuotaHistoryPoint {
        sampled_at: event.sampled_at.timestamp(),
        used_percent: event.snapshot.primary.used_percent,
        window_minutes: event.snapshot.primary.window_minutes,
        resets_at: event.snapshot.primary.resets_at,
    };

    let should_append = history.last().map_or(true, |previous| {
        point.sampled_at - previous.sampled_at >= 15 * 60
            || (point.used_percent - previous.used_percent).abs() >= 0.1
            || !same_quota_cycle(previous, &point)
    });
    if should_append {
        history.push(point);
    }
    history.sort_by_key(|point| point.sampled_at);
    history.dedup_by_key(|point| point.sampled_at);
    if history.len() > 2_000 {
        history.drain(0..history.len() - 2_000);
    }
}

fn same_quota_cycle(left: &QuotaHistoryPoint, right: &QuotaHistoryPoint) -> bool {
    if left.window_minutes != right.window_minutes {
        return false;
    }
    if left.resets_at <= 0 || right.resets_at <= 0 {
        return left.resets_at == right.resets_at;
    }
    left.resets_at.abs_diff(right.resets_at) <= RESET_TIME_TOLERANCE_SECONDS
}

fn estimate_monthly_usage(history: &[QuotaHistoryPoint]) -> MonthlyEstimate {
    if history.len() < 2 {
        return MonthlyEstimate {
            used_percent: 0.0,
            confidence: "low".to_string(),
            samples: history.len(),
            label: "数据不足".to_string(),
        };
    }

    let mut consumption = 0.0;
    let mut cycle_peak = history[0].used_percent.max(0.0);
    for pair in history.windows(2) {
        let previous = &pair[0];
        let current = &pair[1];
        if !same_quota_cycle(previous, current) {
            consumption += current.used_percent.max(0.0);
            cycle_peak = current.used_percent.max(0.0);
        } else if current.used_percent > cycle_peak {
            consumption += current.used_percent - cycle_peak;
            cycle_peak = current.used_percent;
        }
    }

    let observed_days = ((history.last().unwrap().sampled_at - history.first().unwrap().sampled_at) as f64
        / 86_400.0)
        .max(1.0);
    let estimate = (consumption / observed_days * 30.0).clamp(0.0, 999.0);
    let confidence = if observed_days >= 14.0 && history.len() >= 20 {
        "high"
    } else if observed_days >= 3.0 && history.len() >= 5 {
        "medium"
    } else {
        "low"
    };

    MonthlyEstimate {
        used_percent: estimate,
        confidence: confidence.to_string(),
        samples: history.len(),
        label: "30 天本地估算".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_realistic_quota_event() {
        let line = r#"{"timestamp":"2026-08-13T12:20:15.223Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"limit_id":"codex","primary":{"used_percent":35.0,"window_minutes":10080,"resets_at":1787204698},"secondary":null,"credits":{"has_credits":false,"unlimited":false,"balance":"0"},"plan_type":"plus"}}}"#;
        let event = parse_quota_event(line).expect("quota event should parse");
        assert_eq!(event.snapshot.primary.remaining_percent, 65.0);
        assert_eq!(event.snapshot.plan_type, "plus");
        assert!(event.snapshot.secondary.is_none());
    }

    #[test]
    fn estimates_consumption_across_reset() {
        let history = vec![
            QuotaHistoryPoint { sampled_at: 1_000_000, used_percent: 60.0, window_minutes: 10080, resets_at: 2_000_000 },
            QuotaHistoryPoint { sampled_at: 1_086_400, used_percent: 80.0, window_minutes: 10080, resets_at: 2_000_000 },
            QuotaHistoryPoint { sampled_at: 1_172_800, used_percent: 10.0, window_minutes: 10080, resets_at: 3_000_000 },
        ];
        let estimate = estimate_monthly_usage(&history);
        assert_eq!(estimate.samples, 3);
        assert!(estimate.used_percent > 0.0);
    }

    #[test]
    fn treats_reset_time_jitter_as_the_same_cycle() {
        let left = QuotaHistoryPoint { sampled_at: 1_000_000, used_percent: 47.0, window_minutes: 10080, resets_at: 2_000_000 };
        let right = QuotaHistoryPoint { sampled_at: 1_000_060, used_percent: 47.0, window_minutes: 10080, resets_at: 2_000_119 };
        assert!(same_quota_cycle(&left, &right));
    }

    #[test]
    fn monthly_estimate_ignores_same_cycle_regressions_and_rebounds() {
        let day = 86_400;
        let history = vec![
            QuotaHistoryPoint { sampled_at: 1_000_000, used_percent: 40.0, window_minutes: 10080, resets_at: 2_000_000 },
            QuotaHistoryPoint { sampled_at: 1_000_000 + day, used_percent: 47.0, window_minutes: 10080, resets_at: 2_000_060 },
            QuotaHistoryPoint { sampled_at: 1_000_000 + day * 2, used_percent: 39.0, window_minutes: 10080, resets_at: 1_999_940 },
            QuotaHistoryPoint { sampled_at: 1_000_000 + day * 3, used_percent: 49.0, window_minutes: 10080, resets_at: 2_000_030 },
        ];
        let estimate = estimate_monthly_usage(&history);
        assert!((estimate.used_percent - 90.0).abs() < f64::EPSILON);
    }
}
