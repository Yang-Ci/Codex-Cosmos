import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { FolderOpen, RadioTower, RefreshCw, Save, Trash2 } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  RelayConfig,
  RelayDeviceInfo,
  RelayStats,
  RelayStatusEvent,
  RelayTransferComplete,
} from "./types";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(1)} ${units[index]}`;
}

function formatTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

const panelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: "10px 12px",
  borderRadius: 12,
  background: "rgba(12, 16, 30, 0.82)",
  border: "1px solid rgba(125, 211, 252, 0.18)",
  color: "#cdd6f4",
  fontSize: 12,
};

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
};

const titleStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontWeight: 600,
  color: "#89b4fa",
};

const toggleStyle = (enabled: boolean): CSSProperties => ({
  width: 36,
  height: 20,
  borderRadius: 10,
  border: "none",
  background: enabled ? "#a6e3a1" : "rgba(255,255,255,0.18)",
  cursor: "pointer",
  position: "relative",
  transition: "background 0.2s",
});

const dotStyle = (enabled: boolean): CSSProperties => ({
  position: "absolute",
  top: 2,
  left: enabled ? 18 : 2,
  width: 16,
  height: 16,
  borderRadius: 8,
  background: "#fff",
  transition: "left 0.2s",
});

const listStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  maxHeight: 150,
  overflowY: "auto",
};

const itemStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 8,
  padding: "4px 6px",
  borderRadius: 6,
  background: "rgba(255,255,255,0.04)",
};

const toastStyle: CSSProperties = {
  marginTop: 4,
  padding: "6px 8px",
  borderRadius: 8,
  background: "rgba(166, 227, 161, 0.18)",
  color: "#a6e3a1",
};

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "4px 6px",
  borderRadius: 6,
  border: "1px solid rgba(125, 211, 252, 0.2)",
  background: "rgba(255, 255, 255, 0.04)",
  color: "#cdd6f4",
  fontSize: 11,
  outline: "none",
};

const fieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 3,
};

const labelStyle: CSSProperties = {
  fontSize: 10,
  opacity: 0.6,
};

const saveBtnStyle = (disabled: boolean): CSSProperties => ({
  padding: "4px 10px",
  borderRadius: 6,
  border: "1px solid rgba(125, 211, 252, 0.25)",
  background: disabled ? "rgba(255,255,255,0.04)" : "rgba(137, 180, 250, 0.18)",
  color: disabled ? "rgba(205,214,244,0.4)" : "#89b4fa",
  fontSize: 11,
  cursor: disabled ? "default" : "pointer",
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
});

const browseBtnStyle: CSSProperties = {
  padding: "4px 8px",
  borderRadius: 6,
  border: "1px solid rgba(125, 211, 252, 0.2)",
  background: "rgba(255,255,255,0.06)",
  color: "#cdd6f4",
  fontSize: 11,
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  whiteSpace: "nowrap",
};

export function RelayPanel() {
  const [config, setConfig] = useState<RelayConfig | null>(null);
  const [devices, setDevices] = useState<RelayDeviceInfo[]>([]);
  const [stats, setStats] = useState<RelayStats | null>(null);
  const [status, setStatus] = useState<RelayStatusEvent | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [draftAlias, setDraftAlias] = useState("");
  const [draftDestination, setDraftDestination] = useState("");
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [cfg, dev, st] = await Promise.all([
        invoke<RelayConfig>("get_relay_config"),
        invoke<RelayDeviceInfo[]>("relay_devices"),
        invoke<RelayStats>("relay_stats"),
      ]);
      setConfig(cfg);
      setDevices(dev);
      setStats(st);
    } catch {
      // 后端不可用时静默；面板保留上次状态。
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 配置变更（含保存后拉回）时同步草稿，避免覆盖用户正在编辑的内容。
  useEffect(() => {
    if (config) {
      setDraftAlias(config.alias);
      setDraftDestination(config.destination);
    }
  }, [config]);

  useEffect(() => {
    const unlistens: UnlistenFn[] = [];
    let toastTimer: number | undefined;
    (async () => {
      unlistens.push(
        await listen<RelayStatusEvent>("relay-status", (event) => {
          setStatus(event.payload);
          void reload();
        }),
      );
      unlistens.push(
        await listen("relay-device-discovered", () => void reload()),
      );
      unlistens.push(
        await listen<RelayTransferComplete>("relay-transfer-complete", (event) => {
          const payload = event.payload;
          setToast(`收到 ${payload.filename} · ${formatBytes(payload.bytes)} · 来自 ${payload.sender}`);
          window.clearTimeout(toastTimer);
          toastTimer = window.setTimeout(() => setToast(null), 5000);
          void reload();
        }),
      );
      unlistens.push(
        await listen<{ error?: string }>("relay-transfer-error", (event) => {
          setToast(`投递失败：${event.payload?.error ?? "未知错误"}`);
          window.clearTimeout(toastTimer);
          toastTimer = window.setTimeout(() => setToast(null), 5000);
        }),
      );
    })();
    return () => {
      unlistens.forEach((unlisten) => unlisten());
      window.clearTimeout(toastTimer);
    };
  }, [reload]);

  useEffect(() => {
    if (!config?.enabled) return;
    const timer = window.setInterval(() => void reload(), 8000);
    return () => window.clearInterval(timer);
  }, [config?.enabled]);

  const toggleEnabled = async () => {
    if (!config) return;
    const next: RelayConfig = { ...config, enabled: !config.enabled };
    try {
      setConfig(await invoke<RelayConfig>("set_relay_config", { config: next }));
    } catch {
      // 忽略，下一次 reload 会拉回真实状态。
    }
  };

  const saveConfig = async () => {
    if (!config) return;
    setSaving(true);
    try {
      const next: RelayConfig = {
        ...config,
        alias: draftAlias.trim() || config.alias,
        destination: draftDestination.trim() || config.destination,
      };
      setConfig(await invoke<RelayConfig>("set_relay_config", { config: next }));
      setToast("设置已保存");
      window.setTimeout(() => setToast(null), 2500);
    } catch {
      // 忽略；reload 会拉回。
    } finally {
      setSaving(false);
    }
  };

  const browseDestination = async () => {
    const picked = await open({ directory: true });
    if (typeof picked === "string") setDraftDestination(picked);
  };

  const clearRecent = async () => {
    try {
      await invoke("clear_relay_recent");
      await reload();
    } catch {
      // 忽略。
    }
  };

  if (!config) return null;

  const running = status?.running ?? config.enabled;
  const error = status?.error;
  const destName =
    (config.destination || "").split(/[\\/]/).filter(Boolean).at(-1) ?? "下载";
  const dirty =
    draftAlias !== config.alias || draftDestination !== config.destination;

  return (
    <div className="relay-panel" style={panelStyle}>
      <div style={rowStyle}>
        <div style={titleStyle}>
          <RadioTower size={14} />
          <span>星际通讯站</span>
        </div>
        <button
          style={toggleStyle(config.enabled)}
          title={config.enabled ? "已启用" : "已关闭"}
          onClick={() => void toggleEnabled()}
        >
          <span style={dotStyle(config.enabled)} />
        </button>
      </div>

      <div style={fieldStyle}>
        <span style={labelStyle}>设备名称</span>
        <input
          style={inputStyle}
          value={draftAlias}
          onChange={(event) => setDraftAlias(event.target.value)}
          placeholder="Codex Cosmos"
          spellCheck={false}
        />
      </div>

      <div style={fieldStyle}>
        <span style={labelStyle}>接收目录</span>
        <div style={{ display: "flex", gap: 4 }}>
          <input
            style={{ ...inputStyle, flex: 1 }}
            value={draftDestination}
            onChange={(event) => setDraftDestination(event.target.value)}
            placeholder="C:\\Users\\...\\Downloads"
            spellCheck={false}
          />
          <button style={browseBtnStyle} onClick={() => void browseDestination()}>
            <FolderOpen size={11} />
            浏览
          </button>
        </div>
      </div>

      <div style={rowStyle}>
        <span style={{ fontSize: 10, opacity: 0.45 }}>
          {dirty ? "有未保存的改动" : "已是最新"}
        </span>
        <button
          style={saveBtnStyle(saving || !dirty)}
          disabled={saving || !dirty}
          onClick={() => void saveConfig()}
        >
          <Save size={11} />
          {saving ? "保存中…" : "保存设置"}
        </button>
      </div>

      {config.enabled && (
        <>
          <div style={{ fontSize: 11, opacity: 0.7, ...rowStyle }}>
            <span>
              {running ? "监听中" : "未启动"} · 端口 {config.port} · {config.alias}
            </span>
            <FolderOpen size={12} />
          </div>
          <div style={{ fontSize: 11, opacity: 0.6 }}>
            接收目录：<span title={config.destination}>{destName}</span>
          </div>
          {error && (
            <div style={{ color: "#f38ba8", fontSize: 11 }}>{error}</div>
          )}
        </>
      )}

      {config.enabled && (
        <div>
          <div style={{ ...rowStyle, marginBottom: 4 }}>
            <span style={{ opacity: 0.7, fontSize: 11 }}>邻近星体</span>
            <RefreshCw size={11} style={{ cursor: "pointer", opacity: 0.6 }} onClick={() => void reload()} />
          </div>
          <div style={listStyle}>
            {devices.length === 0 && (
              <div style={{ opacity: 0.5, fontSize: 11, padding: "4px 6px" }}>
                等待设备广播…打开手机 LocalSend 即可发现本机
              </div>
            )}
            {devices.map((device) => (
              <div key={device.fingerprint} style={itemStyle}>
                <span>{device.alias || "未命名设备"}</span>
                <span style={{ opacity: 0.5, fontSize: 10 }}>
                  {device.deviceType}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {stats && stats.totalReceived > 0 && (
        <div>
          <div style={{ ...rowStyle, marginBottom: 4 }}>
            <span style={{ opacity: 0.7, fontSize: 11 }}>
              累计接收 {stats.totalReceived} 个 · {formatBytes(stats.totalBytes)}
            </span>
            <Trash2
              size={11}
              style={{ cursor: "pointer", opacity: 0.6 }}
              onClick={() => void clearRecent()}
            />
          </div>
          <div style={listStyle}>
            {stats.recent
              .slice()
              .reverse()
              .map((record) => (
                <div key={`${record.receivedAt}-${record.filename}`} style={itemStyle}>
                  <span title={record.destination}>{record.filename}</span>
                  <span style={{ opacity: 0.5, fontSize: 10 }}>
                    {formatBytes(record.bytes)} · {formatTime(record.receivedAt)}
                  </span>
                </div>
              ))}
          </div>
        </div>
      )}

      {toast && <div style={toastStyle}>{toast}</div>}
    </div>
  );
}
