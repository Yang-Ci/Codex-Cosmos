import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { FolderOpen, RadioTower, RefreshCw, Save, Send, Trash2 } from "lucide-react";
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

const sendBtnStyle = (disabled: boolean): CSSProperties => ({
  width: 27,
  height: 24,
  flex: "0 0 auto",
  display: "grid",
  placeItems: "center",
  padding: 0,
  borderRadius: 6,
  border: "1px solid rgba(137, 180, 250, 0.25)",
  background: disabled ? "rgba(255,255,255,0.04)" : "rgba(137, 180, 250, 0.14)",
  color: disabled ? "rgba(205,214,244,0.35)" : "#89b4fa",
  cursor: disabled ? "wait" : "pointer",
});

export function RelayPanel() {
  const [config, setConfig] = useState<RelayConfig | null>(null);
  const [devices, setDevices] = useState<RelayDeviceInfo[]>([]);
  const [stats, setStats] = useState<RelayStats | null>(null);
  const [status, setStatus] = useState<RelayStatusEvent | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [draftAlias, setDraftAlias] = useState("");
  const [draftDestination, setDraftDestination] = useState("");
  const [saving, setSaving] = useState(false);
  const [sendingFingerprint, setSendingFingerprint] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  const showToast = useCallback((message: string, duration = 5000) => {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), duration);
  }, []);

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
    let disposed = false;
    let cleanup: UnlistenFn[] = [];
    void Promise.all([
      listen<RelayStatusEvent>("relay-status", (event) => {
          setStatus(event.payload);
          void reload();
        }),
      listen("relay-device-discovered", () => void reload()),
      listen<RelayTransferComplete>("relay-transfer-complete", (event) => {
          const payload = event.payload;
          showToast(`收到 ${payload.filename} · ${formatBytes(payload.bytes)} · 来自 ${payload.sender}`);
          void reload();
        }),
      listen<{ error?: string }>("relay-transfer-error", (event) => {
          showToast(`投递失败：${event.payload?.error ?? "未知错误"}`);
        }),
    ])
      .then((unlistens) => {
        if (disposed) unlistens.forEach((unlisten) => unlisten());
        else cleanup = unlistens;
      })
      .catch(() => {
        // Tauri event bridge unavailable outside the desktop runtime.
      });
    return () => {
      disposed = true;
      cleanup.forEach((unlisten) => unlisten());
      window.clearTimeout(toastTimer.current);
    };
  }, [reload, showToast]);

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
      showToast("设置已保存", 2500);
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

  const sendToDevice = async (device: RelayDeviceInfo) => {
    if (sendingFingerprint) return;
    setSendingFingerprint(device.fingerprint);
    try {
      const picked = await open({
        multiple: true,
        directory: false,
        title: `发送文件到 ${device.alias || "邻近设备"}`,
      });
      const paths = typeof picked === "string" ? [picked] : picked;
      if (!paths?.length) return;
      await invoke<string>("start_relay_send", {
        fingerprint: device.fingerprint,
        paths,
      });
      showToast(`已向 ${device.alias || "目标设备"} 发起发送，请等待对方确认`);
    } catch (error) {
      showToast(`无法发送：${String(error)}`);
    } finally {
      setSendingFingerprint(null);
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
                <span style={{ minWidth: 0, flex: 1 }} title={`${device.ip}:${device.port}`}>
                  <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {device.alias || "未命名设备"}
                  </span>
                  <span style={{ display: "block", opacity: 0.45, fontSize: 9 }}>
                    {device.deviceType} · {device.ip}
                  </span>
                </span>
                <button
                  style={sendBtnStyle(sendingFingerprint !== null)}
                  disabled={sendingFingerprint !== null}
                  title={`发送文件到 ${device.alias || "该设备"}`}
                  aria-label={`发送文件到 ${device.alias || "该设备"}`}
                  onClick={() => void sendToDevice(device)}
                >
                  <Send size={12} />
                </button>
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
