// Only the installed app shell works offline; sign-in and model calls still need the network.
const CACHE = 'byokit-shell-v4';
const SHELL = ['./', 'index.html', 'app.js', 'manifest.webmanifest', 'favicon.ico', 'favicon.svg', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'pair.html', 'pair.js', 'usage.html', 'usage.js'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))));
// Normal activation waits for old clients to close; leave other apps' caches alone.
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((keys) => Promise.all(
  keys.filter((key) => key.startsWith('byokit-shell-') && key !== CACHE).map((key) => caches.delete(key)),
))));
self.addEventListener('fetch', (e) => {
  if (new URL(e.request.url).origin !== location.origin || e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).catch(async () => {
    const cached = await (await caches.open(CACHE)).match(e.request);
    if (cached) return cached;
    return new Response(e.request.mode === 'navigate'
      ? '<!doctype html><html lang="en"><meta charset="utf-8"><title>Offline · BYOKit</title><h1>You’re offline</h1><p>This page is not saved on this device. <a href="./">Open the home page</a>, or reconnect and try again.</p></html>'
      : 'Offline: this file is not saved on this device.', {
      status: 503, headers: { 'content-type': e.request.mode === 'navigate' ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8' },
    });
  }));
});
