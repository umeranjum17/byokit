---
name: verify-byokit
description: Drive the built byokit SDK the way a consumer app does — build the workspace, doctor the built artifacts, run real Node consumers against the built packages, capture evidence. Use for any proof of byokit behavior on this host, before claiming a feature works.
---

# Verify byokit

byokit is a TypeScript SDK monorepo: the user is a consumer app importing `@byokit/*`. "Driving the app" means importing the **built** packages (`packages/*/dist`) from a plain Node script and observing real output. The browser (PWA), React Native and Android surfaces are separate entries; see the feature map for what is provable on this host.

## Launch (build)

There is no server. Launch = build the SDK once, then run each drive as a short-lived script.

```sh
npm ci --no-audit --no-fund   # only in a fresh worktree; deps are not inherited
npm run build                 # tsc -b every package; exits non-zero on any error
```

Ready when the command exits 0 and `packages/accounts/dist/index.js` exists. Builds and full test runs are heavy: run them one at a time, holding any machine lock your environment provides (e.g. a shared `heavy-jobs.lock`).

## Doctor

One read-only check that the built SDK is worth driving (from the worktree root):

```sh
node --input-type=module -e "
import { createRequire } from 'node:module';
const require = createRequire(process.cwd() + '/');
const pkg = require('./packages/accounts/package.json');
const acc = await import('@byokit/accounts');
const testing = await import('@byokit/accounts/testing');
if (!acc.Accounts || !acc.portable || typeof testing.mockOpenAI !== 'function') throw new Error('built entry incomplete');
console.log('doctor ok:', pkg.name, pkg.version, 'resolves', require.resolve('@byokit/accounts'));
"
```

It prints the exact version and the resolved file — that path must be inside `packages/*/dist`, never a registry copy. If it fails, rebuild before driving.

## Drive

Use Bash from the worktree root for the recipe and capture commands. Create an exclusive scratch directory for each run (so bare `@byokit/*` imports resolve to the workspace):

```bash
scratch_dir=$(mktemp -d ./scratch.verify-byokit.XXXXXX) || exit 1
```

Write each consumer inside "$scratch_dir"; keep that variable in the same shell through capture and cleanup. Every drive:

- imports only public package entries (`@byokit/accounts`, `@byokit/accounts/testing`, …), never `packages/*/src` paths;
- uses the repo's own stand-ins — `mockOpenAI()` from `@byokit/accounts/testing` answers on loopback (127.0.0.1, ephemeral port); no account, no real provider, no egress;
- covers the representative journey **and** at least one error/missing case, catching and printing the real typed error (e.g. `ResponseError`, not-offered) instead of avoiding it;
- closes what it started (`await openai.close()`).

Exact recipes: `features/README.md` is the index; one file per feature.

## Review evidence (a user-visible change)

