/* eslint-disable no-restricted-globals */
/**
 * Service worker for daslides.
 *
 * Two jobs, and only two:
 *
 *   1. Make the app installable. Chromium will not fire `beforeinstallprompt`
 *      without a service worker that has a fetch handler, so the drawer's
 *      "Install app" button was unreachable on every Chromium browser.
 *
 *   2. Make it work offline. The whole pitch is that photos never leave the
 *      device, which ought to include opening them on a plane.
 *
 * Strategy is deliberately split, because the two kinds of request have
 * opposite risks:
 *
 *   Navigations go to the NETWORK FIRST. index.html is the one file whose name
 *   never changes, so caching it first is how you serve a stale shell that
 *   points at deleted asset chunks — the exact trap the inline recovery script
 *   in index.html exists to paper over. Going to the network first means a
 *   deploy is picked up on the next online load, and the cache is only a
 *   fallback for when there is no network at all.
 *
 *   Hashed assets go to the CACHE FIRST. Their filenames contain a content
 *   hash, so a cached copy can never be the wrong version — if the content
 *   changes, so does the URL.
 *
 * `__PRECACHE__` is replaced at build time by vite.config.ts with the real
 * asset list; in dev this file is never registered.
 */

const VERSION = '__VERSION__';
const CACHE = `daslides-${VERSION}`;
const PRECACHE = __PRECACHE__;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Individually, so one missing file can't fail the whole install.
      await Promise.allSettled(PRECACHE.map((url) => cache.add(new Request(url, { cache: 'reload' }))));
      self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n.startsWith('daslides-') && n !== CACHE).map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // fonts etc. stay untouched

  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(CACHE);
          cache.put(new Request(url.pathname), fresh.clone());
          return fresh;
        } catch {
          const cache = await caches.open(CACHE);
          return (
            (await cache.match(new Request(url.pathname))) ||
            (await cache.match('index.html')) ||
            Response.error()
          );
        }
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const fresh = await fetch(req);
        // Only store successful same-origin responses; an opaque or error
        // response cached here would be served forever.
        if (fresh.ok) cache.put(req, fresh.clone());
        return fresh;
      } catch {
        return hit || Response.error();
      }
    })(),
  );
});
