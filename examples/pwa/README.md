# Browser example

After `npm ci` and `npm run build`, run `node examples/pwa/serve.ts 8080` and open
`http://127.0.0.1:8080/`.

Once its service worker installs successfully, the home, pairing and sample usage
pages and their scripts are available offline. The usage page shows demo activity,
not a fresh provider reading. Sign-in, model calls and connecting to another device
still require their normal network connections.

Updates install a new shell cache and activate after all old tabs close. Activation
removes earlier BYOKit shell caches, leaving unrelated caches alone. An uncached
navigation while offline shows a deliberate reconnect/home fallback (HTTP 503);
a missing file returns a plain-text HTTP 503 instead of an absent response.

`npm run test:browser` checks the real browser install, old-cache upgrade, offline
pages/scripts and uncached navigation, alongside the sign-in and pairing tests.
