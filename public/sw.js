/*
 * Monio service worker — deliberately conservative.
 * Only immutable static assets (hashed Next.js chunks, icons, fonts) are cached.
 * Pages, API responses and anything containing financial data are NEVER cached:
 * they always go to the network.
 */
const CACHE = "monio-static-v1";
const STATIC = [/^\/_next\/static\//, /^\/icons\//];

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (!STATIC.some((re) => re.test(url.pathname))) return; // network only

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(request);
      if (hit) return hit;
      const response = await fetch(request);
      if (response.ok) cache.put(request, response.clone());
      return response;
    }),
  );
});
