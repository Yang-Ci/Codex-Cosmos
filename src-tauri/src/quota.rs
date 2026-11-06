use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    cmp::Reverse,
    collections::BTreeMap,
    env,
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;
use walkdir::WalkDir;

const RECENT_SESSION_FILES: usize = 50;
const MAX_SESSION_FILES: usize = 250;
const MAX_TAIL_BYTES: u64 = 2 * 1024 * 1024;
const HISTORY_DAYS: i64 = 45;
const RESET_TIME_TOLERANCE_SECONDS: u64 = 5 * 60;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RateWindow {
    pub used_percent: f64,
    pub remaining_percent: f64,
    pub window_minutes: i64,
    pub resets_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreditStatus {
    pub has_credits: bool,
    pub unlimited: bool,
    pub balance: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Default)]
struct QuotaScan {
    events: Vec<CandidateEvent>,
    skipped_files: usize,
}

pub fn collect_pulse_data(app: &tauri::AppHandle) -> Result<PulseData, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法找到应用数据目录: {error}"))?;
    let history_path = data_dir.join("quota-history.json");
    let snapshot_path = data_dir.join("quota-snapshot.json");
    let mut warnings = Vec::new();

    let scan = match find_quota_events() {
        Ok(scan) => scan,
        Err(error) => {
            warnings.push(error);
            QuotaScan::default()
        }
    };
    if scan.skipped_files > 0 {
        warnings.push(format!(
            "已跳过 {} 个暂时无法读取的 Codex 会话文件",
            scan.skipped_files
        ));
    }

    let mut latest = scan.events.last().map(|event| event.snapshot.clone());

    let mut history = read_history(&history_path);
    if !scan.events.is_empty() {
        merge_samples(&mut history, &scan.events);
    }

    let cutoff = Utc::now().timestamp() - HISTORY_DAYS * 86_400;
    history.retain(|point| point.sampled_at >= cutoff);
    if !scan.events.is_empty() {
        if let Err(error) = write_history(&history_path, &history) {
            warnings.push(error);
        }
    }

    if let Some(snapshot) = latest.as_ref() {
        if let Err(error) = write_snapshot(&snapshot_path, snapshot) {
            warnings.push(error);
        }
    } else {
        latest = read_snapshot(&snapshot_path)
            .map(|snapshot| mark_cached(snapshot, "local-cache"))
            .or_else(|| snapshot_from_history(&history));
        if latest.is_some() {
            warnings.push("未发现新的官方额度事件，正在显示上次成功数据".to_string());
        } else {
            warnings.push("未找到可用的 Codex 官方额度事件".to_string());
        }
    }

    let estimate_window = latest.as_ref().map(|snapshot| {
        snapshot
            .secondary
            .as_ref()
            .filter(|secondary| secondary.window_minutes > snapshot.primary.window_minutes)
            .map(|secondary| secondary.window_minutes)
            .unwrap_or(snapshot.primary.window_minutes)
    });
    let estimate_history: Vec<_> = history
        .iter()
        .filter(|point| estimate_window.map_or(true, |window| point.window_minutes == window))
        .cloned()
        .collect();
    let estimate = estimate_monthly_usage(&estimate_history);

    Ok(PulseData {
        quota: latest,
        history,
        monthly_estimate: estimate,
        error: (!warnings.is_empty()).then(|| warnings.join("；")),
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

fn find_quota_events() -> Result<QuotaScan, String> {
    let root = codex_home()?;
    let mut candidates: Vec<(SystemTime, PathBuf)> = Vec::new();

    for folder in [root.join("sessions"), root.join("archived_sessions")] {
        if !folder.exists() {
            continue;
        }
        for entry in WalkDir::new(folder)
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
        {
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
    Ok(scan_quota_candidates(
        candidates.into_iter().map(|(_, path)| path),
    ))
}

fn scan_quota_candidates(paths: impl IntoIterator<Item = PathBuf>) -> QuotaScan {
    let mut scan = QuotaScan::default();
    for (index, path) in paths.into_iter().enumerate() {
        let lines = match read_tail_lines(&path) {
            Ok(lines) => lines,
            Err(_) => {
                scan.skipped_files += 1;
                continue;
            }
        };
        for line in lines {
            let Some(event) = parse_quota_event(&line) else {
                continue;
            };
            scan.events.push(event);
        }
        if index + 1 >= RECENT_SESSION_FILES && !scan.events.is_empty() {
            break;
        }
    }

    scan.events.sort_by_key(|event| event.sampled_at);
    scan.events.dedup_by_key(|event| event.sampled_at);
    scan
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
    let stale = Utc::now().signed_duration_since(sampled_at).num_hours() >= 6;

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

fn read_snapshot(path: &Path) -> Option<QuotaSnapshot> {
    fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
}

fn write_snapshot(path: &Path, snapshot: &QuotaSnapshot) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建额度缓存目录失败: {error}"))?;
    }
    let content =
        serde_json::to_string(snapshot).map_err(|error| format!("序列化额度缓存失败: {error}"))?;
    fs::write(path, content).map_err(|error| format!("保存额度缓存失败: {error}"))
}

fn snapshot_is_stale(sampled_at: &str) -> bool {
    DateTime::parse_from_rfc3339(sampled_at)
        .map(|sampled_at| {
            Utc::now()
                .signed_duration_since(sampled_at.with_timezone(&Utc))
                .num_hours()
                >= 6
        })
        .unwrap_or(true)
}

fn mark_cached(mut snapshot: QuotaSnapshot, source: &str) -> QuotaSnapshot {
    snapshot.stale = snapshot_is_stale(&snapshot.sampled_at);
    snapshot.source = source.to_string();
    snapshot
}

fn snapshot_from_history(history: &[QuotaHistoryPoint]) -> Option<QuotaSnapshot> {
    let mut latest_by_window = BTreeMap::new();
    for point in history {
        latest_by_window
            .entry(point.window_minutes)
            .and_modify(|current: &mut QuotaHistoryPoint| {
                if point.sampled_at > current.sampled_at {
                    *current = point.clone();
                }
            })
            .or_insert_with(|| point.clone());
    }

    let mut points = latest_by_window.into_values();
    let primary_point = points.next()?;
    let secondary_point = points.next_back();
    let sampled_at = DateTime::<Utc>::from_timestamp(primary_point.sampled_at, 0)?.to_rfc3339();
    let primary = window_from_history(&primary_point);
    let secondary = secondary_point.as_ref().map(window_from_history);

    Some(mark_cached(
        QuotaSnapshot {
            found: true,
            sampled_at,
            plan_type: "unknown".to_string(),
            limit_id: "codex".to_string(),
            primary,
            secondary,
            credits: None,
            source: "history-cache".to_string(),
            stale: true,
        },
        "history-cache",
    ))
}

fn window_from_history(point: &QuotaHistoryPoint) -> RateWindow {
    RateWindow {
        used_percent: point.used_percent,
        remaining_percent: (100.0 - point.used_percent).clamp(0.0, 100.0),
        window_minutes: point.window_minutes,
        resets_at: point.resets_at,
    }
}

fn write_history(path: &Path, history: &[QuotaHistoryPoint]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建历史目录失败: {error}"))?;
    }
    let content =
        serde_json::to_string(history).map_err(|error| format!("序列化历史失败: {error}"))?;
    fs::write(path, content).map_err(|error| format!("保存额度历史失败: {error}"))
}

fn history_point(sampled_at: i64, window: &RateWindow) -> QuotaHistoryPoint {
    QuotaHistoryPoint {
        sampled_at,
        used_percent: window.used_percent,
        window_minutes: window.window_minutes,
        resets_at: window.resets_at,
    }
}

fn history_points(event: &CandidateEvent) -> Vec<QuotaHistoryPoint> {
    let sampled_at = event.sampled_at.timestamp();
    let mut points = vec![history_point(sampled_at, &event.snapshot.primary)];
    if let Some(secondary) = event.snapshot.secondary.as_ref() {
        if secondary.window_minutes != event.snapshot.primary.window_minutes {
            points.push(history_point(sampled_at, secondary));
        }
    }
    points
}

fn should_append_sample(previous: Option<&QuotaHistoryPoint>, point: &QuotaHistoryPoint) -> bool {
    previous.map_or(true, |previous| {
        point.sampled_at - previous.sampled_at >= 15 * 60
            || (point.used_percent - previous.used_percent).abs() >= 0.1
            || !same_quota_cycle(previous, point)
    })
}

fn merge_samples(history: &mut Vec<QuotaHistoryPoint>, events: &[CandidateEvent]) {
    let mut points_by_window_and_time = BTreeMap::new();
    for point in history.drain(..) {
        points_by_window_and_time.insert((point.window_minutes, point.sampled_at), point);
    }
    for event in events {
        for point in history_points(event) {
            // Fresh session data takes precedence over a stored sample for the same window and time.
            points_by_window_and_time.insert((point.window_minutes, point.sampled_at), point);
        }
    }

    let mut compacted: Vec<QuotaHistoryPoint> = Vec::new();
    let mut previous_by_window = BTreeMap::new();
    for point in points_by_window_and_time.into_values() {
        if should_append_sample(previous_by_window.get(&point.window_minutes), &point) {
            previous_by_window.insert(point.window_minutes, point.clone());
            compacted.push(point);
        }
    }
    compacted.sort_by_key(|point| (point.sampled_at, point.window_minutes));
    if compacted.len() > 2_000 {
        compacted.drain(0..compacted.len() - 2_000);
    }
    *history = compacted;
}

#[cfg(test)]
fn record_sample(history: &mut Vec<QuotaHistoryPoint>, event: &CandidateEvent) {
    merge_samples(history, std::slice::from_ref(event));
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

    let observed_days = ((history.last().unwrap().sampled_at - history.first().unwrap().sampled_at)
        as f64
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

    fn test_directory(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = env::temp_dir().join(format!(
            "codex-cosmos-quota-{name}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn valid_quota_line() -> &'static str {
        r#"{"timestamp":"2026-08-28T03:43:26.893Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"limit_id":"codex","primary":{"used_percent":38.0,"window_minutes":300,"resets_at":1787898519},"secondary":{"used_percent":15.0,"window_minutes":10080,"resets_at":1788485319},"plan_type":"plus"}}}"#
    }

    #[test]
    fn parses_realistic_quota_event() {
        let line = r#"{"timestamp":"2026-08-13T12:20:15.223Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"limit_id":"codex","primary":{"used_percent":35.0,"window_minutes":10080,"resets_at":1787204698},"secondary":null,"credits":{"has_credits":false,"unlimited":false,"balance":"0"},"plan_type":"plus"}}}"#;
        let event = parse_quota_event(line).expect("quota event should parse");
        assert_eq!(event.snapshot.primary.remaining_percent, 65.0);
        assert_eq!(event.snapshot.plan_type, "plus");
        assert!(event.snapshot.secondary.is_none());
    }

    #[test]
    fn parses_five_hour_and_weekly_windows() {
        let line = r#"{"timestamp":"2026-08-28T03:43:26.893Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"limit_id":"codex","primary":{"used_percent":98.0,"window_minutes":300,"resets_at":1787898519},"secondary":{"used_percent":15.0,"window_minutes":10080,"resets_at":1788485319},"credits":{"has_credits":false,"unlimited":false,"balance":"0"},"plan_type":"plus"}}}"#;
        let event = parse_quota_event(line).expect("quota event should parse");
        let weekly = event
            .snapshot
            .secondary
            .as_ref()
            .expect("weekly window should exist");
        assert_eq!(event.snapshot.primary.window_minutes, 300);
        assert_eq!(event.snapshot.primary.remaining_percent, 2.0);
        assert_eq!(weekly.window_minutes, 10_080);
        assert_eq!(weekly.remaining_percent, 85.0);
    }

    #[test]
    fn scan_continues_past_custom_provider_sessions() {
        let root = test_directory("custom-fallback");
        let mut paths = Vec::new();
        let custom_line = r#"{"timestamp":"2026-08-28T03:43:26.893Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":null,"secondary":null}}}"#;
        for index in 0..RECENT_SESSION_FILES {
            let path = root.join(format!("custom-{index}.jsonl"));
            fs::write(&path, custom_line).unwrap();
            paths.push(path);
        }
        let official_path = root.join("official.jsonl");
        fs::write(&official_path, valid_quota_line()).unwrap();
        paths.push(official_path);

        let scan = scan_quota_candidates(paths);

        assert_eq!(scan.events.len(), 1);
        assert_eq!(scan.events[0].snapshot.primary.window_minutes, 300);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn scan_skips_a_disappeared_session_file() {
        let root = test_directory("skip-missing");
        let missing = root.join("already-removed.jsonl");
        let official_path = root.join("official.jsonl");
        fs::write(&official_path, valid_quota_line()).unwrap();

        let scan = scan_quota_candidates(vec![missing, official_path]);

        assert_eq!(scan.skipped_files, 1);
        assert_eq!(scan.events.len(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rebuilds_a_cached_snapshot_from_history() {
        let history = vec![
            QuotaHistoryPoint {
                sampled_at: 1_787_898_000,
                used_percent: 38.0,
                window_minutes: 300,
                resets_at: 1_787_898_519,
            },
            QuotaHistoryPoint {
                sampled_at: 1_787_898_000,
                used_percent: 15.0,
                window_minutes: 10_080,
                resets_at: 1_788_485_319,
            },
        ];

        let snapshot = snapshot_from_history(&history).unwrap();

        assert_eq!(snapshot.source, "history-cache");
        assert_eq!(snapshot.primary.remaining_percent, 62.0);
        assert_eq!(snapshot.secondary.unwrap().remaining_percent, 85.0);
    }

    #[test]
    fn history_tracks_both_official_windows_when_available() {
        let event = CandidateEvent {
            sampled_at: DateTime::parse_from_rfc3339("2026-08-28T03:43:26.893Z")
                .unwrap()
                .with_timezone(&Utc),
            snapshot: QuotaSnapshot {
                found: true,
                sampled_at: "2026-08-28T03:43:26.893Z".to_string(),
                plan_type: "plus".to_string(),
                limit_id: "codex".to_string(),
                primary: RateWindow {
                    used_percent: 98.0,
                    remaining_percent: 2.0,
                    window_minutes: 300,
                    resets_at: 1_787_898_519,
                },
                secondary: Some(RateWindow {
                    used_percent: 15.0,
                    remaining_percent: 85.0,
                    window_minutes: 10_080,
                    resets_at: 1_788_485_319,
                }),
                credits: None,
                source: "local-session".to_string(),
                stale: false,
            },
        };
        let mut history = Vec::new();
        record_sample(&mut history, &event);
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].window_minutes, 300);
        assert_eq!(history[0].used_percent, 98.0);
        assert_eq!(history[1].window_minutes, 10_080);
        assert_eq!(history[1].used_percent, 15.0);
    }

    #[test]
    fn session_backfill_keeps_separate_five_hour_and_weekly_series() {
        let first = parse_quota_event(r#"{"timestamp":"2026-08-28T03:43:26.893Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":98.0,"window_minutes":300,"resets_at":1787898519},"secondary":{"used_percent":15.0,"window_minutes":10080,"resets_at":1788485319}}}}"#).unwrap();
        let second = parse_quota_event(r#"{"timestamp":"2026-08-28T04:03:26.893Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":2.0,"window_minutes":300,"resets_at":1787902119},"secondary":{"used_percent":16.0,"window_minutes":10080,"resets_at":1788485319}}}}"#).unwrap();
        let mut history = vec![
            QuotaHistoryPoint {
                sampled_at: first.sampled_at.timestamp(),
                used_percent: 98.0,
                window_minutes: 300,
                resets_at: 1_787_898_519,
            },
            QuotaHistoryPoint {
                sampled_at: first.sampled_at.timestamp() + 60,
                used_percent: 99.0,
                window_minutes: 300,
                resets_at: 1_787_898_519,
            },
        ];

        merge_samples(&mut history, &[first, second]);

        let five_hour: Vec<_> = history
            .iter()
            .filter(|point| point.window_minutes == 300)
            .collect();
        let weekly: Vec<_> = history
            .iter()
            .filter(|point| point.window_minutes == 10_080)
            .collect();
        assert_eq!(five_hour.len(), 3);
        assert_eq!(weekly.len(), 2);
        assert_eq!(weekly[0].used_percent, 15.0);
        assert_eq!(weekly[1].used_percent, 16.0);
    }

    #[test]
    fn estimates_consumption_across_reset() {
        let history = vec![
            QuotaHistoryPoint {
                sampled_at: 1_000_000,
                used_percent: 60.0,
                window_minutes: 10080,
                resets_at: 2_000_000,
            },
            QuotaHistoryPoint {
                sampled_at: 1_086_400,
                used_percent: 80.0,
                window_minutes: 10080,
                resets_at: 2_000_000,
            },
            QuotaHistoryPoint {
                sampled_at: 1_172_800,
                used_percent: 10.0,
                window_minutes: 10080,
                resets_at: 3_000_000,
            },
        ];
        let estimate = estimate_monthly_usage(&history);
        assert_eq!(estimate.samples, 3);
        assert!(estimate.used_percent > 0.0);
    }

    #[test]
    fn treats_reset_time_jitter_as_the_same_cycle() {
        let left = QuotaHistoryPoint {
            sampled_at: 1_000_000,
            used_percent: 47.0,
            window_minutes: 10080,
            resets_at: 2_000_000,
        };
        let right = QuotaHistoryPoint {
            sampled_at: 1_000_060,
            used_percent: 47.0,
            window_minutes: 10080,
            resets_at: 2_000_119,
        };
        assert!(same_quota_cycle(&left, &right));
    }

    #[test]
    fn monthly_estimate_ignores_same_cycle_regressions_and_rebounds() {
        let day = 86_400;
        let history = vec![
            QuotaHistoryPoint {
                sampled_at: 1_000_000,
                used_percent: 40.0,
                window_minutes: 10080,
                resets_at: 2_000_000,
            },
            QuotaHistoryPoint {
                sampled_at: 1_000_000 + day,
                used_percent: 47.0,
                window_minutes: 10080,
                resets_at: 2_000_060,
            },
            QuotaHistoryPoint {
                sampled_at: 1_000_000 + day * 2,
                used_percent: 39.0,
                window_minutes: 10080,
                resets_at: 1_999_940,
            },
            QuotaHistoryPoint {
                sampled_at: 1_000_000 + day * 3,
                used_percent: 49.0,
                window_minutes: 10080,
                resets_at: 2_000_030,
            },
        ];
        let estimate = estimate_monthly_usage(&history);
        assert!((estimate.used_percent - 90.0).abs() < f64::EPSILON);
    }
}
