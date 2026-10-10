/* Only public assets and a generic offline screen are cached, never user data. */
const CACHE = "monio-static-v2";
const OFFLINE = "/offline.html";
const STATIC = [/^\/_next\/static\//, /^\/icons\//];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.add(OFFLINE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("monio-static-") && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigations always use the network; only connection failures show the public fallback.
  if (request.mode === "navigate" && !/^\/api(?:\/|$)/.test(url.pathname)) {
    event.respondWith(fetch(request).catch(async () => {
      const fallback = await caches.match(OFFLINE, { cacheName: CACHE });
      return fallback || Response.error();
    }));
    return;
  }
  if (!STATIC.some((pattern) => pattern.test(url.pathname))) return;
  event.respondWith(caches.open(CACHE).then(async (cache) => {
    const hit = await cache.match(request);
    if (hit) return hit;
    const response = await fetch(request);
    if (response.ok && response.type === "basic" && !response.redirected) {
      await cache.put(request, response.clone());
    }
    return response;
  }));
});
