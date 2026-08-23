/* Lumen service worker — caches the app shell so it launches fast/offline.
   Network requests to Microsoft Graph and the thumbnail CDNs are left
   untouched (they're authenticated and shouldn't be cached here). */
const CACHE = "lumen-shell-v2";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // don't touch Graph / thumbnails

  // Network-first for our own files so updates land; fall back to cache offline.
  // Must always resolve with a Response: resolving with undefined makes the
  // page's request fail as a bare "Failed to fetch".
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      return res;
    } catch (err) {
      const hit = (await caches.match(req)) ||
                  (req.mode === "navigate" ? await caches.match("./index.html") : null);
      if (hit) return hit;
      return new Response("Offline and not cached", {
        status: 503, headers: { "Content-Type": "text/plain" },
      });
    }
  })());
});

// Let the page force an update / takeover.
self.addEventListener("message", (e) => {
  if (e.data === "skipWaiting") self.skipWaiting();
});
