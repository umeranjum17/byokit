# Discover: firewall verdict and pair reachability self-check

Setup checks a port before printing its pairing tick: `firewall({ port })` from `@byokit/discover` says whether
the computer's own firewall would stop the phone (`true`, `false`, or the honest `'unknown'` when nothing is
readable without administrator access), and `check(urls)` from `@byokit/pair` probes the offer's addresses without
spending the one-time ticket, so a checked offer still pairs afterwards and the phone re-checks before consent.

## Sub-features

- `firewall-live`: on this machine the verdict is `'unknown'` with `how` naming the refused readers, and
  `nextStep` in plain words with no sudo command.
- `firewall-stubbed`: stubbed UFW output with a deny rule for the port reads `blocked: true`; stubbed
  macOS output with the firewall off reads `blocked: false`.
- `probe-then-pair`: `check([url])` against a real loopback host returns `ok: true` twice, the host was never
  asked, and `pairWithOffer` with the same offer text then pairs with exactly one approval.
- `dead-address`: `check` against a closed port returns `ok: false` with code `unreachable` and its sentence.
- `bad-port`: `firewall({ port: 0 })` rejects with the real `port must be 1-65535` error.

## How to get to it (user POV)

- Setup runs `firewall({ port })` after `reach({ port })`, and `check(urls)` on the offer's own URLs before the
  tick (QR) is printed; the phone runs `check(parseOffer(scanned).urls)` again before asking for consent.
- A `blocked: true` verdict names the refusing rule; `'unknown'` means check another way, never proceed as if clear.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md), plus the built `@byokit/discover` and `@byokit/pair`.

- **Write the consumer.** `"$scratch_dir/verify-discover-firewall-check.mjs"` imports `firewall` from
  `@byokit/discover` and `Host`, `keyPair`, `check`, `pairWithOffer` from `@byokit/pair` (plus `node:http` and
  `ws` for the loopback host, as the pair tests do). It opens a `Host` on `ws://127.0.0.1:<ephemeral>/link`
  whose `confirm` counts approvals, makes `host.offer({ role: 'control', urls: [url] })`, prints `check([url])`
  twice, pairs with `pairWithOffer(text, { name: 'Umer phone', onWords: () => {} })`, and prints the grant name
  with the approval count. It then prints the live `firewall({ port })` verdict, the two stubbed verdicts, the
  dead-address result, and the caught bad-port error.
- **Run and capture.** `feature=discover-firewall-check; entry=@byokit/discover; drive=(node "$scratch_dir/verify-discover-firewall-check.mjs")`,
  then run SKILL.md Evidence's capture block. Exit code `0`.
- **Probed then paired.** Both probes `ok: true`, `paired: Umer phone`, `approvals: 1`.
- **The dead-address and bad-port legs are the error cases**: they show the real `unreachable` result with its
  sentence and the real `port must be 1-65535` rejection.

## Gotchas

- Import only the public entries; never `packages/*/src`.
- The consumer runs with cwd inside the worktree (`$scratch_dir`) so bare `@byokit/*` and `ws` resolve.
- Close the host and the HTTP server before exit.
