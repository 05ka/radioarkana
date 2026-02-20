// ── Radio Arkana · Service Worker ──────────────────────────────────────────
// Versión de caché — incrementar para forzar actualización
const CACHE_VERSION = 'arkana-v1';

// Assets que se cachean al instalar (shell de la app)
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  // Fuentes de Google — se cachean en runtime la primera vez
];

// Dominios externos que nunca se cachean (streaming en vivo, worker)
const NEVER_CACHE = [
  'stream.radioarkana.com',
  'oscardevalle.workers.dev',
  'fonts.googleapis.com',   // la API de Google Fonts sí puede cambiar
];

// ── INSTALL: pre-cachear el shell ──────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => {
      return cache.addAll(PRECACHE_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// ── ACTIVATE: limpiar cachés viejas ────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_VERSION)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// ── FETCH: estrategia híbrida ───────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // 1. Nunca interceptar: stream, worker counter, chrome-extension, etc.
  if (
    NEVER_CACHE.some(domain => url.hostname.includes(domain)) ||
    event.request.url.startsWith('chrome-extension') ||
    event.request.method !== 'GET'
  ) {
    return; // deja pasar sin interceptar
  }

  // 2. Fuentes de Google: cache-first (muy estables)
  if (url.hostname.includes('fonts.gstatic.com')) {
    event.respondWith(
      caches.open(CACHE_VERSION).then(cache =>
        cache.match(event.request).then(cached => {
          if (cached) return cached;
          return fetch(event.request).then(response => {
            cache.put(event.request, response.clone());
            return response;
          });
        })
      )
    );
    return;
  }

  // 3. Todo lo demás (index.html, assets propios): Network-first con fallback a caché
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Si la respuesta es válida, actualizamos la caché
        if (response && response.status === 200 && response.type !== 'opaque') {
          const responseClone = response.clone();
          caches.open(CACHE_VERSION).then(cache => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(() => {
        // Sin conexión → servir desde caché
        return caches.match(event.request).then(cached => {
          if (cached) return cached;
          // Fallback final: siempre servir index.html para rutas de navegación
          if (event.request.mode === 'navigate') {
            return caches.match('/index.html');
          }
          return new Response('Sin conexión', { status: 503 });
        });
      })
  );
});

// ── MENSAJE: forzar actualización desde la app ──────────────────────────────
self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') {
    self.skipWaiting();
  }
});
