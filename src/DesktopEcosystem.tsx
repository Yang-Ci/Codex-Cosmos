import { Clipboard, Flame, FolderInput, Moon, Pause, Play } from "lucide-react";
import type { DropPhase, EcosystemStats, FocusSession, TerrainMode, WeatherState, WeatherVisualMode } from "./types";

interface DesktopEcosystemProps {
  weather: WeatherState | null;
  weatherMode: WeatherVisualMode;
  stats: EcosystemStats;
  focus: FocusSession;
  comet: { id: number; text: string } | null;
  wormholeActive: boolean;
  wormholePhase: DropPhase;
  wormholeExit: { x: number; y: number; angle: number };
  forgeActive: boolean;
  forgePhase: DropPhase;
  terrainMode: TerrainMode;
  terrainIntensity: number;
  terrainImpact: { id: number; x: number; y: number } | null;
  onToggleFocus: () => void;
  onResetFocus: () => void;
  onCometClick: () => void;
  onWormholeClick: () => void;
}

function weatherKind(weather: WeatherState | null) {
  const code = weather?.weatherCode ?? 0;
  if (code >= 95) return "storm";
  if (code >= 71 && code <= 77) return "snow";
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  if (code === 45 || code === 48) return "fog";
  return weather?.isDay === false ? "night" : "clear";
}

function formatFocus(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function DesktopEcosystem({
  weather,
  weatherMode,
  stats,
  focus,
  comet,
  wormholeActive,
  wormholePhase,
  wormholeExit,
  forgeActive,
  forgePhase,
  terrainMode,
  terrainIntensity,
  terrainImpact,
  onToggleFocus,
  onResetFocus,
  onCometClick,
  onWormholeClick,
}: DesktopEcosystemProps) {
  const kind = weatherKind(weather);
  const focusProgress = 1 - focus.remainingSeconds / Math.max(1, focus.durationMinutes * 60);
  const destinationName = stats.wormholeDestination.split(/[\\/]/).filter(Boolean).at(-1) ?? "Downloads";
  const terrainLabel: Record<TerrainMode, string> = {
    none: "原生",
    gravity: "引力凹陷",
    crater: "月球坑",
    liquid: "液态桌面",
    snow: "积雪",
    dunes: "沙丘",
    dust: "太空尘埃",
  };

  return (
    <div
      className={`desktop-ecosystem weather-${kind} weather-mode-${weatherMode} terrain-${terrainMode} wormhole-${wormholePhase} forge-${forgePhase}`}
      style={{
        "--wind": Math.min(1, (weather?.windSpeed ?? 0) / 40),
        "--exit-x": `${wormholeExit.x}px`,
        "--exit-y": `${wormholeExit.y}px`,
        "--travel-x": `${wormholeExit.x - 32}px`,
        "--travel-y": `${wormholeExit.y - 127}px`,
        "--terrain-intensity": terrainIntensity,
      } as React.CSSProperties}
    >
      <div className="terrain-layer" aria-hidden="true">
        {Array.from({ length: 14 }, (_, index) => <i key={index} />)}
        {terrainImpact && <b key={terrainImpact.id} className="terrain-impact" style={{ left: terrainImpact.x, top: terrainImpact.y }} />}
      </div>

      <div className="liquid-glass-tag terrain-badge">{terrainLabel[terrainMode]}</div>
      <div className="weather-particles" aria-hidden="true">
        {Array.from({ length: 10 }, (_, index) => <i key={index} />)}
      </div>

      <button
        className={`wormhole-node${wormholeActive ? " is-active" : ""}`}
        onClick={onWormholeClick}
        title={`虫洞目标：${stats.wormholeDestination}`}
      >
        <span className="wormhole-rings"><i /><i /><i /></span>
        <FolderInput size={10} />
        <small>{wormholeActive ? "释放移动" : destinationName}</small>
      </button>

      {wormholeActive && (
        <>
          <div
            className="wormhole-exit"
            style={{ left: wormholeExit.x - 18, top: wormholeExit.y - 18, transform: `rotate(${wormholeExit.angle}deg)` }}
            aria-hidden="true"
          >
            <span className="wormhole-rings"><i /><i /><i /></span>
          </div>
          <div className="wormhole-transfer" aria-hidden="true">
            {Array.from({ length: 6 }, (_, index) => <i key={index} />)}
          </div>
        </>
      )}

      <div className={`star-forge${forgeActive ? " is-active" : ""}`} title={`ZIP 星炉目标：${stats.forgeDestination}`}>
        <span className="forge-corona"><i /><i /><i /></span>
        <Flame size={11} />
        <small>{forgeActive ? "释放处理" : "ZIP 炉"}</small>
      </div>
      {forgeActive && (
        <div className="forge-transfer" aria-hidden="true">
          {Array.from({ length: 8 }, (_, index) => <i key={index} />)}
        </div>
      )}

      <button
        className={`focus-moon${focus.running ? " is-running" : ""}`}
        style={{ "--focus-progress": `${focusProgress * 360}deg` } as React.CSSProperties}
        onClick={onToggleFocus}
        onDoubleClick={onResetFocus}
        title="单击开始/暂停专注，双击重置"
      >
        <Moon size={14} />
        <span>{focus.running ? <Pause size={7} /> : <Play size={7} />}</span>
        <small>{formatFocus(focus.remainingSeconds)}</small>
      </button>

      {comet && (
        <button key={comet.id} className="clipboard-comet" onClick={onCometClick} title={comet.text}>
          <i className="comet-tail" />
          <span><Clipboard size={9} /></span>
          <small>{comet.text.replace(/\s+/g, " ").slice(0, 18)}</small>
        </button>
      )}

      <div className="growth-orbit" title={`黑洞已吞噬 ${stats.totalRecycled} 个项目`}>
        <i /><span>{stats.totalRecycled}</span>
      </div>
    </div>
  );
}
