# Cloud SSH box from a phone (app transport)

A person with only the phone app deploys onto any SSH box: the app passes its own SSH module as `transport` (exec, hostKey, optional write) and its secure store as `pins` to the portable `sshVm`/`sshHostKey` from `@byokit/cloud`, with no `node:*` import. `setup({ pick, confirmId, address })` lists the one box, adopts it under the 5.2a guards, installs and secures it with the keyless tailnet join, which now runs on every adapter (K-PUBLIC, D-9: no public app port). The Node `@byokit/cloud/ssh` stays the default over the `ssh` binary.

## Sub-features

- `transport-bench`: `sh scripts/test.sh packages/cloud/test/journey-cloud.test.ts` (`a phone with only its own SSH module deploys onto any SSH box…`): unpinned setup fails at listing with no command sent; confirm pins; steps run to ready with the private serve; a join key is never sent; a changed key reads host-key-changed and exec rejects host-key.
- `transport-contract`: `sh scripts/test.sh packages/cloud/test/contract.test.ts`: the machine contract over `fakeSshTransport` from `@byokit/cloud/testing`.
- `late-link`: the deadlines table in `journey-cloud.test.ts` (`NeedsLogin` / `status`): a sign-in link that shows only in status after `up` returns is still shown once, with a fresh 5-minute window.
- `transport-live`: `capture/cloud-ssh-transport.mjs` on a real VM, below.

## Live run (KVM VM)

Needs `/dev/kvm`, docker with a qemu image, the Ubuntu 24.04 cloud image checked against Ubuntu's SHA256SUMS, `ssh2` installed in a scratch folder, and the sha256 of the pinned Node x64 tarball from nodejs.org SHASUMS256.txt. `feature=cloud-ssh-transport; entry=@byokit/cloud; drive=(env WORK=<scratch with noble.img> IMAGE=<qemu image> SSH2_DIR=<scratch> NODE_SHA_X64=<sha> node .agents/skills/done-done-verify-byokit/capture/cloud-ssh-transport.mjs)`, then SKILL.md Evidence's capture block. The VM and its container are always removed.

Pass: `console-ed25519` equals the `sshHostKey` fingerprint; `steps` reach `installing` then `open-page` (link masked); `host-answer` is the recipe's reply; `tailnet: needs-login`; `tailscale-version` is the pinned one; `join-key: unsupported` with no command sent; `wrong-pin` reads `host-key-changed` and `host-key`; `node-default` pins the same key and reads `on`; `result: PASS`. First passed 2026-10-19.

## Gotchas

- `joined` and the serve on a live tailnet are not reached: that needs a person to sign the box in. The driver never opens the link and masks it in every printed line.
- Hetzner on a phone composes this transport with the portable Hetzner API once that lane lands; not covered here.
