// SnapReceipt Service Worker
// Required for PWA installability on Android Chrome.
// Minimal: installs immediately, serves from network with cache fallback.

const CACHE = 'snapreceipt-v1';

self.addEventListener('install', function(e) {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(function(cache) {
      return cache.addAll(['/']);
    }).catch(function() {})
  );
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE; })
            .map(function(k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function(e) {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).then(function(res) {
      // Cache a copy of the main page
      if (e.request.url.endsWith('/') || e.request.url.endsWith('index.html')) {
        var copy = res.clone();
        caches.open(CACHE).then(function(c) { c.put(e.request, copy); });
      }
      return res;
    }).catch(function() {
      return caches.match(e.request);
    })
  );
});