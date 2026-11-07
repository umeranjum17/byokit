# Automatic host key at login umask 0002

Built `@byokit/secrets`: `hostKeyFileSeal({ service, stateDir })` stores its key under the platform state root. On Ubuntu's default login (umask 0002) `mkdir -p` leaves that root group-writable, which used to stop the engine with `Automatic host key requires owner-only files and directories`. Fakes and a scratch folder only; never `~/.local`.

## Sub-features

- An empty, owned, group-writable (775) state root is tightened to 0700 with a one-line stderr notice; the key file lands 0600 and decrypts after a second `hostKeyFileSeal` on the same folder.
- A group-writable root that already holds another file (0770 or 0775), and a world-writable root, are still refused with the same error and left unchanged.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md).

- In a private scratch folder, run `"$scratch_dir/verify-secrets-umask.mjs"` under `umask 0002` (set in the shell, then confirm with `umask`), importing the built `@byokit/secrets`. Create `"$scratch_dir/state"` with `mkdir`, print `stat -c %a`, call `hostKeyFileSeal`, then print the root and key modes (`700`, `600`) and round-trip a canary string. Then put a file in a second 775 root and show the refusal and that its mode is still 775.
- `feature=secrets-host-key-umask; entry=@byokit/secrets; drive=(node "$scratch_dir/verify-secrets-umask.mjs")`, then SKILL.md Evidence capture; `leak_check` the canary (exit 0).
