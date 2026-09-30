# Changelog

## Unreleased

## 0.3.0

- `tailscaleState()` returns installation, backend, sign-in and address diagnostics without throwing; `tailscaleStatus()` keeps its existing behavior.
- Pure `needsSignin(status)` and `isPeer(status, ip)` helpers for raw Tailscale status JSON.
- `advertise({ addresses })` filters published A/AAAA records to the selected addresses, defaulting to `routes().lan`.

## 0.2.0

- React Native entry (`react-native` export condition): `browse({ type })` discovers computers on the local network over mDNS.

## 0.1.0

- The addresses a phone can dial the home computer on: Tailscale Serve with ownership checks, direct tailnet, LAN and mDNS advertising.
