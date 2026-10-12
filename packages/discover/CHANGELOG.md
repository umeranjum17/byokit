# Changelog

## Unreleased

## 0.8.0 (2026-10-12)

- ADD: `firewall({ port, platform?, run?, timeoutMs? })` reports whether the local firewall would block inbound on a port as `{ blocked: true|false|'unknown', how, nextStep }`, reading only what a normal user may read (UFW, nftables, iptables on Linux; the application firewall on macOS; Windows Firewall via netsh) and never asking for administrator access. Anything unreadable is an honest `'unknown'` with a plain next step. Documented under "Reachability and firewall" in the README, which also points setup and phone callers at `@byokit/pair`'s `check()` for the probe that leaves the one-time offer usable.

## 0.7.0 (2026-10-11)

- Expo config plugin (`./app.plugin.js`): `["@byokit/discover", { services: ["_byokit._tcp"], localNetwork? }]` writes `NSBonjourServices` and `NSLocalNetworkUsageDescription` into iOS `Info.plist` so `browse()` finds the computer; a missing or empty `services` list fails prebuild by name. Android needs no plugin (`react-native-zeroconf`'s manifest merges `CHANGE_WIFI_MULTICAST_STATE`).
- `@byokit/reach` is now published as `@byokit/discover`, with the same API (`reach()`, `routes()`, `advertise()`, `browse()`, the `./react-native` entry and the `react-native` export condition) and the same `ByokitReach` native module; its earlier versions are the `@byokit/reach` releases below. **Deprecated:** the `@byokit/reach` name; it stays published as a shim that re-exports this package through 0.7.x and is removed in 0.8.0.
- Dependency update: depend on `@byokit/ui` instead of its deprecated `@byokit/ui-core` shim.

## 0.6.0 (2026-10-01)

- Dependency update: pins @byokit/ui-core 0.6.0.

- `directRoutes()` combines explicit loopback, tailnet and LAN listener scopes with typed hosts and ordered dial URLs.
- Node and React Native share `nativeAddresses()`, `routeOf()`, `observe()` and bounded `probe()` observations; native readers are injectable and home evidence uses actual prefixes.
- Explicit `@byokit/reach/react-native` entry alongside the existing export condition.
- `phoneNetwork()` exposes Android active Wi-Fi/cellular/VPN capabilities and iOS transport evidence with unknown VPN state; bundled Expo readers also supply actual IPv4 interface prefixes.

## 0.5.0 (2026-10-01)

- Dependency update: pins @byokit/ui-core 0.5.0.

- `recommend()`: one entry per route (`{ via, recommended, sentence, needs, disabledReason? }`), recommended
  first — current healthy route, then Tailscale Serve (direct when the Serve root is taken, disabled, funnelled,
  or nameless), then a private overlay, then Same Wi-Fi. Words from ui-core's `routeChoices()`; probes
  `tailscaleState`/`inspectServe`/`routes()` live unless `state`, `serve`, `lan` and `private` fakes are passed.

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
