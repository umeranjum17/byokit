# Hetzner from the phone alone, and the one console line (G8, K-DIRECT)

The portable `hetznerApi()` from `@byokit/cloud` (React Native safe) creates, reads and deletes a Hetzner
server over HTTPS alone; `firstBoot: { recipe, phoneKey }` puts the whole 8.3 install plus the owner
phone key into cloud-init `user_data`, so the phone never runs a command on the machine. Without
`publicKey` the dedicated firewall lets nothing in. `setupCommand()` is the same install as one line
for a person's own terminal or any provider console, ending with the pinned `byokit-ready <name>`
line or `byokit-failed <name> <step>` and exit 1.

## Drive (real cloud-init on real VMs, no Hetzner account)

`capture/cloud-firstboot.mjs` runs the built package. The Hetzner API is the loopback bench
(`startFakeHetznerServer()`); each machine is a real KVM VM booted from the Ubuntu 24.04 cloud image
with real cloud-init and a NoCloud seed, the way a Hetzner server boots. The driver never runs a
command inside a VM; it reads only the serial console.

Prerequisites (heavy: use the memory gate; keep the image and disks outside the work copy):

```bash
work=~/.cache/fm-scratch/<task-id>; mkdir -p "$work/image"
curl -fsSL -o "$work/noble.img" https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img
curl -fsSL https://cloud-images.ubuntu.com/noble/current/SHA256SUMS | grep 'noble-server-cloudimg-amd64.img$' | awk '{print $1"  noble.img"}' | (cd "$work" && sha256sum -c)
printf 'FROM ubuntu:24.04\nRUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends qemu-system-x86 qemu-utils genisoimage && rm -rf /var/lib/apt/lists/*\n' > "$work/image/Dockerfile"
docker build -q -t byk-cloud-qemu:1 "$work/image"
v=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | grep 'linux-x64.tar.xz$')
```

`/dev/kvm` must be readable and writable by the user; the container gets only `--device /dev/kvm`
(not privileged) and runs as the user. Then, from the worktree root:

```bash
feature=cloud-hetzner-firstboot; entry=capture/cloud-firstboot.mjs
drive=(env WORK="$work" IMAGE=byk-cloud-qemu:1 NODE_SHA_X64="${v%% *}" NODE_VERSION="$(echo "$v" | sed 's/.*node-v\([0-9.]*\)-linux.*/\1/')" node .agents/skills/done-done-verify-byokit/capture/cloud-firstboot.mjs)
```

Capture with the Evidence block in SKILL.md. PASS needs, in `drive.txt`:

- `firewall-rules: []` and `phone-exec: unsupported: …` (no SSH, nothing inbound);
- VM 1 (the exact `user_data` the kit sent): `byokit-ready runner bound <phone key>`, the host's outbox
  line written from the delivered `phone.bin`, then `removed` with no server, IP or firewall left;
- VM 2: the console line as root twice (`byokit-ready direct bound …` both times, `check root-unit
  active root:600`), as a logged-in non-root user (`byokit-ready desk bound …`, `check desk-unit active
  user:600`), and a bad node checksum (`byokit-failed broken node`, `check broken-exit 1`);
- `result: PASS`.

Not proven here: Hetzner's own API, images and billing (the live token-gated run in
[cloud-hetzner.md](cloud-hetzner.md) covers the API with SSH), and arm64 servers. Delete `$work` when done.
