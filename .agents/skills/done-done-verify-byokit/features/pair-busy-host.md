# Pair: a busy computer keeps its phone link; a silent one is dropped

A computer whose event loop stalls answers each ping late. The phone counts any pong
up to its latest ping, and any answer to its own requests or streams, as hearing the
computer, so it stays online. A computer that goes silent is still dropped after two
silent ping rounds. Host events alone never keep a link up: they show the computer
can talk, not that it hears the phone.

## Sub-features

- `busy`: every host frame arrives 1.5 × `pingMs` late; the link stays `online` for ten
  rounds and a request sent during the stall is answered.
- `silent`: host frames stop; the link goes `offline` within `3 × pingMs` (two silent
  rounds plus one tick) plus slack.

## How to get to it (user POV)

- muxr's phone keeps showing the computer as connected while a loaded machine answers
  slowly, and shows it offline once the computer really stops answering.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md), plus the built `@byokit/pair`.

- **Write the consumer.** `"$scratch_dir/verify-pair-busy-host.mjs"` imports `Host`,
  `DeviceLink`, `keyPair`, `pairWithOffer` from `@byokit/pair` and `WebSocket`,
  `WebSocketServer` from `ws`. It opens a real loopback host, and serves a second
  loopback address that forwards each phone frame to the host at once and each host
  frame back after a set delay (or never, once silent). It pairs through that address,
  opens a `DeviceLink` with `pingMs: 400`, waits for `online`, then sets the delay to
  600 ms, sends one request, and waits for ten phone frames or the first `offline`;
  then it drops every host frame and times the `offline`. It prints each status,
  the request's answer and both timings, and exits non-zero unless the busy leg never
  went offline and the silent leg dropped within 1400 ms.
- **Run and capture.** `feature=pair-busy-host; entry=@byokit/pair; drive=(node "$scratch_dir/verify-pair-busy-host.mjs")`,
  then run SKILL.md Evidence's capture block. Exit code `0`.
- **The silent leg is the error case**: it shows the real `offline` status and how
  long the drop took.

## Gotchas

- Import only the public entries; never `packages/pair/src`.
- Wait on conditions (frames forwarded, status), never fixed sleeps; a loaded host
  shifts ping timing.
- Close the link, both servers and the host before exit.
