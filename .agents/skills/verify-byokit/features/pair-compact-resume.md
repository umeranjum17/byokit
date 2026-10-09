# Pair: compact QR crash-resume against a pinned computer

A phone that scans a compact pairing QR (`Host.compactOffer`) and is killed while the person at the computer decides
comes back online from the pending grant it kept, pinned to the computer that held the code; another computer
answering at the same address is refused; a version 1 QR resumes the same way; the compact QR stays terminal-sized.

## Sub-features

- `pending-pinned`: `pairWithOffer(text, { onPending })` hands over the pending grant before the computer can approve:
  for a compact QR after the code handshake authenticated the computer's key, before the phone's identity goes out.
- `kill-resume`: the phone process is SIGKILLed during the approval prompt, the person says yes, and a new process's
  `DeviceLink` from the kept grant goes `online` and gets an answer; the kept grant loses `pendingUntil`.
- `impostor-refused`: another computer (other key) answering at the same address leaves the resumed link `refused`
  and the kept grant unchanged.
- `token-size`: the compact token for the name `Umer` and one `linkUrl(relay, hostId(key))` on a loopback IPv4 relay
  is 109 characters, QR version 5: 21 half-block rows with `@byokit/ui` `qrText` (border 2), 23 with a 4-module border.

## How to get to it (user POV)

- The computer shows `host.compactOffer({ role, urls }).text` as a QR (`qrText` from `@byokit/ui` in a terminal).
- The phone app runs `pairWithOffer(text, { name, onWords, onPending: (g) => secureStore.save(g) })`; after a restart
  it makes `new DeviceLink(savedGrant, { store })`.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md), plus the built `@byokit/pair`, `@byokit/relay` and `@byokit/ui`.

- **Write the consumer.** `"$scratch_dir/verify-pair-compact-resume.mjs"` imports `Host`, `keyPair`, `hostId` from
  `@byokit/pair`, `linkUrl` from `@byokit/relay` and `qrText` from `@byokit/ui`. For each of `compact` and `v1`, it
  opens a loopback host whose `confirm` waits, serves it on one `ws://127.0.0.1:<port>/link` address it can switch to
  another host, and spawns the phone as a child `node --input-type=module -e` process (cwd `$scratch_dir`) running
  `pairWithOffer` with `onPending` writing the grant file. When `confirm` opens it SIGKILLs the child, approves, then
  spawns a resume child (`DeviceLink` from the file) first against an impostor host and then against the real one,
  printing each status, the answer and the kept grant's `host`/`pendingUntil`. It then prints the measured token and
  `qrText` for the `token-size` case.
- **Run and capture.** `feature=pair-compact-resume; entry=@byokit/pair; drive=(node "$scratch_dir/verify-pair-compact-resume.mjs")`,
  then run SKILL.md Evidence's capture block. Exit code `0`.
- **Pinned and resumed.** Per offer kind: `pending host = computer key: true`, `impostor: refused`, `grant unchanged:
  true`, `resumed: online`, an answer, `pendingUntil: undefined`.
- **The impostor leg is the error case**: it shows the real `refused` status from a computer with another key.

## Gotchas

- Import only the public entries; never `packages/pair/src`.
- Children resolve `@byokit/*` from their cwd: run them with cwd inside the worktree (`$scratch_dir`).
- Close both hosts and the HTTP server before exit; the children exit on their own after `stop()`.
