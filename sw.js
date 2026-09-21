// Service worker de ActivArte: cache offline-first del app shell + fuentes.
// Los llamados a Firebase Auth/Firestore (firestore.googleapis.com, identitytoolkit.googleapis.com, etc.)
// NO pasan por acá: no están en la lista de hosts permitidos más abajo, así que el navegador los maneja
// directamente. Eso es intencional — son API calls en vivo, no assets estáticos, y Firestore ya maneja
// su propio cache offline (persistentLocalCache) del lado del cliente.
const CACHE_VERSION = 'v17';
const CACHE_NAME = `bitacora-cache-${CACHE_VERSION}`;

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './firebase-config.js',
  './sync.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  'https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@600;800&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap',
];

// Hosts estáticos cacheables además del propio origen: fuentes + el SDK de Firebase servido por CDN.
const ALLOWED_CDN_HOSTS = new Set([
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'www.gstatic.com',
]);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.all(
        APP_SHELL.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('[sw] No se pudo precachear', url, err);
          })
        )
      );
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const isAllowedCdn = ALLOWED_CDN_HOSTS.has(url.hostname);
  const isSameOrigin = url.origin === self.location.origin;

  if (!isSameOrigin && !isAllowedCdn) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match(req).then((cached) => {
        return cached || fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          return res;
        }).catch(() => caches.match('./index.html'));
      })
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return res;
      }).catch(() => cached);
    })
  );
});
