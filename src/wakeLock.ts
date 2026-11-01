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
}

export function createWakeLock(): WakeLockHandle {
  const supported = 'wakeLock' in navigator;
  let sentinel: WakeLockSentinel | null = null;
  let wanted = false;
  let warned = false;
  let acquiring: Promise<void> | null = null;

  async function doAcquire() {
    if (!supported || sentinel) return;
    // Without the in-flight guard and the re-check below, a quick play/pause
    // leaked the lock permanently: acquire() awaited the request, release() saw
    // no sentinel yet and returned, then the request resolved and stored one
    // that nothing would ever release.
    if (acquiring) return acquiring;
    acquiring = (async () => {
      try {
        const s = await navigator.wakeLock.request('screen');
        if (!wanted) { void s.release(); return; }
        sentinel = s;
        // Identity-guarded: a stale sentinel's late release event must not null
        // out a newer one, which would leave it unreleasable.
        s.addEventListener('release', () => { if (sentinel === s) sentinel = null; });
      } catch (err) {
        if (!warned) {
          console.warn('[slideshow] Wake lock unavailable:', err);
          warned = true;
        }
      } finally {
        acquiring = null;
      }
    })();
    return acquiring;
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
    async acquire() { wanted = true; await doAcquire(); },
    async release() { wanted = false; await doRelease(); },
  };
}
