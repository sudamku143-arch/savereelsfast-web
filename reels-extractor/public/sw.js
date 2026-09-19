/*
 * Minimal service worker for SaveReelsFast.
 *
 * It exists so browsers treat the site as an installable app. It deliberately
 * caches nothing: downloads, extraction results and pages always come from the
 * network, so users never see a stale page or a stale download link.
 */
self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// A fetch handler is what makes the app installable in some browsers;
// not calling respondWith() lets every request go straight to the network.
self.addEventListener("fetch", () => {});
