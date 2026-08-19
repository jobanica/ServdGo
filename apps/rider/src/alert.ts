/**
 * The sound a new request makes.
 *
 * A rider is not staring at the screen — the phone is in a pocket, on a mount,
 * in the rain. A request that only appears silently is a request that goes to
 * whoever happened to be looking. So: a chime, a buzz, and a repeat while it
 * sits there unanswered.
 *
 * Synthesised rather than shipped as a file. It keeps the bundle small, it
 * survives a bad connection (nothing to fetch), and the tone can be tuned in
 * one place instead of re-recording an asset.
 */

const MUTED_KEY = 'ebd:rider-alert-muted';

let ctx: AudioContext | null = null;

type AudioCtor = typeof AudioContext;
function audioCtor(): AudioCtor | null {
  const w = globalThis as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/**
 * Browsers refuse to make noise until the user has touched the page, so the
 * context is created and resumed on the first interaction and kept for the
 * session. Without this the first request of a shift is silent — the one that
 * matters most, because the rider has not looked at the app yet.
 */
export function armAlertSound(): () => void {
  const arm = () => {
    try {
      const Ctor = audioCtor();
      if (!Ctor) return;
      ctx ??= new Ctor();
      if (ctx.state === 'suspended') void ctx.resume();
    } catch { /* no audio on this device; the buzz and the badge remain */ }
  };
  const events: (keyof WindowEventMap)[] = ['pointerdown', 'keydown', 'touchstart'];
  for (const e of events) window.addEventListener(e, arm, { passive: true });
  return () => { for (const e of events) window.removeEventListener(e, arm); };
}

export function isAlertMuted(): boolean {
  try { return localStorage.getItem(MUTED_KEY) === '1'; } catch { return false; }
}

export function setAlertMuted(muted: boolean): void {
  try { localStorage.setItem(MUTED_KEY, muted ? '1' : '0'); } catch { /* ignore */ }
}

/** One two-note ping. Rising, so it reads as "something arrived", not "something broke". */
function ping(at: number): void {
  if (!ctx) return;
  for (const [i, freq] of [880, 1320].entries()) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const start = at + i * 0.16;
    // A hard start and stop on a sine is a click; ramp both ends.
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.35, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.15);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + 0.18);
  }
}

/**
 * Announce a new request: two pings and a buzz.
 *
 * Never throws — a device with no audio, no vibration, or a muted rider still
 * has to get through the rest of the render.
 */
export function playNewOrderAlert(): void {
  if (isAlertMuted()) return;
  try {
    if (ctx && ctx.state !== 'closed') {
      if (ctx.state === 'suspended') void ctx.resume();
      const now = ctx.currentTime;
      ping(now);
      ping(now + 0.42);
    }
  } catch { /* fall through to the buzz */ }
  try {
    (navigator as Navigator & { vibrate?: (p: number | number[]) => boolean })
      .vibrate?.([180, 90, 180]);
  } catch { /* ignore */ }
}
