# Machine store shared across apps

A person signs in once on a computer: the first app keeps the sign-in at the machine store (`machineStore`), and a second app, a separate process with its own name, is signed in already with no login of its own. An app that holds a different seal cannot read it, and an `Accounts` with no store refuses to keep a sign-in instead of losing it at restart. All against `mockOpenAI()` on loopback, under a throwaway HOME.

## Sub-features

- `machine-store-signin`: the first app signs in with a device code; the sealed file lands at `$HOME/.local/share/byokit/people/1/auth.json` (Linux).
- `machine-store-reuse`: a second app process with the same seal reads `signedIn(1, 'chatgpt') === true` and `status().state === 'ready'` without calling `login`.
- `machine-store-wrong-seal`: a third app process with another seal key gets a rejected read: an error, never a silent signed-out record.
- `store-required`: `new Accounts({ authBase })` with no `store` rejects `signedIn` with "Pass a store to keep sign-ins: ...".

## How to get to it (user POV)

- Each app constructs `new Accounts({ authBase, apiBase, store: (m) => machineStore(m, hostKeySeal({ key })) }, portable)`, with `machineStore` from `@byokit/accounts` and `hostKeySeal` from `@byokit/secrets` (apps on a real desktop share `osKeyringSeal({ service: 'byokit' })` instead; the drive never touches the OS keyring).

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md).

- **Write the consumer.** Create `"$scratch_dir/verify-machine-store.mjs"`. With no arguments it is the driver: make `home=$scratch_dir/home`, start `mockOpenAI()`, sign in member 1 with ChatGPT (`login` → `openai.approve(view.code)` → `finished`) as app "Crewhouse" with `process.env.HOME = home`, print whether the conventional file exists; then run itself twice with `execFileSync(process.execPath, [file, 'second'|'stranger'], { env: { ...process.env, HOME: home, KEY, BASE } })`: `second` uses the same 32-byte key and prints `signedIn` and `status().state` as app "Message desk"; `stranger` uses a fresh key and prints the rejected read's error name and message. Then print the store-required rejection. Close the stand-in at the end; exit 1 unless the four outcomes hold.
- **Run and capture.** `feature=accounts-machine-store; entry=@byokit/accounts; drive=(node "$scratch_dir/verify-machine-store.mjs")`, then run SKILL.md Evidence's capture block. Exit code `0`.
- **Happy path shows.** `first: signed in, file at .../.local/share/byokit/people/1/auth.json`; `second app: signedIn=true status=ready (no login)`.
- **Error case shows.** `stranger: <error name>: <message>` and `no store: Error: Pass a store to keep sign-ins: ...`.
- **Proof.** The captured artifact contains command output for the action and resulting state of every sub-feature above.

## Gotchas

- `machineStore` resolves the path from `os.homedir()`, so every process of the drive sets `HOME` to the scratch home; never run it against the real HOME.
- `packages/accounts/test/signin.test.ts` drives the same two-app journey through Pi's computer flow with a child process.
