/**
 * Dev-only performance overlay.
 *
 * Inert unless the URL carries `?perf=1` — every entry point returns
 * immediately, nothing is mounted, and no timers run. No keyboard shortcut: the
 * UI already binds space, arrows, f, s and ? (see ui.ts).
 *
 * The headline number is **worst frame inside the last transition**. A stall at
 * a transition boundary is exactly what "it hangs before switching" looks like,
 * and an average frame time hides it completely.
 *
 * Frame cost is measured as the interval between engine ticks rather than by
 * timing the render call, because a dropped frame shows up as a long interval
 * whatever caused it — GPU upload, layout flush, or decode on the main thread.
 */

const ENABLED =
  typeof location !== 'undefined' &&
  new URLSearchParams(location.search).get('perf') === '1';

export const perfEnabled = ENABLED;

let lastFrame = 0;
let frameMs = 0;
let worstMs = 0;
let inTransition = false;
let worstInTransition = 0;
let lastTransitionWorst = 0;
let transitions = 0;

const marks = new Map<string, string>();
let statsFn: (() => Record<string, string | number>) | null = null;
let el: HTMLPreElement | null = null;

/** Call once per engine tick with real (not clock) time. */
export function perfFrame(now: number): void {
  if (!ENABLED) return;
  if (lastFrame) {
    frameMs = now - lastFrame;
    worstMs = Math.max(worstMs, frameMs);
    if (inTransition) worstInTransition = Math.max(worstInTransition, frameMs);
  }
  lastFrame = now;
}

/**
 * Bracket a transition. Entering resets `lastFrame` because the ticker may have
 * been stopped for a whole static dwell, and that gap is not a dropped frame.
 */
export function perfTransition(active: boolean): void {
  if (!ENABLED) return;
  if (active) {
    inTransition = true;
    worstInTransition = 0;
    lastFrame = 0;
    transitions++;
  } else if (inTransition) {
    inTransition = false;
    lastTransitionWorst = worstInTransition;
  }
}

/** Record a one-off timing, e.g. decode or upload of a single slide. */
export function perfMark(label: string, ms: number, note = ''): void {
  if (!ENABLED) return;
  marks.set(label, `${ms.toFixed(1)}ms${note ? ' ' + note : ''}`);
}

/** Register a snapshot callback and mount the overlay. */
export function perfStats(fn: () => Record<string, string | number>): void {
  if (!ENABLED) return;
  statsFn = fn;
  if (el) return;
  el = document.createElement('pre');
  el.style.cssText = [
    'position:fixed', 'top:8px', 'left:8px', 'z-index:9999',
    'margin:0', 'padding:8px 10px',
    'font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace',
    'color:#e8e8e8', 'background:rgba(0,0,0,.72)',
    'border:1px solid rgba(255,255,255,.14)', 'border-radius:6px',
    'pointer-events:none', 'white-space:pre', 'text-shadow:0 1px 2px #000',
  ].join(';');
  document.body.appendChild(el);
  // 4 Hz. Never per frame — the overlay must not be what it measures.
  setInterval(render, 250);
  render();
}

function render(): void {
  if (!el) return;
  const fps = frameMs > 0 ? 1000 / frameMs : 0;
  const rows: string[] = [
    `frame      ${frameMs.toFixed(1).padStart(6)}ms  (${fps.toFixed(0)} fps)`,
    `worst      ${worstMs.toFixed(1).padStart(6)}ms  all-time`,
    `IN-TRANS   ${lastTransitionWorst.toFixed(1).padStart(6)}ms  worst frame, last of ${transitions}`,
  ];
  for (const [k, v] of marks) rows.push(`${k.padEnd(10)} ${v}`);
  if (statsFn) {
    for (const [k, v] of Object.entries(statsFn())) rows.push(`${k.padEnd(10)} ${v}`);
  }
  el.textContent = rows.join('\n');
}
