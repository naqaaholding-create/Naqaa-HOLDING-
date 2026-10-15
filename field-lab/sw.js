const CACHE_NAME = "naqaa-field-lab-v1";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./navigation.css",
  "./subscriptions.css",
  "./sharing.css",
  "./wallet.css",
  "./research-analysis.css",
  "./terrain-profile.css",
  "./api-config.js",
  "./account.js",
  "./subscriptions.js",
  "./sharing.js",
  "./app.js",
  "./wallet.js",
  "./research-analysis.js",
  "./terrain-profile.js",
  "./navigation.js",
  "./manifest.webmanifest",
  "./icon.svg"
];
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(async cache => {
    await Promise.all(APP_SHELL.map(async path => {
      try {
        const response = await fetch(path, { cache: "reload" });
        if (response.ok) await cache.put(path, response);
      } catch (_) {}
    }));
    await self.skipWaiting();
  }));
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("naqaa-field-lab-") && key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  event.respondWith(fetch(request).then(response => {
    if (response.ok && response.type === "basic") {
      const copy = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(request, copy)).catch(() => {});
    }
    return response;
  }).catch(async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (request.mode === "navigate") return (await caches.match("./index.html")) || Response.error();
    return Response.error();
  }));
});
