# Pair: link problem codes tell "can't reach" apart from "computer is slow"

A phone that cannot pair or probe tells the person which of two problems they have:
a socket that never opens within the timeout reports `unreachable` (same network or
firewall, with that next step in its sentence), while an open socket with no answer
reports `slow` (wait a moment and try again). Pairing setup (`check()`) and the dial
behind `pairWithCode` / `pairWithOffer` return the same two codes.

## Sub-features

- `unreachable`: dial or probe whose socket never opens (closed port, wrong network,
  firewall) fails as `unreachable`, unsealed, with the same-network-or-firewall sentence.
- `slow`: dial or probe whose socket opens but stays silent fails as `slow`, unsealed,
  with the wait-and-retry sentence.
- `pair-journey`: a typed short code against a real loopback host still pairs.

## How to get to it (user POV)

- The phone shows "Can't reach your computer. Check the phone and computer are on the
  same network, and that no firewall is blocking the connection." when the computer
  cannot be reached, and "Your computer is slow to answer. Wait a moment and try
  again." when the computer is slow to answer.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md), plus the built `@byokit/pair`.

- **Write the consumer.** `"$scratch_dir/verify-pair-link-codes.mjs"` imports `Host`,
  `keyPair`, `pairWithCode`, `check`, `LINK_WORDS` from `@byokit/pair` and
  `WebSocketServer` from `ws`. It opens a real loopback host that approves pairing,
  serves it on one `ws://127.0.0.1:<port>/link` address, and also serves a silent
  address (accepts the upgrade, never answers) plus a closed-port URL. It pairs a
  typed short code (journey leg), then pairs against the closed port (expecting
  `unreachable`, unsealed, `LINK_WORDS.unreachable`) and the silent address
  (expecting `slow`, unsealed, `LINK_WORDS.slow`), then runs `check()` over all three
  URLs (expecting `ok`, `unreachable`, `slow`). Every leg prints the real code and
  sentence; any mismatch exits non-zero.
- **Run and capture.** `feature=pair-link-codes; entry=@byokit/pair; drive=(node "$scratch_dir/verify-pair-link-codes.mjs")`,
  then run SKILL.md Evidence's capture block. Exit code `0`.
- **The two error legs are the error cases**: they show the actual typed codes and
  sentences, never a paraphrase.

## Gotchas

- Import only the public entries; never `packages/pair/src`.
- Close the silent server, the host address and the host before exit.