A change a person can see is proved by `capture/review-evidence.ts`, not by hand. The skill owns the capture: run the script, name the files it wrote. A hand-captured screenshot is a failure, not a fallback; when the script cannot reach one of the required proofs, extend the script (or the screen's row in it) in the same change, or record the gap as a follow-up task naming it exactly — never skip it silently.

```bash
feature=review-evidence; entry=capture/review-evidence.ts
drive=(node .agents/skills/verify-byokit/capture/review-evidence.ts --base origin/main --slug <pr-or-branch>)
```

It drives the real example app in a real browser (Playwright's Chromium, else the system's; `mockOpenAI()` on loopback) and writes one stable folder, `.verify-artifacts/review/<slug>/`:

- `<screen>/before__<theme>__<form>.png` and `<screen>/after__<theme>__<form>.png` — the screen before and after the change, in **every theme the app has** (light, dark) and **every form factor it has** (phone width, desktop width);
- `<screen>/motion__<interaction>__<theme>__<form>.webm` — one motion recording per changed interaction, recorded from the running app;
- `manifest.json` — the base ref, every file written, and every skip with the reason it was skipped.

`before` is the screen as the `--base` ref has it (the example app of that ref, served from its own copy); a screen that ships its own before route (`usage.html?before`) uses that instead, so the pair compares on one ledger. A theme, form factor or screen the app does not have is written down in `manifest.json` with its reason — that is the only way to skip one. The script closes the browser, both servers and the stand-in, and removes its own scratch; the evidence folder survives. Wrap the run in the Evidence capture block below (it is a heavy job: hold the machine's heavy-job lock). Recipe and what the app really has: `features/pwa-review-evidence.md`.

## Evidence

Every proof writes to an exclusive run directory under `.verify-artifacts/<feature>/` in the worktree root. The feature recipe sets `feature`, `entry` and the Bash `drive` array; then run this capture block in the same shell:

```bash
mkdir -p ".verify-artifacts/$feature" || exit 1
evidence_dir=$(mktemp -d ".verify-artifacts/$feature/run.XXXXXX") || exit 1
if (
  printf 'FEATURE=%s\nENTRY=%s\nCOMMAND=' "$feature" "$entry"
  printf '%q ' "${drive[@]}"
  printf '\n'
  if "${drive[@]}"; then status=0; else status=$?; fi
  printf '\nEXIT=%s\n' "$status"
  exit "$status"
) > "$evidence_dir/drive.txt" 2>&1; then
  drive_status=0
else
  drive_status=$?
fi
cat "$evidence_dir/drive.txt"
printf 'Evidence: %s/drive.txt\n' "$evidence_dir"
test "$drive_status" -eq 0
```

The artifact contains the invoked command, stdout, stderr and the consumer's actual exit code; a failed command also fails the final status check. `.verify-artifacts/` is gitignored: evidence is private, never committed, never attached to a public PR. Proof media — screenshots, screen recordings, emulator captures — is written outside the repository (never under `.lab/` or any other worktree path) and a public repository's PR links a private evidence page instead of committing or attaching it.

Proof standard: drive the real consumer path against the built SDK; capture the action and resulting output, not a summary; the error case must show the actual typed error and message.

### Credential-touching proof

When a proof handles a real key, token or sign-in, read the value into a variable and print only a mask: at 16 or more characters, length plus the first 4 and last 4 characters; below 16 characters, only the length and the first 8 hex characters of its sha256, never any characters of the value. Never `cat`, `grep -r`, `rg` or `secret-tool search` a credential store; never snapshot or screenshot a revealed value (DOM, accessibility tree, pixels); never let the value reach argv (the capture block prints argv) or any log.

```bash
v=$(secret-tool lookup service byokit account demo) # any read of the real value, into a variable
if [ "${#v}" -lt 16 ]; then
printf 'sha256:%s (%d chars)\n' "$(printf '%s' "$v" | sha256sum | cut -c1-8)" "${#v}"
else
printf '%s...%s (%d chars)\n' "${v:0:4}" "${v: -4}" "${#v}"
fi
if [ -n "$v" ] && grep -rqF -f <(printf '%s' "$v") ".verify-artifacts/$feature/"; then
printf 'LEAK: credential value found in evidence\n' >&2; exit 1
fi
unset v
```

```js
import { createHash } from 'node:crypto';
const v = process.env.BYOKIT_KEY ?? ''; // read once, into a variable
const mask = v.length < 16
? `sha256:${createHash('sha256').update(v).digest('hex').slice(0, 8)} (${v.length} chars)`
: `${v.slice(0, 4)}...${v.slice(-4)} (${v.length} chars)`;
console.log(mask);
```

Prefer a synthetic canary over a real value. Before the run ends run the same leak check — `grep -rqF -f <(printf '%s' "$v") ".verify-artifacts/$feature/"`, fired only when `[ -n "$v" ]` — and require exit 1; the value reaches grep on stdin, never argv.

## Cleanup

```bash
rm -rf -- "$scratch_dir"
test -f "$evidence_dir/drive.txt"
```

Remove only the exclusive scratch dir returned by this run’s `mktemp`; mock servers are closed by the drive itself. Cleanup never touches `.verify-artifacts/` — after cleanup, confirm the evidence files still exist at the named location; a cleanup that eats the proof fails the run.

## Floor (always enforced)

From `constraint-driven-development`, applies to this skill and every change verified through it:

- No new suppression comments: `@ts-ignore`, `eslint-disable`, `# noqa`, `# type: ignore`.
- No unimplemented stubs: `throw new Error("Not implemented")`, empty `catch {}`.
- No skipped tests without a reason in the commit message.
- No secrets in source.
- Credential values never appear in evidence: grep the evidence folder for the value (`grep -rqF -f <(printf '%s' "$v") ".verify-artifacts/$feature/"`, fired only when `[ -n "$v" ]`) before the run ends and require exit 1; the pattern reaches grep on stdin, never argv.
- Deliberate test deletion (a test diet) is allowed only when BOTH hold: the commit message names the test-diet task, and the removed journey remains covered by an existing integration/e2e test. A deletion failing either condition is rejected. This is the only Floor rule that may permit a deletion: skips, stripped assertions, suppression comments, secrets and the security/crypto/data-loss guards are never loosened for any change.
- This Floor and this skill's proof bar are never weakened to make a change pass: a declared-unavailable surface stays unavailable until it is really driven.

## Helpers

Review-evidence helper: `capture/review-evidence.ts`, the capture above (add a screen by adding a row to its `SCREENS` table, with its real themes, form factors and before route — never a hand-written capture path).

Other maintained captures and scratch-consumer recipes are indexed in [the feature map](features/README.md).
Use the feature file's drive command; write a scratch consumer only when that recipe calls for one.
