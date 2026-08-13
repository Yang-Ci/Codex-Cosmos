export type WidgetSize = "compact" | "standard" | "expanded";
export type DropPhase = "idle" | "ready" | "processing" | "success" | "error" | "restoring";
export type WeatherVisualMode = "off" | "subtle" | "immersive";
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

export interface FocusSession {
  durationMinutes: number;
  remainingSeconds: number;
  running: boolean;
  endsAt: number | null;
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
  autostart: boolean;
  locale: "zh-CN" | "en-US";
  quoteCategory: "mixed" | "tech" | "philosophy";
  weatherEnabled: boolean;
  weatherVisualMode: WeatherVisualMode;
  idleDriftEnabled: boolean;
  terrainMode: TerrainMode;
  terrainIntensity: number;
  mouseGravityEnabled: boolean;
  effectQuality: EffectQuality;
  monthlyBudget: number;
  lowQuotaThreshold: number;
}
