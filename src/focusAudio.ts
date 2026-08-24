// Lightweight Web Audio chimes for the focus moon. No assets required.
// The AudioContext is created lazily and resumed on the first user gesture,
// so chimes only play after the user has interacted with the app at least once.

let ctx: AudioContext | null = null;

function ensureCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    if (!ctx) {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    }
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** Call on any user gesture to unlock audio for later chimes. */
export function resumeAudio(): void {
  ensureCtx();
}

function tone(c: AudioContext, freq: number, start: number, dur: number, peak: number): void {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.linearRampToValueAtTime(peak, start + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(gain).connect(c.destination);
  osc.start(start);
  osc.stop(start + dur + 0.03);
}

/**
 * Play a completion chime. `focus` (a focus cycle just ended) uses a bright
 * ascending arpeggio; `break` (a break just ended, next focus starting) uses a
 * softer two-note cue.
 */
export function playChime(kind: "focus" | "break"): void {
  const c = ensureCtx();
  if (!c) return;
  const now = c.currentTime;
  const notes = kind === "focus" ? [659.25, 783.99, 1046.5] : [523.25, 659.25];
  notes.forEach((freq, index) => tone(c, freq, now + index * 0.13, 0.55, 0.12));
}
