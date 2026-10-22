# Discover: a LAN route binds its own addresses, never a wildcard

Setup asks `@byokit/discover` for the addresses a phone can dial, then listens where it says. A LAN or
overlay route must open the pairing server only on the addresses it offered the phone: a wildcard bind
would expose it on every interface of the computer, including the ones the phone was never offered.

## Sub-features

- `lan-bind-list`: `reach({ via: 'lan' })` returns a `bind` list with one entry per classified LAN
  address, and every dial URL names an address in that list.
- `no-wildcard`: binding the addresses `bind` names leaves the port closed on the other interfaces — a
  loopback connect to the same port is refused, and the same port can still be taken on loopback.
- `overlay-bind-list`: `reach({ via: 'private' })` names the overlay addresses, never a wildcard.
- `direct-and-serve-unchanged`: direct Tailscale binds the selected tailnet IP, Serve binds loopback.

## How to get to it (user POV)

- Setup runs `reach({ port, via: 'lan' })`, starts one listener per `bind` address, and puts the `urls`
  in the pairing offer; the phone dials one of those addresses.
- Nothing else on this computer can reach that port: the Docker bridge, the VPN and the loopback
  address stay closed, so a pairing server is not exposed to the whole network.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md), plus the built `@byokit/discover`.

- **Write the consumer.** `"$scratch_dir/verify-discover-lan-bind.mjs"` imports `reach` and `routes` from
  `@byokit/discover` (plus `node:http`). It reads this computer's own addresses with `routes()`, then calls
  `reach({ port, via: 'lan' })` and prints the `bind` list and the `urls`; it fails when the list is empty,
  holds `0.0.0.0`, or does not cover the host of every URL. It then starts one `node:http` server per
  `bind` address on one free port, connects to each of those addresses over HTTP (expect `204`), and
  connects to `127.0.0.1` on the same port (expect the connection to be refused) — then takes that port on
  loopback to show the wildcard never held it. It closes every server it started. The error case comes
  last: `reach({ port, via: 'lan', interfaces: {} })` must reject with the real `no LAN address` message,
  which it prints.
- **Run and capture.** `feature=discover-lan-bind; entry=@byokit/discover; drive=(node "$scratch_dir/verify-discover-lan-bind.mjs")`,
  then run SKILL.md Evidence's capture block. Exit code `0`.
- **The refused leg is the proof:** the port answers on the addresses the phone was offered and nowhere else.

## Gotchas

- Import only `@byokit/discover`; never `packages/discover/src`.
- The run needs one real LAN address on this computer; the consumer prints the addresses it used.
- Never bind a wildcard in the consumer: the point of the run is that the kit does not ask for one.
- Non-visual change: no screenshots. Local interfaces only; no account, no provider, no egress.
