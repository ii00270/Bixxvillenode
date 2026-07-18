// sw.js — minimal service worker. Its only job is to satisfy PWA
// installability requirements and keep the app usable offline.
//
// Strategy: NETWORK-FIRST for the app shell. The old cache-first approach
// pinned every visitor to whatever index.html they first loaded — pushed
// updates never arrived until sw.js itself changed. Now every load tries
// the network for a fresh copy and only falls back to cache when offline.
// External calls (Supabase, RPCs, price APIs) are never cached at all.

const CACHE_NAME = 'bixxville-v2'; // bump busts every older cache on activate

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(['./', './index.html', './manifest.json']))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never touch cross-origin requests — Supabase, chain RPCs, price APIs
  // must always be live.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
