import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri as detectTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  currentMonitor,
  cursorPosition,
  getCurrentWindow,
  LogicalSize,
  PhysicalPosition,
} from "@tauri-apps/api/window";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import {
  Bell,
  CalendarDays,
  Check,
  ChevronDown,
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudLightning,
  CloudRain,
  CloudSun,
  Copy,
  Droplets,
  Expand,
  FolderInput,
  LocateFixed,
  MapPin,
  Maximize2,
  Minimize2,
  Moon,
  MoreHorizontal,
  Pin,
  PinOff,
  RefreshCw,
  Search,
  Settings2,
  Snowflake,
  Sun,
  Sunrise,
  Trash2,
  Undo2,
  Wind,
  X,
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
} from "recharts";
import { quoteOfTheDay } from "./quotes";
import { describeWeather, fetchWeather, searchLocations } from "./weather";
import { BlackHoleCanvas } from "./BlackHoleCanvas";
import { DesktopEcosystem } from "./DesktopEcosystem";
import type {
  DropPhase,
  EffectCapabilities,
  EffectQuality,
  EcosystemStats,
  FocusSession,
  ForgeResult,
  PulseData,
  RecycleBatch,
  RecycleResult,
  Settings,
  TerrainMode,
  WeatherLocation,
  WeatherState,
  WeatherVisualMode,
  WidgetSize,
  WormholeResult,
} from "./types";

interface DropState {
  phase: DropPhase;
  paths: string[];
  message: string;
  target?: "trash" | "wormhole" | "forge";
}

const isTauri = detectTauri();

const storageKeys = {
  focus: "codex-cosmos-focus",
  settings: "codex-cosmos-settings",
  weather: "codex-cosmos-weather",
} as const;

const legacyStorageKeys = {
  focus: "codex-pulse-focus",
  settings: "codex-pulse-settings",
  weather: "codex-pulse-weather",
} as const;

function readStoredValue(key: keyof typeof storageKeys): string | null {
  const current = localStorage.getItem(storageKeys[key]);
  if (current !== null) return current;
  const legacy = localStorage.getItem(legacyStorageKeys[key]);
  if (legacy !== null) localStorage.setItem(storageKeys[key], legacy);
  return legacy;
}

const defaultLocation: WeatherLocation = {
  name: "北京",
  admin1: "北京市",
  country: "中国",
  latitude: 39.9042,
  longitude: 116.4074,
  timezone: "Asia/Shanghai",
};

const defaultSettings: Settings = {
  location: defaultLocation,
  size: "standard",
  topmost: true,
  autostart: false,
  locale: "zh-CN",
  quoteCategory: "mixed",
  weatherEnabled: true,
  weatherVisualMode: "immersive",
  idleDriftEnabled: true,
  terrainMode: "gravity",
  terrainIntensity: 65,
  mouseGravityEnabled: true,
  effectQuality: "balanced",
  monthlyBudget: 100,
  lowQuotaThreshold: 20,
};

const mockPulse: PulseData = {
  quota: {
    found: true,
    sampledAt: new Date().toISOString(),
    planType: "plus",
    limitId: "codex",
    primary: { usedPercent: 35, remainingPercent: 65, windowMinutes: 10080, resetsAt: Date.now() / 1000 + 582000 },
    secondary: null,
    source: "local-session",
    stale: false,
  },
  history: [
    { sampledAt: Date.now() / 1000 - 518400, usedPercent: 4, windowMinutes: 10080 },
    { sampledAt: Date.now() / 1000 - 432000, usedPercent: 9, windowMinutes: 10080 },
    { sampledAt: Date.now() / 1000 - 345600, usedPercent: 14, windowMinutes: 10080 },
    { sampledAt: Date.now() / 1000 - 259200, usedPercent: 20, windowMinutes: 10080 },
    { sampledAt: Date.now() / 1000 - 172800, usedPercent: 27, windowMinutes: 10080 },
    { sampledAt: Date.now() / 1000 - 86400, usedPercent: 31, windowMinutes: 10080 },
    { sampledAt: Date.now() / 1000, usedPercent: 35, windowMinutes: 10080 },
  ],
  monthlyEstimate: { usedPercent: 22, confidence: "medium", samples: 7, label: "30 天本地估算" },
};

const sizeMap: Record<WidgetSize, { width: number; height: number }> = {
  compact: { width: 430, height: 116 },
  standard: { width: 430, height: 570 },
  expanded: { width: 760, height: 620 },
};

const idleSize = { width: 184, height: 164 };

const wormholeExitPoints = [
  { x: 94, y: 20, angle: -8 },
  { x: 146, y: 73, angle: 18 },
  { x: 140, y: 126, angle: -16 },
  { x: 26, y: 27, angle: 12 },
];

function randomWormholeExit(previous?: { x: number; y: number; angle: number }) {
  const choices = previous
    ? wormholeExitPoints.filter((point) => point.x !== previous.x || point.y !== previous.y)
    : wormholeExitPoints;
  return choices[Math.floor(Math.random() * choices.length)] ?? wormholeExitPoints[0];
}

const defaultEcosystemStats: EcosystemStats = {
  totalRecycled: 0,
  totalWormholeMoves: 0,
  totalForged: 0,
  wormholeDestination: "Downloads",
  forgeDestination: "Downloads",
};

function loadFocusSession(): FocusSession {
  const fallback: FocusSession = { durationMinutes: 25, remainingSeconds: 1500, running: false, endsAt: null };
  try {
    const saved = JSON.parse(readStoredValue("focus") ?? "null") as FocusSession | null;
    if (!saved) return fallback;
    if (saved.running && saved.endsAt) {
      const remainingSeconds = Math.max(0, Math.ceil((saved.endsAt - Date.now()) / 1000));
      return { ...saved, remainingSeconds, running: remainingSeconds > 0 };
    }
    return { ...fallback, ...saved };
  } catch {
    return fallback;
  }
}

function loadSettings(): Settings {
  try {
    const saved = JSON.parse(readStoredValue("settings") ?? "{}") as Partial<Settings>;
    return { ...defaultSettings, ...saved, location: { ...defaultLocation, ...saved.location } };
  } catch {
    return defaultSettings;
  }
}

function loadCachedWeather(): WeatherState | null {
  try {
    return JSON.parse(readStoredValue("weather") ?? "null") as WeatherState | null;
  } catch {
    return null;
  }
}

function formatWindow(minutes: number): string {
  if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440} 天周期`;
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60} 小时周期`;
  return `${minutes} 分钟周期`;
}

