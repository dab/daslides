/**
 * Screen Wake Lock — keeps the display from dimming or sleeping, and prevents
 * the OS screensaver from kicking in. Chrome / Edge / Opera / Safari support
 * it; on Firefox we silently degrade (no-op).
 *
 * Usage:
 *   const wake = createWakeLock();
 *   wake.acquire();   // when playback starts
 *   wake.release();   // when paused
 *
 * The browser automatically drops the lock when the tab is hidden — we listen
 * for visibilitychange and re-acquire whenever the user comes back to the tab
 * and we're supposed to be holding it.
 */
export interface WakeLockHandle {
  acquire(): Promise<void>;
  release(): Promise<void>;
  /** True if we currently hold (or want to hold) a lock. */
  readonly held: boolean;
}

export function createWakeLock(): WakeLockHandle {
  const supported = 'wakeLock' in navigator;
  let sentinel: WakeLockSentinel | null = null;
  let wanted = false;
  let warned = false;

  async function doAcquire() {
    if (!supported || sentinel) return;
    try {
      sentinel = await navigator.wakeLock.request('screen');
      sentinel.addEventListener('release', () => { sentinel = null; });
    } catch (err) {
      if (!warned) {
        console.warn('[slideshow] Wake lock unavailable:', err);
        warned = true;
      }
    }
  }

  async function doRelease() {
    if (!sentinel) return;
    try { await sentinel.release(); } catch {}
    sentinel = null;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && wanted && !sentinel) {
      void doAcquire();
    }
  });

  return {
    get held() { return wanted; },
    async acquire() { wanted = true; await doAcquire(); },
    async release() { wanted = false; await doRelease(); },
  };
}
