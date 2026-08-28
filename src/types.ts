export type WidgetSize = "compact" | "standard" | "expanded";
export type DropPhase = "idle" | "ready" | "processing" | "success" | "error" | "restoring";
export type WeatherVisualMode = "off" | "subtle" | "immersive";
export type SurfaceStyle = "liquid-glass" | "solid-card";
export type TerrainMode = "none" | "gravity" | "crater" | "liquid" | "snow" | "dunes" | "dust";
export type EffectQuality = "eco" | "balanced" | "cinematic";

export interface RateWindow {
  usedPercent: number;
  remainingPercent: number;
  windowMinutes: number;
  resetsAt: number;
}

export interface QuotaSnapshot {
  found: boolean;
  sampledAt: string;
  planType: string;
  limitId: string;
  primary: RateWindow;
  secondary?: RateWindow | null;
  credits?: {
    hasCredits: boolean;
    unlimited: boolean;
    balance: string;
  };
  source: string;
  stale: boolean;
}

export interface QuotaHistoryPoint {
  sampledAt: number;
  usedPercent: number;
  windowMinutes: number;
  resetsAt?: number;
}

export interface MonthlyEstimate {
  usedPercent: number;
  confidence: "low" | "medium" | "high";
  samples: number;
  label: string;
}

export interface PulseData {
  quota: QuotaSnapshot | null;
  history: QuotaHistoryPoint[];
  monthlyEstimate: MonthlyEstimate;
  error?: string | null;
}

export interface RecycleBatch {
  paths: string[];
  names: string[];
  recycledAt: number;
}

export interface RecycleResult {
  count: number;
  names: string[];
  recycledAt: number;
}

export interface EcosystemStats {
  totalRecycled: number;
  totalWormholeMoves: number;
  totalForged: number;
  wormholeDestination: string;
  forgeDestination: string;
}

export interface WormholeResult {
  count: number;
  names: string[];
  destination: string;
  movedAt: number;
}

export interface ForgeResult {
  count: number;
  names: string[];
  destination: string;
  forgedAt: number;
}

export interface EffectCapabilities {
  platform: string;
  session: string;
  desktopCapture: boolean;
  programmaticPositioning: boolean;
  fallbackReason?: string | null;
}

export type FocusPhase = "focus" | "break";

export interface FocusHistoryEntry {
  at: number;
  phase: FocusPhase;
  minutes: number;
}

export interface FocusSession {
  durationMinutes: number;
  breakMinutes: number;
  longBreakMinutes: number;
  cyclesBeforeLongBreak: number;
  autoChain: boolean;
  phase: FocusPhase;
  remainingSeconds: number;
  running: boolean;
  endsAt: number | null;
  cycleIndex: number;
  totalFocusSeconds: number;
  todayFocusSeconds: number;
  todayDate: string;
  completedCount: number;
  history: FocusHistoryEntry[];
  completedAt: number | null;
}

export interface WeatherLocation {
  name: string;
  admin1?: string;
  country?: string;
  latitude: number;
  longitude: number;
  timezone: string;
}

export interface WeatherState {
  temperature: number;
  apparentTemperature: number;
  humidity: number;
  windSpeed: number;
  weatherCode: number;
  isDay: boolean;
  precipitationProbability: number;
  sunrise: string;
  sunset: string;
  daily: Array<{
    date: string;
    code: number;
    max: number;
    min: number;
    rain: number;
  }>;
}

export interface Settings {
  location: WeatherLocation;
  size: WidgetSize;
  topmost: boolean;
  excludeFromCapture: boolean;
  autostart: boolean;
  locale: "zh-CN" | "en-US";
  quoteCategory: "mixed" | "tech" | "philosophy";
  weatherEnabled: boolean;
  weatherVisualMode: WeatherVisualMode;
  surfaceStyle: SurfaceStyle;
  autoCollapseEnabled: boolean;
  swirlEnabled: boolean;
  idleDriftEnabled: boolean;
  terrainMode: TerrainMode;
  terrainIntensity: number;
  mouseGravityEnabled: boolean;
  effectQuality: EffectQuality;
  monthlyBudget: number;
  lowQuotaThreshold: number;
}

export interface UsageHeaderPair {
  name: string;
  value: string;
}

export interface UsageProviderConfig {
  enabled: boolean;
  name: string;
  url: string;
  method: "GET" | "POST";
  body?: string | null;
  usedPath: string;
  totalPath: string;
  breakdownPath?: string | null;
  refreshMinutes: number;
  headers: UsageHeaderPair[];
  hasAuthorization?: boolean | null;
}

export interface UsageSegment {
  label: string;
  tokens: number;
}

export interface UsageSnapshot {
  usedTokens: number;
  totalTokens: number;
  breakdown: UsageSegment[];
  sampledAt: string;
  source: string;
}

export type BalancePreset = "deepseek" | "openai-compatible";

export interface BalanceProviderConfig {
  enabled: boolean;
  name: string;
  preset: BalancePreset;
  baseUrl: string;
  accountUserId: string;
  refreshMinutes: number;
  hasApiKey?: boolean | null;
  hasAccountToken?: boolean | null;
}

export interface BalanceSnapshot {
  currency: string;
  totalBalance: string;
  grantedBalance: string;
  toppedUpBalance: string;
  source: string;
  sampledAt: string;
}

export interface BalanceHistoryPoint {
  timestamp: number;
  usage: number;
  requests: number;
}

export interface BalanceDetailsSnapshot {
  remainingBalance: string;
  recentUsage: string;
  historicalUsage: string;
  requestCount: number;
  currency: string;
  history: BalanceHistoryPoint[];
  sampledAt: string;
}

// ─── 剪贴板流星 (Clipboard Meteor) ─────────────────────────────────────
// 本机剪贴板变化的瞬时提示 + 会话内历史记录（内存，不落盘）。

export interface ClipboardEntry {
  id: number;
  text: string;
  copiedAt: number;
}

// ─── 星际通讯站 (Cosmos Relay) ──────────────────────────────────────────
// 局域网投递，接收端 MVP；协议对齐 LocalSend v2。

export interface RelayConfig {
  enabled: boolean;
  port: number;
  alias: string;
  destination: string;
  autoAccept: boolean;
  fingerprint: string;
}

export interface RelayDeviceInfo {
  alias: string;
  version: string;
  fingerprint: string;
  port: number;
  protocol: string;
  deviceModel: string;
  deviceType: string;
  download: boolean;
}

export interface RelayRecentRecord {
  filename: string;
  bytes: number;
  sender: string;
  receivedAt: number;
  destination: string;
}

export interface RelayStats {
  totalReceived: number;
  totalBytes: number;
  recent: RelayRecentRecord[];
}

export interface RelayTransferProgress {
  token: string;
  filename: string;
  received: number;
  total: number;
}

export interface RelayTransferComplete {
  token: string;
  filename: string;
  bytes: number;
  sender: string;
  destination: string;
}

export interface RelayStatusEvent {
  running: boolean;
  port: number;
  error?: string | null;
}
