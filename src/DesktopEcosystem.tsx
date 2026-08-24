import { useEffect, useState } from "react";
import { Flame, FolderInput, Pause, Play, SkipForward, RotateCcw } from "lucide-react";
import type { DropPhase, EcosystemStats, FocusSession, TerrainMode, WeatherState, WeatherVisualMode } from "./types";

interface DesktopEcosystemProps {
  weather: WeatherState | null;
  weatherMode: WeatherVisualMode;
  stats: EcosystemStats;
  focus: FocusSession;
  meteors: { id: number; x: number; y: number }[];
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
  onSkipFocus: () => void;
  onWheelFocus: (deltaMinutes: number) => void;
  onSelectFocusDuration: (minutes: number) => void;
  onMeteorClick: () => void;
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

/** Full seconds for the focus moon's current phase (focus duration or the matching break length). */
function phaseSeconds(s: FocusSession): number {
  if (s.phase === "focus") return s.durationMinutes * 60;
  const long = s.cycleIndex % Math.max(1, s.cyclesBeforeLongBreak) === 0;
  return (long ? s.longBreakMinutes : s.breakMinutes) * 60;
}

const RING_RADIUS = 17;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export function DesktopEcosystem({
  weather,
  weatherMode,
  stats,
  focus,
  meteors,
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
  onSkipFocus,
  onWheelFocus,
  onSelectFocusDuration,
  onMeteorClick,
  onWormholeClick,
}: DesktopEcosystemProps) {
  const kind = weatherKind(weather);
  const phaseSec = Math.max(1, phaseSeconds(focus));
  const progress = 1 - focus.remainingSeconds / phaseSec;            // 0 -> 1 as the phase elapses
  const ringFrac = focus.remainingSeconds / phaseSec;                 // ring depletes with remaining time
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

  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });
  const [flashing, setFlashing] = useState(false);

  // Trigger the completion burst whenever a phase finishes.
  useEffect(() => {
    if (!focus.completedAt) return;
    setFlashing(true);
    const timer = window.setTimeout(() => setFlashing(false), 1300);
    return () => window.clearTimeout(timer);
  }, [focus.completedAt]);

  // Close the context menu on any outside click.
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && target.closest(".focus-menu")) return;
      setMenuOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menuOpen]);

  const openMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    const w = typeof window !== "undefined" ? window.innerWidth : 184;
    const h = typeof window !== "undefined" ? window.innerHeight : 164;
    setMenuPos({ x: Math.min(event.clientX, w - 130 - 6), y: Math.min(event.clientY, h - 150 - 6) });
    setMenuOpen(true);
  };

  const closeMenu = (event?: React.MouseEvent) => {
    event?.stopPropagation();
    setMenuOpen(false);
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
        className={`focus-moon phase-${focus.phase}${focus.running ? " is-running" : ""}${flashing ? " is-complete" : ""}`}
        style={{
          "--moon-lit": String(0.18 + 0.82 * progress),
          "--ring-frac": String(ringFrac),
          "--focus-progress": `${focusProgress * 360}deg`,
        } as React.CSSProperties}
        onClick={onToggleFocus}
        onDoubleClick={(event) => { event.preventDefault(); onResetFocus(); }}
        onContextMenu={openMenu}
        onWheel={(event) => { onWheelFocus(event.deltaY < 0 ? 5 : -5); }}
        title="单击 开始/暂停 · 双击 重置 · 右键 菜单 · 滚轮 调时长 · F/R/S 快捷键"
      >
        <svg className="focus-ring" viewBox="0 0 40 40" aria-hidden="true">
          <circle className="focus-ring-track" cx="20" cy="20" r={RING_RADIUS} />
          <circle
            className="focus-ring-progress"
            cx="20" cy="20" r={RING_RADIUS}
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={RING_CIRCUMFERENCE * (1 - ringFrac)}
          />
        </svg>
        <span className="focus-moon-face" aria-hidden="true" />
        <span className="focus-moon-icon">{focus.running ? <Pause size={9} /> : <Play size={9} />}</span>
        <small className="focus-moon-time">{formatFocus(focus.remainingSeconds)}{focus.phase === "break" ? "·休" : ""}</small>
        <span className="focus-burst" aria-hidden="true" />
      </button>

      {menuOpen && (
        <div className="focus-menu" style={{ left: menuPos.x, top: menuPos.y }} onContextMenu={(event) => event.preventDefault()}>
          <button className="focus-menu-item" onClick={(event) => { closeMenu(event); onToggleFocus(); }}>
            {focus.running ? <Pause size={10} /> : <Play size={10} />}<span>{focus.running ? "暂停" : "开始"}</span>
          </button>
          <button className="focus-menu-item" onClick={(event) => { closeMenu(event); onResetFocus(); }}>
            <RotateCcw size={10} /><span>重置</span>
          </button>
          <button className="focus-menu-item" onClick={(event) => { closeMenu(event); onSkipFocus(); }}>
            <SkipForward size={10} /><span>跳过 → {focus.phase === "focus" ? "休息" : "专注"}</span>
          </button>
          <div className="focus-menu-seg">
            {[25, 45, 60].map((minutes) => (
              <button key={minutes} className={focus.durationMinutes === minutes ? "active" : ""} onClick={(event) => { closeMenu(event); onSelectFocusDuration(minutes); }}>{minutes}m</button>
            ))}
          </div>
          <div className="focus-menu-stats">
            今日 {Math.round(focus.todayFocusSeconds / 60)}m · 累计 {(focus.totalFocusSeconds / 3600).toFixed(1)}h · {focus.completedCount} 次
          </div>
        </div>
      )}

      {meteors.map((meteor) => (
        <button
          key={meteor.id}
          className="clipboard-meteor"
          onClick={onMeteorClick}
          title="剪贴板已更新 · 点击查看"
          style={{ left: meteor.x, top: meteor.y }}
        >
          <i className="meteor-tail" />
          <span />
        </button>
      ))}

      <div className="growth-orbit" title={`黑洞已吞噬 ${stats.totalRecycled} 个项目`}>
        <i /><span>{stats.totalRecycled}</span>
      </div>
    </div>
  );
}
