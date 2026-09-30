# Changelog

## Unreleased

## 0.5.0 (2026-10-01)

- Dependency update: pins @byokit/ui-core 0.5.0.

- `recommend()`: one entry per route (`{ via, recommended, sentence, needs, disabledReason? }`), recommended
  first — current healthy route, then Tailscale Serve (direct when the Serve root is taken, disabled, funnelled,
  or nameless), then a private overlay, then Same Wi-Fi. Words from ui-core's `routeChoices()`; probes
  `tailscaleState`/`inspectServe`/`routes()` live unless `state`, `serve`, `lan` and `private` fakes are passed.

- `directRoutes()` combines explicit loopback, tailnet and LAN listener scopes with typed hosts and ordered dial URLs.
- Node and React Native share `nativeAddresses()`, `routeOf()`, `observe()` and bounded `probe()` observations; native readers are injectable and home evidence uses actual prefixes.
- Explicit `@byokit/reach/react-native` entry alongside the existing export condition.

## 0.4.0 (2026-09-30)

- FIX: direct Tailscale binds only the selected Self IPv4 address; `address` selects another local tailnet IP.
- `routes()` includes Tailscale addresses, with optional CLI-reported IPs for unnamed interfaces.
- `tailscaleState()` exposes validated `keyExpiry` and typed `Peer` diagnostics without throwing.

## 0.3.0

- `tailscaleState()` returns installation, backend, sign-in and address diagnostics without throwing; `tailscaleStatus()` keeps its existing behavior.
- Pure `needsSignin(status)` and `isPeer(status, ip)` helpers for raw Tailscale status JSON.
- `advertise({ addresses })` filters published A/AAAA records to the selected addresses, defaulting to `routes().lan`.

## 0.2.0

- React Native entry (`react-native` export condition): `browse({ type })` discovers computers on the local network over mDNS.

## 0.1.0

- The addresses a phone can dial the home computer on: Tailscale Serve with ownership checks, direct tailnet, LAN and mDNS advertising.
