const CACHE = 'derivs-studio-v4-1';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './core.js',
  './models.js',
  './products.js',
  './engines.js',
  './mc-worker.js',
  './charts.js',
  './ui-vanilla.js',
  './ui-digital.js',
  './ui-autocallable.js',
  './ui-barrier.js',
  './ui-cliquet.js',
  './ui-calibration.js',
  './ui-localvol.js',
  './localvol.js',
  './sobol.js',
  './jobs.js',
  './transforms.js',
  './surface.js',
  './calibration.js',
  './manifest.webmanifest',
  './icon.svg'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;

  // ignoreSearch:true so that cache-busting query strings (e.g. ?v=2) still
  // match the pre-cached resource — keeps offline working across version bumps.
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(resp => {
        const clone = resp.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return resp;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
