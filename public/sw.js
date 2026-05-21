const CACHE_NAME = "dong-offline-cache-v1";
const OFFLINE_URL = "/offline.html";

// Phase 1: Installation - Cache the offline fallback page
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Cache the critical offline fallback HTML page
      return cache.addAll([OFFLINE_URL]);
    }),
  );
  // Force the waiting service worker to become the active service worker
  self.skipWaiting();
});

// Phase 2: Activation - Clean up old caches if any
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((cacheName) => cacheName !== CACHE_NAME)
          .map((cacheName) => caches.delete(cacheName)),
      );
    }),
  );
  // Tell the active service worker to take control of the page immediately
  self.clients.claim();
});

// Phase 3: Intercept requests - Serve cached offline.html on navigation failures
self.addEventListener("fetch", (event) => {
  // Only intercept document navigation requests (HTML page loads)
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).catch(() => {
        // Fetch failed (user is offline), return cached offline fallback page
        return caches.open(CACHE_NAME).then((cache) => {
          return cache.match(OFFLINE_URL);
        });
      }),
    );
  }
});
