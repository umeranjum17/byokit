# Cloud SSH box from a phone (app transport)

A person with only the phone app deploys onto any SSH box: the app passes its own SSH module as `transport` (exec, hostKey, optional write) and its secure store as `pins` to the portable `sshVm`/`sshHostKey` from `@byokit/cloud`, with no `node:*` import. `setup({ pick, confirmId, address })` lists the one box, adopts it under the 5.2a guards, installs it, and secures it over SSH: the pinned host key, a listener on the box's loopback and one forward through the transport (K-SSH-REACH, D-9: no tailnet, no public app port). The Node `@byokit/cloud/ssh` stays the default over the `ssh` binary.

## Sub-features

- `transport-bench`: `sh scripts/test.sh packages/cloud/test/journey-cloud.test.ts` (`a phone with only its own SSH module deploys onto any SSH box…`): unpinned setup fails at listing with no command sent; confirm pins; with no listener securing fails `state.failed` (retryable), a transport without `forward` fails `error.app`, then steps run to ready with `securing` carrying the route and one proof forward opened and closed; no Tailscale command runs; a changed key reads host-key-changed and exec rejects host-key.
- `transport-contract`: `sh scripts/test.sh packages/cloud/test/contract.test.ts`: the machine contract over `fakeSshTransport` from `@byokit/cloud/testing`.
- `transport-forward`: the same journey, after `securing`: a real `@byokit/pair` host listens on the fake machine's loopback port, and a `DeviceLink` pairs and requests through `sshResolve()` over `fakeSshTransport().forward`; one forward is shared, reused, reopened after `close()`, and a wrong pin reads `host-key`.
- `transport-live`: `capture/cloud-ssh-transport.mjs` on a real VM, below.

## Live run (KVM VM)

Needs `/dev/kvm`, docker with a qemu image, the Ubuntu 24.04 cloud image checked against Ubuntu's SHA256SUMS, `ssh2` installed in a scratch folder, and the sha256 of the pinned Node x64 tarball from nodejs.org SHASUMS256.txt. `feature=cloud-ssh-transport; entry=@byokit/cloud; drive=(env WORK=<scratch with noble.img> IMAGE=<qemu image> SSH2_DIR=<scratch> NODE_SHA_X64=<sha> node .agents/skills/done-done-verify-byokit/capture/cloud-ssh-transport.mjs)`, then SKILL.md Evidence's capture block. The VM and its container are always removed.

Pass: `console-ed25519` equals the `sshHostKey` fingerprint; a `steps-round` ends `checking-access, listing, inspecting, installing, securing, ready` (an earlier round may end `failed:securing:state.failed:true` while the host starts); `securing-route` is pinned; `host-answer-through-forward` is the recipe's reply through the ssh2 `forwardOut` forward; `tailscale-on-box: none`; `wrong-pin` reads `host-key-changed` and `host-key`, and `wrong-pin-securing` is `failed:securing:state.host-key-changed`; `node-default` pins the same key and reads `on`; `result: PASS`. First passed 2026-10-19; with SSH securing 2026-10-23.

## Live forward run (KVM VM, no Tailscale)

Same VM setup, without `ssh2` (the system `ssh` binary and a key file). `feature=cloud-ssh-transport; entry=@byokit/cloud/ssh; drive=(env WORK=<scratch with noble.img> IMAGE=<qemu image> NODE_SHA_X64=<sha> node .agents/skills/done-done-verify-byokit/capture/cloud-ssh-forward.mjs)`, then SKILL.md Evidence's capture block.

Pass: `host-key` matches `console-ed25519`; `steps` are `checking-access, listing, inspecting, installing, ready` (no tailnet); `resolved` rewrites the loopback address to a local port; `host-answer-through-forward` is the recipe's reply; `listeners-7300` is `127.0.0.1:7300` only; `tailscale-on-box` is `none` and `inactive`; `reopened` is a new port after `close()`; `wrong-pin` reads `host-key`; `result: PASS`. First passed 2026-10-23.

## Gotchas

- Hetzner on a phone composes this transport with the portable Hetzner API once that lane lands; not covered here.
