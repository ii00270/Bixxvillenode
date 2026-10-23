// sw.js — keeps the app usable with no internet.
//
// App pages: NETWORK-FIRST (a pushed update always arrives), falling back to the
// saved copy when offline. { cache: 'no-store' } makes "network first" real —
// without it the browser's own HTTP cache can answer before the network is tried.
//
// Libraries and fonts the app loads from CDNs are saved on install and answered
// from the saved copy first, so the app can start with no connection. They are
// version-pinned, so a saved copy never goes stale.
//
// Database calls (Supabase) are never handled here. The page keeps its own
// offline copy of data (see "OFFLINE COPY" in terminal.html).

const CACHE_NAME = 'bixxville-v5';   // bump busts every older cache on activate
const LIB_CACHE = 'bixxville-libs-v1';
const SHELL = ['./', './index.html', './terminal.html', './manifest.json'];
const LIBS = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.110.0',
  'https://cdn.jsdelivr.net/npm/ethers@6.17.0/dist/ethers.umd.min.js',
  'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js',
];
const FONT_CSS = [
  'https://fonts.googleapis.com/css2?family=Anton&family=IBM+Plex+Mono:wght@300;400;500;600&family=Inter:wght@300;400;500;600;700&family=Syne:wght@700;800&display=swap',
  'https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400;6..72,500;6..72,600&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap',
];
const LIB_HOSTS = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'unpkg.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

async function saveLib(cache, url) {
  const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
  if (res.ok) await cache.put(url, res.clone());
  return res;
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(CACHE_NAME);
    await Promise.allSettled(SHELL.map((u) => shell.add(u)));
    const libs = await caches.open(LIB_CACHE);
    await Promise.allSettled(LIBS.map((u) => saveLib(libs, u)));
    // fonts: the stylesheet names the font files, so save those too
    for (const css of FONT_CSS) {
      try {
        const res = await saveLib(libs, css);
        const text = await res.text();
        const files = [...text.matchAll(/url\((https:[^)]+)\)/g)].map((m) => m[1]);
        await Promise.allSettled(files.map((f) => saveLib(libs, f)));
      } catch (e) { /* offline during install: they are saved on first online use instead */ }
    }
  })());
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME && n !== LIB_CACHE).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // libraries and fonts: saved copy first, fill in anything missing
  if (LIB_HOSTS.includes(url.hostname)) {
    event.respondWith((async () => {
      const cache = await caches.open(LIB_CACHE);
      const hit = await cache.match(req.url);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok) cache.put(req.url, res.clone());
        return res;
      } catch (e) { return Response.error(); }
    })());
    return;
  }

  // everything else on another origin (database, chain, prices, map tiles) is left alone
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(req, { cache: 'no-store' })
      .then((response) => {
        const clone = response.clone();
        if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        return response;
      })
      .catch(async () => (await caches.match(req)) || (await caches.match(req, { ignoreSearch: true })) ||
        (req.mode === 'navigate' ? await caches.match('./terminal.html') : undefined) || Response.error())
  );
});
