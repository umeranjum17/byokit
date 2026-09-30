# Changelog

## Unreleased

- Public offer helpers and a checksummed offline offer envelope, browser pairing guidance and a PWA pairing page.

## 0.4.0

- Export `parseOffer`, `cleanName`, `offerText`, `encodeOffer` and `decodeOffer`.
- Add browser pairing and short-lived peer invitation recipes, with a view-only PWA example.

## 0.3.2 (2026-09-29)

- FIX: a phone app coming back from the background, or a hidden browser tab, no longer drops
  a healthy link. A ping check that runs late because the device's own timers were frozen now
  counts the silence from when it runs instead of mistaking it for a quiet host; a host that
  is really silent still drops after missing the pings that follow.

## 0.3.1

- SECURITY: Node hostKeyFile/device store wrote the device secret through a predictable temp path that followed symlinks; now a random O_EXCL 0600 temp file

- React Native `secureDeviceStore` keeps device grants in platform secure storage.
- Browser `browserDeviceStore` seals grants in IndexedDB, orders saves with clears across tabs when Web Locks are available, and blocks saves of the last forgotten device ID.
- Node/Electron `fileDeviceStore` persists grants in a private file, optionally sealed by Electron safeStorage.
