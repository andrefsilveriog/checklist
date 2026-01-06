/* Simple offline cache for GitHub Pages (update-friendly)
   IMPORTANT: we only cache SAME-ORIGIN, GET requests.
   Never intercept Firestore/Firebase network calls, or realtime listeners can stall. */
const CACHE_NAME = 'nossa-checklist-v11';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

async function networkFirst(req) {
  try {
    const res = await fetch(req);
    const copy = res.clone();
    const cache = await caches.open(CACHE_NAME);
    cache.put(req, copy).catch(() => {});
    return res;
  } catch {
    const cached = await caches.match(req);
    if (cached) return cached;
    throw new Error('offline');
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle same-origin GET requests. Let the browser handle everything else.
  if (req.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  // Network-first for HTML navigations so updates arrive.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('./', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('./'))
    );
    return;
  }

  // Network-first for core app assets so installed PWAs don't get stuck on old JS/CSS.
  const isCoreAsset = (url.origin === self.location.origin) && (
    url.pathname.endsWith('/app.js') ||
    url.pathname.endsWith('/styles.css') ||
    url.pathname.endsWith('/manifest.json') ||
    url.pathname.endsWith('/icon-192.png') ||
    url.pathname.endsWith('/icon-512.png')
  );

  if (isCoreAsset) {
    event.respondWith(networkFirst(req));
    return;
  }

  // Cache-first for same-origin GET requests that are NOT core assets.
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
      return res;
    }))
  );
});
