// The app's own files work offline once seen; everything else (OpenAI's sign-in) goes straight to the network.
const SHELL = ['./', 'index.html', 'app.js', 'manifest.webmanifest', 'favicon.ico', 'favicon.svg', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'pair.html', 'pair.js'];
self.addEventListener('install', (e) => e.waitUntil(caches.open('byokit-shell-v3').then((c) => c.addAll(SHELL))));
self.addEventListener('fetch', (e) => {
  if (new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
