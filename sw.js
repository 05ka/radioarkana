// ── Radio Arkana · Service Worker ──────────────────────────────────────────
// Versión de caché — incrementar para forzar actualización
const CACHE_VERSION = 'arkana-v9';

// Assets que se cachean al instalar (shell de la app)
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/camera.html',
  '/manifest.json',
  '/camera-manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-cam-192.png',
  '/icon-cam-512.png',
];

// Dominios externos que nunca se cachean (streaming en vivo, worker, qrng)
const NEVER_CACHE = [
  'stream.radioarkana.com',
  'oscardevalle.workers.dev',
  'qrng.anu.edu.au',
  'fonts.googleapis.com',
];

// ── INSTALL: pre-cachear el shell ──────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => {
      // addAll falla si algún recurso no existe — usamos add individual
      // con catch para que iconos opcionales no rompan la instalación
      return Promise.allSettled(
        PRECACHE_ASSETS.map(url =>
          cache.add(url).catch(err =>
            console.warn(`[SW] No se pudo cachear ${url}:`, err)
          )
        )
      );
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

  // 1. Nunca interceptar: stream, worker, qrng, chrome-extension, no-GET
  if (
    NEVER_CACHE.some(domain => url.hostname.includes(domain)) ||
    event.request.url.startsWith('chrome-extension') ||
    event.request.method !== 'GET'
  ) {
    return;
  }

  // 2. Fuentes de Google (gstatic): cache-first — muy estables
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

  // 3. Todo lo demás (index.html, camera.html, assets propios):
  //    Network-first con fallback a caché
  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response && response.status === 200 && response.type !== 'opaque') {
          const clone = response.clone();
          caches.open(CACHE_VERSION).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() =>
        caches.match(event.request).then(cached => {
          if (cached) return cached;
          // Fallback de navegación:
          // — si la ruta es camera.html o empieza por /camera → servir camera.html
          // — cualquier otra navegación → index.html
          if (event.request.mode === 'navigate') {
            if (url.pathname.startsWith('/camera')) {
              return caches.match('/camera.html');
            }
            return caches.match('/index.html');
          }
          return new Response('Sin conexión', { status: 503 });
        })
      )
  );
});

// ── MENSAJE: forzar actualización desde la app ──────────────────────────────
self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') {
    self.skipWaiting();
  }
});
