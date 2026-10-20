# GitHub device-code sign-in

A consumer app connects a person's GitHub with a device code through `@byokit/connect`: `deviceSignIn` shows a code and `github.com/login/device`, the person types the code on any device, and `connect(...).connected()` reads true. Only an approved code stores a grant.

## Sub-features

- `device-approved`: pending, then `slow_down` (the next wait grows by 5 s), then approval stores one grant that `grant()`/`token()` read back.
- `device-expired`: GitHub's `expired_token` rejects with `ConnectError` code `expired`; nothing stored.
- `device-denied`: GitHub's `access_denied` (the person pressed Cancel) rejects with `ConnectError` code `declined`; nothing stored.
- `device-cancelled`: the app's `cancel()` while polling rejects `finish()` with `declined`; nothing stored.

## How to get to it (user POV)

- `deviceSignIn('github', { store, person, client: { id }, scopes })`, show `userCode` and `verificationUri`, `await finish()` (packages/connect/README.md, "Connect GitHub with a device code").

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md).

- **Write the consumer.** `"$scratch_dir/verify-connect-github-device.mjs"` importing `connect`, `deviceSignIn`, `providers`, `ConnectError` from `@byokit/connect` and `createServer` from `node:http`. First line after imports replaces `globalThis.fetch` with a wrapper that throws for any non-`127.0.0.1` URL. A loopback `node:http` server answers `POST /login/device/code` with `{ device_code, user_code: 'WDJB-MJHT', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 0 }` and each `POST /login/oauth/access_token` with the next queued answer (HTTP 200 with an `error` field, as GitHub does), recording each poll's time; every answer sets `connection: close`, since a reused idle keep-alive socket can delay a poll's arrival by seconds and skew the gaps. Use `{ ...providers.github, device: { code: <origin>/login/device/code, token: <origin>/login/oauth/access_token } }`, an in-memory keystore, `client: { id: 'fixture-client' }`, `scopes: ['repo']`. Run approved (`authorization_pending`, `slow_down`, then `{ access_token, token_type: 'bearer', scope: 'repo' }`), then `expired_token`, `access_denied`, and a `cancel()` after the first poll, each with a fresh store. Print the code and URI, the gaps between polls in ms, `connected()`, each error's code and message, and each store's size; exit 1 unless only the approved store holds one entry.
- **Run and capture.** `feature=connect-github-device; entry=@byokit/connect; drive=(node "$scratch_dir/verify-connect-github-device.mjs")`, then SKILL.md Evidence's capture block. Exit code `0`.
- **Approved shows.** `code: WDJB-MJHT at https://github.com/login/device`, a first gap near 1000 ms and a second at least 6000 ms, `connected: true`, `stored: 1`.
- **Ended legs show.** `expired | This sign-in has expired. Start again. | stored: 0`, `declined | Nothing was connected. Try again whenever you like. | stored: 0` for both the denial and the cancel.

## Gotchas

- The approved leg waits about 7 s of real time (1 s minimum interval, then 1 s + 5 s after `slow_down`).
- Never point a drive at real github.com: a live sign-in needs the owner's own OAuth app and is a separate proof.
