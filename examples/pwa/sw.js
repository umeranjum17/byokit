// The app's own files work offline once seen; everything else (OpenAI's sign-in) goes straight to the network.
const SHELL = ['./', 'index.html', 'app.js', 'manifest.webmanifest', 'icon.png', 'pair.html', 'pair.js'];
self.addEventListener('install', (e) => e.waitUntil(caches.open('byokit-shell-v2').then((c) => c.addAll(SHELL))));
self.addEventListener('fetch', (e) => {
  if (new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
