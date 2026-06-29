const VERSION = 'collecte-terrain-v1';
const APP_CACHE = `${VERSION}-app`;
const DATA_CACHE = `${VERSION}-data`;
const GEO_CACHE = `${VERSION}-geojson`;
const APP_SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(APP_CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => ![APP_CACHE, DATA_CACHE, GEO_CACHE].includes(key)).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(request, cacheName, fallbackUrl = null) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    if (fallbackUrl) {
      const fallback = await caches.match(fallbackUrl);
      if (fallback) return fallback;
    }
    throw error;
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request).then((response) => {
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => null);
  return cached || network || new Response(JSON.stringify({ error: 'Ressource indisponible hors ligne' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, APP_CACHE, '/'));
    return;
  }

  if (/\.(geojson|json)$/i.test(url.pathname) || url.pathname.startsWith('/uploads/')) {
    event.respondWith(staleWhileRevalidate(request, GEO_CACHE));
    return;
  }

  if (url.pathname.startsWith('/api/entities/')) {
    event.respondWith(networkFirst(request, DATA_CACHE));
    return;
  }

  if (['script','style','font','image'].includes(request.destination)) {
    event.respondWith(staleWhileRevalidate(request, APP_CACHE));
  }
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data?.type === 'CACHE_URLS' && Array.isArray(event.data.urls)) {
    event.waitUntil(caches.open(GEO_CACHE).then(async (cache) => {
      for (const url of event.data.urls) {
        try { const res = await fetch(url, { credentials: 'include' }); if (res.ok) await cache.put(url, res.clone()); } catch (_) {}
      }
    }));
  }
});
