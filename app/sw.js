/* Service worker: makes the app open fast and work as an installed app.
   MP3 files are NOT cached here — they stream straight from dhammadownload.com. */
const VERSION = "tny-v5";
const SHELL = ["./", "index.html", "style.css", "app.js", "manifest.webmanifest", "data/index.json",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const put = (req, res) => {
  if (res.ok || res.type === "opaque") {
    const copy = res.clone();
    caches.open(VERSION).then(c => c.put(req, copy));
  }
  return res;
};

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (/\.mp3$/i.test(url.pathname)) return;               // audio: browser handles directly

  const sameOrigin = url.origin === location.origin;
  const isFont = /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if (!sameOrigin && !isFont) return;

  if (sameOrigin && url.pathname.includes("/data/")) {
    // talk lists: answer from cache at once, refresh in the background (stale-while-revalidate)
    e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => {
      const net = fetch(req).then(res => put(req, res));
      if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
      return net;
    }));
    return;
  }

  // app code & fonts: network first (fresh), cache when offline
  e.respondWith(fetch(req).then(res => put(req, res)).catch(() => caches.match(req)));
});