function formatReset(unixSeconds: number, now: Date): string {
  const seconds = Math.max(0, unixSeconds - now.getTime() / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时后重置`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟后重置`;
  return `${minutes} 分钟后重置`;
}

function weatherIcon(code: number, size = 24) {
  const kind = describeWeather(code).glyph;
  const props = { size, strokeWidth: 1.7 };
  if (kind === "sun") return <Sun {...props} />;
  if (kind === "cloud-sun") return <CloudSun {...props} />;
  if (kind === "fog") return <CloudFog {...props} />;
  if (kind === "drizzle") return <CloudDrizzle {...props} />;
  if (kind === "rain") return <CloudRain {...props} />;
  if (kind === "snow") return <Snowflake {...props} />;
  if (kind === "storm") return <CloudLightning {...props} />;
  return <Cloud {...props} />;
}

function greeting(now: Date): string {
  const hour = now.getHours();
  if (hour < 6) return "夜深了，记得给思绪留一点安静";
  if (hour < 11) return "早上好，从一件重要的事开始";
  if (hour < 14) return "中午好，给自己一点呼吸的空间";
  if (hour < 18) return "下午好，保持节奏，不必匆忙";
  return "晚上好，收好今天的进展";
}

function BlackHoleCore({
  phase,
  count,
  message,
  onMouseDown,
  onOpenTrash,
  weather,
  weatherIntensity,
  recycledCount,
  terrainMode,
  terrainIntensity,
  mouseGravityEnabled,
  effectQuality,
}: {
  phase: DropPhase;
  count: number;
  message: string;
  onMouseDown?: (event: React.MouseEvent<HTMLElement>) => void;
  onOpenTrash?: () => void;
  weather?: WeatherState | null;
  weatherIntensity?: number;
  recycledCount?: number;
  terrainMode?: TerrainMode;
  terrainIntensity?: number;
  mouseGravityEnabled?: boolean;
  effectQuality?: EffectQuality;
}) {
  const status = phase === "ready"
    ? message || `释放吞噬 ${count} 个项目`
    : phase === "processing"
      ? message || "正在移入回收站"
      : phase === "restoring"
        ? "正在从回收站恢复"
        : phase === "success"
          ? message
          : phase === "error"
            ? message
            : "CODEX COSMOS";

  return (
    <div
      className={`black-hole black-hole-${phase}`}
      onMouseDown={onMouseDown}
      onDoubleClick={onOpenTrash}
      title={phase === "idle" ? "双击打开回收站 · 按住拖动位置" : undefined}
    >
      <BlackHoleCanvas
        phase={phase}
        weather={weather}
        weatherIntensity={weatherIntensity}
        recycledCount={recycledCount}
        terrainMode={terrainMode}
        terrainIntensity={terrainIntensity}
        mouseGravityEnabled={mouseGravityEnabled}
        effectQuality={effectQuality}
      />
      <small>{status}</small>
    </div>
  );
}

function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [now, setNow] = useState(new Date());
  const [pulse, setPulse] = useState<PulseData | null>(null);
  const [weather, setWeather] = useState<WeatherState | null>(loadCachedWeather);
  const [loadingQuota, setLoadingQuota] = useState(false);
  const [loadingWeather, setLoadingWeather] = useState(false);
  const [weatherError, setWeatherError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [locationQuery, setLocationQuery] = useState("");
  const [locationResults, setLocationResults] = useState<WeatherLocation[]>([]);
  const [copied, setCopied] = useState(false);
  const [awake, setAwake] = useState(!isTauri);
  const [dropState, setDropState] = useState<DropState>({ phase: "idle", paths: [], message: "" });
  const [recycleHistory, setRecycleHistory] = useState<RecycleBatch[]>([]);
  const [ecosystemStats, setEcosystemStats] = useState<EcosystemStats>(defaultEcosystemStats);
  const [focusSession, setFocusSession] = useState<FocusSession>(loadFocusSession);
  const [clipboardComet, setClipboardComet] = useState<{ id: number; text: string } | null>(null);
  const [wormholePathDraft, setWormholePathDraft] = useState("");
  const [forgePathDraft, setForgePathDraft] = useState("");
  const [capabilities, setCapabilities] = useState<EffectCapabilities | null>(null);
  const [terrainImpact, setTerrainImpact] = useState<{ id: number; x: number; y: number } | null>(null);
  const [wormholeExit, setWormholeExit] = useState(() => randomWormholeExit());
  const collapseTimer = useRef<number | null>(null);
  const hoverTimer = useRef<number | null>(null);
  const feedbackTimer = useRef<number | null>(null);
  const dragReleaseTimer = useRef<number | null>(null);
  const manualWindowDrag = useRef(false);
  const nativeFileDrag = useRef(false);
  const pointerInsideRef = useRef(false);
  const suppressWakeUntilLeave = useRef(false);
  const dropTargetRef = useRef<"trash" | "wormhole" | "forge">("trash");
  const lastClipboardRef = useRef<string | null>(null);
  const cometTimer = useRef<number | null>(null);
  const quote = useMemo(() => quoteOfTheDay(settings.quoteCategory), [settings.quoteCategory]);

  const saveSettings = useCallback((next: Settings) => {
    setSettings(next);
    localStorage.setItem(storageKeys.settings, JSON.stringify(next));
  }, []);

  const loadRecycleHistory = useCallback(async () => {
    if (!isTauri) return;
    try {
      setRecycleHistory(await invoke<RecycleBatch[]>("recent_recycles"));
    } catch {
      setRecycleHistory([]);
    }
  }, []);

  const loadEcosystemStats = useCallback(async () => {
    if (!isTauri) return;
    try {
      const stats = await invoke<EcosystemStats>("ecosystem_stats");
      setEcosystemStats(stats);
      setWormholePathDraft(stats.wormholeDestination);
      setForgePathDraft(stats.forgeDestination);
    } catch {
      setEcosystemStats(defaultEcosystemStats);
    }
  }, []);

  const clearFeedbackLater = useCallback((delay = 1800) => {
    if (feedbackTimer.current !== null) window.clearTimeout(feedbackTimer.current);
    feedbackTimer.current = window.setTimeout(() => {
      setDropState({ phase: "idle", paths: [], message: "" });
      feedbackTimer.current = null;
    }, delay);
  }, []);

  const loadQuota = useCallback(async () => {
    setLoadingQuota(true);
    try {
      const data = isTauri ? await invoke<PulseData>("get_pulse_data") : mockPulse;
      setPulse(data);
    } catch (error) {
      setPulse({
        quota: null,
        history: [],
        monthlyEstimate: { usedPercent: 0, confidence: "low", samples: 0, label: "数据不足" },
        error: String(error),
      });
    } finally {
      setLoadingQuota(false);
    }
  }, []);

  const loadWeather = useCallback(async () => {
    if (!settings.weatherEnabled) return;
    setLoadingWeather(true);
    setWeatherError(null);
    try {
      const nextWeather = await fetchWeather(settings.location);
      setWeather(nextWeather);
      localStorage.setItem(storageKeys.weather, JSON.stringify(nextWeather));
    } catch (error) {
      setWeatherError(String(error));
    } finally {
      setLoadingWeather(false);
    }
  }, [settings.location, settings.weatherEnabled]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    void loadQuota();
    const timer = window.setInterval(loadQuota, 30_000);
    return () => window.clearInterval(timer);
  }, [loadQuota]);

  useEffect(() => {
    void loadWeather();
    const timer = window.setInterval(loadWeather, 15 * 60_000);
    return () => window.clearInterval(timer);
  }, [loadWeather]);

  useEffect(() => {
    if (!isTauri) return;
    void isEnabled().then((value) => setSettings((current) => ({ ...current, autostart: value })));
    void loadRecycleHistory();
    void loadEcosystemStats();
    void invoke<EffectCapabilities>("effect_capabilities").then(setCapabilities).catch(() => setCapabilities(null));
  }, []);

  useEffect(() => {
    localStorage.setItem(storageKeys.focus, JSON.stringify(focusSession));
    if (!focusSession.running || !focusSession.endsAt) return;
    const timer = window.setInterval(() => {
      setFocusSession((current) => {
        if (!current.running || !current.endsAt) return current;
        const remainingSeconds = Math.max(0, Math.ceil((current.endsAt - Date.now()) / 1000));
        if (remainingSeconds === 0) {
          void sendNotification({ title: "专注月球完成", body: `${current.durationMinutes} 分钟专注周期结束，起来活动一下。` });
          return { ...current, remainingSeconds: 0, running: false, endsAt: null };
        }
        return { ...current, remainingSeconds };
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [focusSession.running, focusSession.endsAt]);

  useEffect(() => {
    if (!isTauri) return;
    const pollClipboard = async () => {
      try {
        const text = (await invoke<string>("clipboard_text")).trim();
        if (!text) return;
        if (lastClipboardRef.current === null) {
          lastClipboardRef.current = text;
          return;
        }
        if (text === lastClipboardRef.current) return;
        lastClipboardRef.current = text;
        setClipboardComet({ id: Date.now(), text });
        if (cometTimer.current !== null) window.clearTimeout(cometTimer.current);
        cometTimer.current = window.setTimeout(() => {
          setClipboardComet(null);
          cometTimer.current = null;
        }, 7200);
      } catch {
        // Images and empty clipboards do not create a comet.
      }
    };
    void pollClipboard();
    const timer = window.setInterval(() => void pollClipboard(), 1400);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow().onDragDropEvent(({ payload }) => {
      const targetAt = (x: number, y: number) => {
        const scale = window.devicePixelRatio || 1;
        const idleCanvas = window.innerWidth <= 220 && window.innerHeight <= 200;
        if (!idleCanvas) return "trash" as const;
        if (x / scale < 70 && y / scale > 88) return "wormhole" as const;
        if (x / scale > 116 && y / scale > 88) return "forge" as const;
        return "trash" as const;
      };
      if (payload.type === "enter") {
        if (feedbackTimer.current !== null) window.clearTimeout(feedbackTimer.current);
        if (hoverTimer.current !== null) {
          window.clearTimeout(hoverTimer.current);
          hoverTimer.current = null;
        }
        if (collapseTimer.current !== null) {
          window.clearTimeout(collapseTimer.current);
          collapseTimer.current = null;
        }
        nativeFileDrag.current = true;
        suppressWakeUntilLeave.current = true;
        const target = targetAt(payload.position.x, payload.position.y);
        dropTargetRef.current = target;
        if (target === "wormhole") {
          setWormholeExit((current) => randomWormholeExit(current));
        }
        setDropState({
          phase: "ready",
          paths: payload.paths,
          target,
          message: target === "wormhole"
            ? `${payload.paths.length} 个项目将穿越至 ${ecosystemStats.wormholeDestination}`
            : target === "forge"
              ? `${payload.paths.length} 个项目将由星炉自动压缩或解压`
            : `${payload.paths.length} 个项目将移入回收站`,
        });
        return;
      }
      if (payload.type === "over") {
        const target = targetAt(payload.position.x, payload.position.y);
        if (target !== dropTargetRef.current) {
          dropTargetRef.current = target;
          if (target === "wormhole") {
            setWormholeExit((current) => randomWormholeExit(current));
          }
          setDropState((current) => ({
            ...current,
            target,
            message: target === "wormhole"
              ? `${current.paths.length} 个项目将穿越至 ${ecosystemStats.wormholeDestination}`
              : target === "forge"
                ? `${current.paths.length} 个项目将由星炉自动压缩或解压`
              : `${current.paths.length} 个项目将移入回收站`,
          }));
        }
        return;
      }
      if (payload.type === "leave") {
        nativeFileDrag.current = false;
        setDropState((current) => current.phase === "ready"
          ? { phase: "idle", paths: [], message: "" }
          : current);
        return;
      }
      if (payload.type !== "drop") return;

      nativeFileDrag.current = false;
      const paths = payload.paths;
      const target = dropTargetRef.current;
      setDropState({
        phase: "processing",
        paths,
        target,
        message: target === "wormhole" ? "正在穿越虫洞" : target === "forge" ? "星炉正在处理 ZIP" : "正在安全回收",
      });
      const operation = target === "wormhole"
        ? invoke<WormholeResult>("move_through_wormhole", { paths })
        : target === "forge"
          ? invoke<ForgeResult>("forge_files", { paths })
        : invoke<RecycleResult>("move_to_trash", { paths });
      const transferAnimation = target === "wormhole" || target === "forge"
        ? new Promise<void>((resolve) => window.setTimeout(resolve, target === "forge" ? 1850 : 1450))
        : Promise.resolve();
      void Promise.all([operation, transferAnimation])
        .then(([result]) => {
          setAwake(false);
          setDropState({
            phase: "success",
            paths: [],
            target,
            message: target === "wormhole"
              ? result.count === 1 ? `${result.names[0]} 已抵达` : `${result.count} 个项目已抵达`
              : target === "forge"
                ? result.count === 1 ? `${result.names[0]} 已喷出` : `${result.count} 个 ZIP 结果已喷出`
              : result.count === 1 ? `${result.names[0]} 已被吞噬` : `${result.count} 个项目已被吞噬`,
          });
          void loadRecycleHistory();
          void loadEcosystemStats();
          clearFeedbackLater(2100);
        })
        .catch((error) => {
          setDropState({ phase: "error", paths: [], message: String(error) });
          clearFeedbackLater(3800);
        });
    }).then((dispose) => {
      unlisten = dispose;
    });
    return () => unlisten?.();
  }, [clearFeedbackLater, ecosystemStats.wormholeDestination, loadEcosystemStats, loadRecycleHistory]);

  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    void listen("quota-refresh-requested", () => void loadQuota()).then((dispose) => {
      unlisten = dispose;
    });
    return () => unlisten?.();
  }, [loadQuota]);

  useEffect(() => {
    if (!isTauri || !pulse?.quota) return;
    const remaining = pulse.quota.primary.remainingPercent;
    const noticeKey = `quota-notice-${pulse.quota.primary.resetsAt}`;
    if (remaining > settings.lowQuotaThreshold || localStorage.getItem(noticeKey)) return;
    void (async () => {
      let allowed = await isPermissionGranted();
      if (!allowed) allowed = (await requestPermission()) === "granted";
      if (allowed) {
        sendNotification({
          title: "Codex 额度提醒",
          body: `当前周期仅剩 ${Math.round(remaining)}%，${formatReset(pulse.quota!.primary.resetsAt, new Date())}。`,
        });
        localStorage.setItem(noticeKey, "1");
      }
    })();
  }, [pulse, settings.lowQuotaThreshold]);

  useEffect(() => {
    if (!isTauri) return;
    const target = awake || settingsOpen ? sizeMap[settings.size] : idleSize;
    void getCurrentWindow().setSize(new LogicalSize(target.width, target.height));
  }, [awake, settings.size, settingsOpen]);

  useEffect(() => {
    document.title = awake || settingsOpen ? "Codex Cosmos · 信息面板" : "Codex Cosmos · 黑洞待机";
  }, [awake, settingsOpen]);

  useEffect(() => () => {
    if (collapseTimer.current !== null) window.clearTimeout(collapseTimer.current);
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    if (feedbackTimer.current !== null) window.clearTimeout(feedbackTimer.current);
    if (dragReleaseTimer.current !== null) window.clearTimeout(dragReleaseTimer.current);
    if (cometTimer.current !== null) window.clearTimeout(cometTimer.current);
  }, []);

  const updateSize = (size: WidgetSize) => {
    setSettingsOpen(false);
    saveSettings({ ...settings, size });
  };

  const toggleTopmost = async () => {
    const next = !settings.topmost;
    if (isTauri) await getCurrentWindow().setAlwaysOnTop(next);
    saveSettings({ ...settings, topmost: next });
  };

  const toggleAutostart = async () => {
    const next = !settings.autostart;
    if (isTauri) {
      if (next) await enable();
      else await disable();
    }
    saveSettings({ ...settings, autostart: next });
  };

  const performLocationSearch = async () => {
    setLocationResults(await searchLocations(locationQuery));
  };

  const chooseLocation = (location: WeatherLocation) => {
    setWeather(null);
    localStorage.removeItem(storageKeys.weather);
    localStorage.removeItem(legacyStorageKeys.weather);
    saveSettings({ ...settings, location });
    setLocationQuery("");
    setLocationResults([]);
  };

  const toggleFocus = () => {
    setFocusSession((current) => {
      if (current.remainingSeconds === 0) {
        const remainingSeconds = current.durationMinutes * 60;
        return { ...current, remainingSeconds, running: true, endsAt: Date.now() + remainingSeconds * 1000 };
      }
      if (current.running) {
        return { ...current, running: false, endsAt: null };
      }
      return { ...current, running: true, endsAt: Date.now() + current.remainingSeconds * 1000 };
    });
  };

  const resetFocus = () => {
    setFocusSession((current) => ({
      ...current,
      remainingSeconds: current.durationMinutes * 60,
      running: false,
      endsAt: null,
    }));
  };

  const replayClipboardComet = () => {
    if (!clipboardComet) return;
    if (isTauri) void invoke("set_clipboard_text", { text: clipboardComet.text });
    setAwake(true);
  };

  const saveWormholeDestination = async () => {
    if (!isTauri) return;
    try {
      const stats = await invoke<EcosystemStats>("set_wormhole_destination", {
        destination: wormholePathDraft,
      });
      setEcosystemStats(stats);
    } catch (error) {
      setDropState({ phase: "error", paths: [], target: "wormhole", message: String(error) });
      clearFeedbackLater(3200);
    }
  };

  const saveForgeDestination = async () => {
    if (!isTauri) return;
    try {
      const stats = await invoke<EcosystemStats>("set_forge_destination", {
        destination: forgePathDraft,
      });
      setEcosystemStats(stats);
      setForgePathDraft(stats.forgeDestination);
    } catch (error) {
      setDropState({ phase: "error", paths: [], target: "forge", message: String(error) });
      clearFeedbackLater(3200);
    }
  };

  const beginWindowDrag = (event: React.MouseEvent<HTMLElement>) => {
    if (!isTauri || event.button !== 0 || settingsOpen) return;

    const target = event.target as HTMLElement;
    if (target.closest("button, input, a, [role='button']")) return;

    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    if (collapseTimer.current !== null) {
      window.clearTimeout(collapseTimer.current);
      collapseTimer.current = null;
    }
    manualWindowDrag.current = true;
    suppressWakeUntilLeave.current = true;
    if ((event.currentTarget as HTMLElement).classList.contains("black-hole")) {
      setAwake(false);
    }
    void getCurrentWindow().startDragging().finally(() => {
      if (dragReleaseTimer.current !== null) window.clearTimeout(dragReleaseTimer.current);
      dragReleaseTimer.current = window.setTimeout(() => {
        manualWindowDrag.current = false;
        dragReleaseTimer.current = null;
      }, 180);
    });
  };

  const wakeWidget = () => {
    if (collapseTimer.current !== null) {
      window.clearTimeout(collapseTimer.current);
      collapseTimer.current = null;
    }
    setAwake(true);
  };

  const restWidget = () => {
    if (settingsOpen || dropState.phase !== "idle") return;
    if (collapseTimer.current !== null) return;
    collapseTimer.current = window.setTimeout(() => {
      setAwake(false);
      collapseTimer.current = null;
    }, 850);
  };

  const scheduleWakeWidget = () => {
    if (
      dropState.phase !== "idle"
      || awake
      || manualWindowDrag.current
      || nativeFileDrag.current
      || suppressWakeUntilLeave.current
      || hoverTimer.current !== null
    ) return;
    hoverTimer.current = window.setTimeout(() => {
      hoverTimer.current = null;
      if (
        dropState.phase === "idle"
        && !manualWindowDrag.current
        && !nativeFileDrag.current
        && !suppressWakeUntilLeave.current
      ) {
        wakeWidget();
      }
    }, 900);
  };

  useEffect(() => {
    if (!isTauri) return;
    let busy = false;

    const checkPointer = async () => {
      if (dropState.phase !== "idle" || manualWindowDrag.current || nativeFileDrag.current) return;
      if (busy) return;
      busy = true;
      try {
        const appWindow = getCurrentWindow();
        const [cursor, position, size] = await Promise.all([
          cursorPosition(),
          appWindow.outerPosition(),
          appWindow.outerSize(),
        ]);
        const inside = cursor.x >= position.x
          && cursor.x < position.x + size.width
          && cursor.y >= position.y
          && cursor.y < position.y + size.height;
        pointerInsideRef.current = inside;
        if (inside) {
          if (collapseTimer.current !== null) {
            window.clearTimeout(collapseTimer.current);
            collapseTimer.current = null;
          }
          if (!suppressWakeUntilLeave.current) scheduleWakeWidget();
        } else {
          suppressWakeUntilLeave.current = false;
          if (hoverTimer.current !== null) {
            window.clearTimeout(hoverTimer.current);
            hoverTimer.current = null;
          }
          if (awake) restWidget();
        }
      } finally {
        busy = false;
      }
    };

    const timer = window.setInterval(() => void checkPointer(), 140);
    void checkPointer();
    return () => window.clearInterval(timer);
  }, [awake, dropState.phase, settingsOpen]);

  useEffect(() => {
    if (
      !isTauri
      || !settings.idleDriftEnabled
      || capabilities?.programmaticPositioning === false
      || awake
      || settingsOpen
      || dropState.phase !== "idle"
      || focusSession.running
    ) return;

    let cancelled = false;
    let timer: number | undefined;
    let moving = false;
    let failures = 0;

    void (async () => {
      try {
        const appWindow = getCurrentWindow();
        const [monitor, windowPosition, windowSize] = await Promise.all([
          currentMonitor(),
          appWindow.outerPosition(),
          appWindow.outerSize(),
        ]);
        if (!monitor || cancelled) return;

        const area = monitor.workArea;
        const margin = Math.max(20, 26 * monitor.scaleFactor);
        const left = area.position.x + margin;
        const top = area.position.y + margin;
        const right = area.position.x + area.size.width - windowSize.width - margin;
        const bottom = area.position.y + area.size.height - windowSize.height - margin;
        const distances = [
          Math.abs(windowPosition.y - top),
          Math.abs(windowPosition.x - right),
          Math.abs(windowPosition.y - bottom),
          Math.abs(windowPosition.x - left),
        ];
        let edge = distances.indexOf(Math.min(...distances));
        let orbitX = edge === 1 ? right : edge === 3 ? left : Math.min(right, Math.max(left, windowPosition.x));
        let orbitY = edge === 0 ? top : edge === 2 ? bottom : Math.min(bottom, Math.max(top, windowPosition.y));
        let blend = 0;

        const advanceOrbit = (distance: number) => {
          let remaining = distance;
          while (remaining > 0) {
            const capacity = edge === 0
              ? right - orbitX
              : edge === 1
                ? bottom - orbitY
                : edge === 2
                  ? orbitX - left
                  : orbitY - top;
            const step = Math.min(remaining, Math.max(0, capacity));
            if (edge === 0) orbitX += step;
            else if (edge === 1) orbitY += step;
            else if (edge === 2) orbitX -= step;
            else orbitY -= step;
            remaining -= step;
            if (capacity <= step + 0.001) edge = (edge + 1) % 4;
          }
        };

        const drift = async () => {
          if (
            cancelled
            || moving
            || pointerInsideRef.current
            || manualWindowDrag.current
            || nativeFileDrag.current
          ) return;
          moving = true;
          try {
            advanceOrbit(0.72 * monitor.scaleFactor);
            blend = Math.min(1, blend + 0.012);
            const x = windowPosition.x * (1 - blend) + orbitX * blend;
            const y = windowPosition.y * (1 - blend) + orbitY * blend;
            await appWindow.setPosition(new PhysicalPosition(Math.round(x), Math.round(y)));
            failures = 0;
          } catch {
            failures += 1;
            if (failures >= 3 && timer !== undefined) window.clearInterval(timer);
          } finally {
            moving = false;
          }
        };

        timer = window.setInterval(() => void drift(), 120);
      } catch {
        // Some Wayland compositors intentionally deny programmatic window positioning.
      }
    })();

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [awake, capabilities?.programmaticPositioning, dropState.phase, focusSession.running, settings.idleDriftEnabled, settingsOpen]);

  const openTrash = () => {
    if (isTauri) void invoke("open_recycle_bin");
  };

  const restoreLastRecycle = async () => {
    if (!isTauri || recycleHistory.length === 0 || dropState.phase !== "idle") return;
    setDropState({ phase: "restoring", paths: [], message: "正在恢复" });
    try {
      const result = await invoke<RecycleResult>("restore_last_recycle");
      setDropState({
        phase: "success",
        paths: [],
        message: result.count === 1 ? `${result.names[0]} 已恢复` : `${result.count} 个项目已恢复`,
      });
      await loadRecycleHistory();
      clearFeedbackLater();
    } catch (error) {
      setDropState({ phase: "error", paths: [], message: String(error) });
      clearFeedbackLater(3800);
    }
  };

  const hideWindow = () => {
    if (isTauri) void getCurrentWindow().hide();
  };

  const closeWindow = () => {
    if (isTauri) void invoke("quit_app");
  };

  const quota = pulse?.quota;
  const remaining = Math.round(quota?.primary.remainingPercent ?? 0);
  const accentClass = remaining <= 10 ? "danger" : remaining <= 25 ? "warning" : "healthy";
  const historyData = (pulse?.history ?? []).map((point) => ({
    label: new Date(point.sampledAt * 1000).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" }),
    used: point.usedPercent,
  }));
  const weatherVisualMode: WeatherVisualMode = settings.weatherEnabled ? settings.weatherVisualMode : "off";
  const visualWeather = weatherVisualMode === "off" ? null : weather;
  const weatherIntensity = weatherVisualMode === "immersive" ? 1 : weatherVisualMode === "subtle" ? 0.42 : 0;
  const terrainProps = {
    terrainMode: settings.terrainMode,
    terrainIntensity: settings.terrainIntensity / 100,
    mouseGravityEnabled: settings.mouseGravityEnabled,
    effectQuality: settings.effectQuality,
  };

  const recordTerrainImpact = (event: React.PointerEvent<HTMLElement>) => {
    if (settings.terrainMode !== "crater" || (event.target as HTMLElement).closest("button")) return;
    const impact = { id: Date.now(), x: event.clientX, y: event.clientY };
    setTerrainImpact(impact);
    window.setTimeout(() => setTerrainImpact((current) => current?.id === impact.id ? null : current), 1200);
  };

  if (!awake && isTauri) {
    return (
      <main
        className="app black-hole-shell"
        onPointerDown={recordTerrainImpact}
      >
        <DesktopEcosystem
          weather={visualWeather}
          weatherMode={weatherVisualMode}
          stats={ecosystemStats}
          focus={focusSession}
          comet={clipboardComet}
          wormholeActive={dropState.target === "wormhole" && dropState.phase !== "idle"}
          wormholePhase={dropState.target === "wormhole" ? dropState.phase : "idle"}
          wormholeExit={wormholeExit}
          forgeActive={dropState.target === "forge" && dropState.phase !== "idle"}
          forgePhase={dropState.target === "forge" ? dropState.phase : "idle"}
          terrainMode={settings.terrainMode}
          terrainIntensity={settings.terrainIntensity / 100}
          terrainImpact={terrainImpact}
          onToggleFocus={toggleFocus}
          onResetFocus={resetFocus}
          onCometClick={replayClipboardComet}
          onWormholeClick={() => {
            setAwake(true);
            setSettingsOpen(true);
          }}
        />
        <BlackHoleCore
          phase={dropState.phase}
          count={dropState.paths.length}
          message={dropState.message}
          onMouseDown={beginWindowDrag}
          onOpenTrash={openTrash}
          weather={visualWeather}
          weatherIntensity={weatherIntensity}
          recycledCount={ecosystemStats.totalRecycled}
          {...terrainProps}
        />
      </main>
    );
  }

  if (settings.size === "compact") {
    return (
      <main className="app compact-shell" data-theme={weather?.isDay === false ? "night" : "day"}>
        {dropState.phase !== "idle" && (
          <div className={`drop-overlay compact-drop-overlay drop-overlay-${dropState.phase}`}>
            <BlackHoleCore
              phase={dropState.phase}
              count={dropState.paths.length}
              message={dropState.message}
              weather={visualWeather}
              weatherIntensity={weatherIntensity}
              recycledCount={ecosystemStats.totalRecycled}
              {...terrainProps}
            />
            <p>{dropState.phase === "ready" ? "释放后移入系统回收站" : dropState.message}</p>
          </div>
        )}
        <div
          className="compact-card"
          onMouseDown={beginWindowDrag}
        >
          <div className="compact-time">
            <strong>{now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}</strong>
            <span>{now.toLocaleDateString("zh-CN", { weekday: "short", month: "short", day: "numeric" })}</span>
          </div>
          <div className="compact-divider" />
          <div className="compact-weather">
            {weather ? weatherIcon(weather.weatherCode, 27) : <Cloud size={27} />}
            <div><strong>{weather ? `${Math.round(weather.temperature)}°` : "--°"}</strong><span>{settings.location.name}</span></div>
          </div>
          <div className="compact-divider" />
          <div className={`compact-quota ${accentClass}`}>
            <div className="mini-ring" style={{ "--progress": `${remaining * 3.6}deg` } as React.CSSProperties}><span>{remaining}%</span></div>
            <div><strong>Codex 剩余</strong><span>{quota ? formatReset(quota.primary.resetsAt, now) : "等待本地数据"}</span></div>
          </div>
          <button className="icon-button compact-expand" onClick={() => updateSize("standard")} title="展开"><Maximize2 size={15} /></button>
        </div>
      </main>
    );
  }

  return (
    <main className={`app ${settings.size}`} data-theme={weather?.isDay === false ? "night" : "day"}>
      <section
        className="widget"
        onMouseDown={beginWindowDrag}
      >
        <div className="ambient ambient-one" />
        <div className="ambient ambient-two" />

        {dropState.phase !== "idle" && (
          <div className={`drop-overlay drop-overlay-${dropState.phase}`}>
            <BlackHoleCore
              phase={dropState.phase}
              count={dropState.paths.length}
              message={dropState.message}
              weather={visualWeather}
              weatherIntensity={weatherIntensity}
              recycledCount={ecosystemStats.totalRecycled}
              {...terrainProps}
            />
            <p>{dropState.phase === "ready" ? "松开鼠标后仍可从系统回收站恢复" : dropState.message}</p>
          </div>
        )}

        <header className="topbar">
          <div className="brand">
            <span className="brand-mark"><span /></span>
            <div><strong>CODEX COSMOS</strong><small>DESKTOP COMPANION</small></div>
          </div>
          <div className="window-actions">
            <button className="icon-button" onClick={toggleTopmost} title={settings.topmost ? "取消置顶" : "置顶"}>{settings.topmost ? <Pin size={14} /> : <PinOff size={14} />}</button>
            <button className="icon-button" onClick={() => setSettingsOpen(true)} title="设置"><Settings2 size={15} /></button>
            <button className="icon-button" onClick={hideWindow} title="隐藏到托盘"><Minimize2 size={14} /></button>
            <button className="icon-button close" onClick={closeWindow} title="退出"><X size={15} /></button>
          </div>
        </header>

        <section className="hero">
          <div className="clock-block">
            <div className="time-row"><span>{now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}</span><sup>{String(now.getSeconds()).padStart(2, "0")}</sup></div>
            <div className="date-line"><CalendarDays size={13} />{now.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" })}</div>
            <p>{greeting(now)}</p>
          </div>
          <div className="weather-now">
            <div className="location-line"><MapPin size={12} />{settings.location.name}{weatherError && <span className="error-dot" title={weatherError} />}</div>
            <div className="weather-main">
              <span className="weather-glyph">{weather ? weatherIcon(weather.weatherCode, 44) : <Cloud size={44} />}</span>
              <strong>{weather ? `${Math.round(weather.temperature)}°` : "--°"}</strong>
            </div>
            <div className="weather-note">{weather ? `${describeWeather(weather.weatherCode).label} · 体感 ${Math.round(weather.apparentTemperature)}°` : loadingWeather ? "正在获取天气" : "天气暂不可用"}</div>
          </div>
        </section>

        <section className="quota-card">
          <div className="quota-heading">
            <div><span className={`status-light ${accentClass}`} /> <strong>CODEX QUOTA</strong><em>{quota?.planType?.toUpperCase() ?? "LOCAL"}</em></div>
            <button className="text-button" onClick={loadQuota} disabled={loadingQuota}><RefreshCw size={12} className={loadingQuota ? "spin" : ""} />刷新</button>
          </div>
          <div className="quota-body">
            <div className={`quota-ring ${accentClass}`} style={{ "--progress": `${remaining * 3.6}deg` } as React.CSSProperties}>
              <div><strong>{quota ? `${remaining}%` : "--"}</strong><span>剩余</span></div>
            </div>
            <div className="quota-detail">
              <span>当前官方窗口</span>
              <strong>{quota ? formatWindow(quota.primary.windowMinutes) : "等待 Codex 数据"}</strong>
              <p>{quota ? formatReset(quota.primary.resetsAt, now) : pulse?.error ?? "完成一次 Codex 消息后自动同步"}</p>
              <div className="bar"><i style={{ width: `${quota?.primary.usedPercent ?? 0}%` }} /></div>
              <small>已使用 {quota ? `${quota.primary.usedPercent.toFixed(1)}%` : "--"}</small>
            </div>
          </div>
          <div className="quota-metrics">
            <div><span>30 天消耗</span><strong>{pulse ? `${Math.round(pulse.monthlyEstimate.usedPercent)}%` : "--"}</strong><small>{pulse?.monthlyEstimate.label ?? "本地估算"}</small></div>
            <div><span>数据状态</span><strong>{quota?.stale ? "较旧" : quota ? "已同步" : "离线"}</strong><small>{quota ? new Date(quota.sampledAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "等候采样"}</small></div>
            <div><span>额度提醒</span><strong>{remaining > settings.lowQuotaThreshold ? "充足" : "注意"}</strong><small>阈值 {settings.lowQuotaThreshold}%</small></div>
          </div>
        </section>

        {settings.size === "expanded" && (
          <section className="expanded-grid">
            <div className="panel trend-panel">
              <div className="panel-title"><span>额度趋势</span><small>最近本地采样</small></div>
              <ResponsiveContainer width="100%" height={152}>
                <AreaChart data={historyData} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
                  <defs><linearGradient id="quotaFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#68e3b5" stopOpacity={0.34}/><stop offset="1" stopColor="#68e3b5" stopOpacity={0}/></linearGradient></defs>
                  <CartesianGrid stroke="rgba(255,255,255,.05)" vertical={false} />
                  <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: "#748078", fontSize: 10 }} />
                  <Tooltip contentStyle={{ background: "#111a19", border: "1px solid rgba(255,255,255,.1)", borderRadius: 10 }} formatter={(value) => [`${value}%`, "已使用"]} />
                  <Area type="monotone" dataKey="used" stroke="#68e3b5" strokeWidth={2} fill="url(#quotaFill)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <div className="panel forecast-panel">
              <div className="panel-title"><span>未来天气</span><small>Open-Meteo</small></div>
              <div className="forecast-list">
                {weather ? weather.daily.slice(0, 5).map((day, index) => (
                  <div className="forecast-row" key={day.date}>
                    <span>{index === 0 ? "今天" : new Date(`${day.date}T12:00:00`).toLocaleDateString("zh-CN", { weekday: "short" })}</span>
                    {weatherIcon(day.code, 17)}
                    <small><Droplets size={10} />{day.rain}%</small>
                    <strong>{Math.round(day.max)}° <em>{Math.round(day.min)}°</em></strong>
                  </div>
                )) : <div className="forecast-empty"><Cloud size={24}/><strong>天气暂不可用</strong><span>联网后将自动恢复</span></div>}
              </div>
            </div>
          </section>
        )}

        <section className="quick-strip">
          <div><Droplets size={15} /><span>湿度</span><strong>{weather ? `${weather.humidity}%` : "--"}</strong></div>
          <div><Wind size={15} /><span>风速</span><strong>{weather ? `${Math.round(weather.windSpeed)} km/h` : "--"}</strong></div>
          <div><CloudRain size={15} /><span>降雨</span><strong>{weather ? `${weather.precipitationProbability}%` : "--"}</strong></div>
          <div><Sunrise size={15} /><span>日出</span><strong>{weather?.sunrise ? weather.sunrise.slice(-5) : "--:--"}</strong></div>
        </section>

        <section className="quote-card">
          <div className="quote-mark">“</div>
          <div><p>{quote.text}</p><span>— {quote.author}</span></div>
          <button className="icon-button" onClick={async () => { await navigator.clipboard.writeText(quote.text); setCopied(true); window.setTimeout(() => setCopied(false), 1500); }} title="复制每日一言">{copied ? <Check size={14} /> : <Copy size={14} />}</button>
        </section>

        <footer>
          <span><i className="online-dot" /> {recycleHistory[0] ? `最近回收 · ${recycleHistory[0].names[0]}${recycleHistory[0].names.length > 1 ? ` +${recycleHistory[0].names.length - 1}` : ""}` : "本地只读 · 30 秒同步"}</span>
          <div className="footer-actions">
            <button className="footer-tool" onClick={openTrash} title="打开系统回收站"><Trash2 size={12} /></button>
            <button className="footer-tool" onClick={restoreLastRecycle} disabled={recycleHistory.length === 0} title="恢复上一次回收"><Undo2 size={12} /></button>
            <div className="size-switch">
            <button onClick={() => updateSize("compact")} title="极简"><Minimize2 size={12} /></button>
            <button className={settings.size === "standard" ? "active" : ""} onClick={() => updateSize("standard")} title="标准"><MoreHorizontal size={13} /></button>
            <button className={settings.size === "expanded" ? "active" : ""} onClick={() => updateSize("expanded")} title="展开"><Expand size={12} /></button>
            </div>
          </div>
        </footer>

        {settingsOpen && (
          <div className="settings-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) setSettingsOpen(false); }}>
            <aside className="settings-panel">
              <div className="settings-title"><div><strong>偏好设置</strong><span>让桌面伴侣适应你的节奏</span></div><button className="icon-button" onClick={() => setSettingsOpen(false)}><X size={16} /></button></div>
              <div className="setting-group">
                <label>天气城市</label>
                <div className="search-box"><Search size={14} /><input value={locationQuery} onChange={(e) => setLocationQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void performLocationSearch(); }} placeholder={`${settings.location.name} · 搜索城市`} /><button onClick={performLocationSearch}>搜索</button></div>
                {locationResults.length > 0 && <div className="location-results">{locationResults.map((result) => <button key={`${result.latitude}-${result.longitude}`} onClick={() => chooseLocation(result)}><MapPin size={13}/><span>{result.name}<small>{[result.admin1, result.country].filter(Boolean).join(" · ")}</small></span><ChevronDown size={12}/></button>)}</div>}
              </div>
              <div className="setting-row"><div><strong>始终置顶</strong><span>让组件保持在其他窗口上方</span></div><button className={`toggle ${settings.topmost ? "on" : ""}`} onClick={toggleTopmost}><i /></button></div>
              <div className="setting-row"><div><strong>开机启动</strong><span>登录系统后自动运行</span></div><button className={`toggle ${settings.autostart ? "on" : ""}`} onClick={toggleAutostart}><i /></button></div>
              <div className="setting-row"><div><strong>天气模块</strong><span>关闭后不访问天气服务</span></div><button className={`toggle ${settings.weatherEnabled ? "on" : ""}`} onClick={() => saveSettings({ ...settings, weatherEnabled: !settings.weatherEnabled })}><i /></button></div>
              <div className="setting-group">
                <label>天气视觉联动 <b>{settings.weatherVisualMode === "off" ? "关闭" : settings.weatherVisualMode === "subtle" ? "轻柔" : "沉浸"}</b></label>
                <div className="segmented">{(["off", "subtle", "immersive"] as WeatherVisualMode[]).map((mode) => <button key={mode} className={settings.weatherVisualMode === mode ? "active" : ""} onClick={() => saveSettings({ ...settings, weatherVisualMode: mode })}>{mode === "off" ? "关闭" : mode === "subtle" ? "轻柔" : "沉浸"}</button>)}</div>
              </div>
              <div className="setting-row"><div><strong>边缘巡游</strong><span>待机时沿屏幕边缘缓慢移动</span></div><button className={`toggle ${settings.idleDriftEnabled ? "on" : ""}`} onClick={() => saveSettings({ ...settings, idleDriftEnabled: !settings.idleDriftEnabled })}><i /></button></div>
              <div className="setting-group">
                <label>崎岖桌面模式 <b>{({ none: "原生", gravity: "引力凹陷", crater: "月球坑", liquid: "液态桌面", snow: "积雪", dunes: "沙丘", dust: "太空尘埃" } as Record<TerrainMode, string>)[settings.terrainMode]}</b></label>
                <div className="segmented terrain-options">{(["none", "gravity", "crater", "liquid", "snow", "dunes", "dust"] as TerrainMode[]).map((mode) => <button key={mode} className={`liquid-glass-label ${settings.terrainMode === mode ? "active" : ""}`} onClick={() => saveSettings({ ...settings, terrainMode: mode })}>{({ none: "原生", gravity: "引力", crater: "月坑", liquid: "液态", snow: "积雪", dunes: "沙丘", dust: "尘埃" } as Record<TerrainMode, string>)[mode]}</button>)}</div>
              </div>
              <div className="setting-group">
                <label>地形强度 <b>{settings.terrainIntensity}%</b></label>
                <input type="range" min="20" max="100" step="5" value={settings.terrainIntensity} style={{ "--range-progress": `${(settings.terrainIntensity - 20) / 0.8}%` } as React.CSSProperties} onChange={(event) => saveSettings({ ...settings, terrainIntensity: Number(event.target.value) })} />
              </div>
              <div className="setting-row"><div><strong>鼠标引力</strong><span>指针靠近时牵引黑洞、桌面与粒子</span></div><button className={`toggle ${settings.mouseGravityEnabled ? "on" : ""}`} onClick={() => saveSettings({ ...settings, mouseGravityEnabled: !settings.mouseGravityEnabled })}><i /></button></div>
              <div className="setting-group">
                <label>GPU 效果质量 <b>{settings.effectQuality === "eco" ? "节能" : settings.effectQuality === "balanced" ? "平衡" : "电影"}</b></label>
                <div className="segmented">{(["eco", "balanced", "cinematic"] as EffectQuality[]).map((quality) => <button key={quality} className={`liquid-glass-label ${settings.effectQuality === quality ? "active" : ""}`} onClick={() => saveSettings({ ...settings, effectQuality: quality })}>{quality === "eco" ? "节能" : quality === "balanced" ? "平衡" : "电影"}</button>)}</div>
              </div>
              <div className="setting-group">
                <label>虫洞目标 <b>{ecosystemStats.totalWormholeMoves} 次穿越</b></label>
                <div className="search-box wormhole-path"><FolderInput size={14} /><input value={wormholePathDraft} onChange={(event) => setWormholePathDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void saveWormholeDestination(); }} placeholder="绝对目录路径" /><button onClick={saveWormholeDestination}>保存</button></div>
              </div>
              <div className="setting-group">
                <label>星炉目标 <b>{ecosystemStats.totalForged} 次处理</b></label>
                <div className="search-box wormhole-path"><FolderInput size={14} /><input value={forgePathDraft} onChange={(event) => setForgePathDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void saveForgeDestination(); }} placeholder="ZIP 输出绝对目录" /><button onClick={saveForgeDestination}>保存</button></div>
                <small className="setting-hint">投入 ZIP 会安全解压；投入其他文件或文件夹会生成 ZIP。原文件始终保留。</small>
              </div>
              <div className="setting-group">
                <label>专注月球 <b>{focusSession.durationMinutes} 分钟</b></label>
                <div className="segmented">{[25, 45, 60].map((minutes) => <button key={minutes} className={focusSession.durationMinutes === minutes ? "active" : ""} onClick={() => setFocusSession({ durationMinutes: minutes, remainingSeconds: minutes * 60, running: false, endsAt: null })}>{minutes}m</button>)}</div>
              </div>
              <div className="setting-group">
                <label>低额度提醒阈值 <b>{settings.lowQuotaThreshold}%</b></label>
                <input type="range" min="5" max="50" step="5" value={settings.lowQuotaThreshold} style={{ "--range-progress": `${(settings.lowQuotaThreshold - 5) / 0.45}%` } as React.CSSProperties} onChange={(e) => saveSettings({ ...settings, lowQuotaThreshold: Number(e.target.value) })} />
              </div>
              <div className="setting-group">
                <label>默认显示尺寸</label>
                <div className="segmented">{(["compact", "standard", "expanded"] as WidgetSize[]).map((size) => <button key={size} className={settings.size === size ? "active" : ""} onClick={() => updateSize(size)}>{size === "compact" ? "极简" : size === "standard" ? "标准" : "展开"}</button>)}</div>
              </div>
              <div className="privacy-note"><LocateFixed size={15}/><p><strong>隐私优先</strong><span>Codex 额度只读取本机事件；天气仅发送你选择的城市坐标，不读取账号令牌。</span></p></div>
              {capabilities && <div className="capability-card liquid-glass-tag"><strong>{capabilities.desktopCapture ? "实时桌面透镜" : "安全降级模式"}</strong><span>{capabilities.platform} · {capabilities.session}{capabilities.fallbackReason ? ` · ${capabilities.fallbackReason}` : " · 当前显示器独立采样"}</span></div>}
              <div className="settings-version">CODEX COSMOS 1.0.1 · RUGGED DESKTOP</div>
            </aside>
          </div>
        )}
      </section>
    </main>
  );
}

export default App;
