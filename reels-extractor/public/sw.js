/*
 * Service worker for SaveReelsFast.
 *
 * It makes the site installable and shows a friendly page when someone opens
 * the app without a connection. It deliberately caches nothing else: pages,
 * extraction results and downloads always come from the network, so users
 * never see a stale page or an expired download link.
 */
const CACHE = "srf-offline-v1";
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add(new Request(OFFLINE_URL, { cache: "reload" })))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

// Active fetch handler. Only page navigations are touched: they go to the network as
// usual and fall back to the offline page if that fails. Everything else (API calls,
// large streamed downloads, range requests) is left completely alone.
self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;

  event.respondWith(
    fetch(event.request).catch(async () => {
      const offline = await caches.match(OFFLINE_URL);
      return offline || Response.error();
    })
  );
});
