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

Scratch consumers live in `scratch/` inside the worktree (so bare `@byokit/*` imports resolve to the workspace), one file per feature, written fresh per run. Every drive:

- imports only public package entries (`@byokit/accounts`, `@byokit/accounts/testing`, …), never `packages/*/src` paths;
- uses the repo's own stand-ins — `mockOpenAI()` from `@byokit/accounts/testing` answers on loopback (127.0.0.1, ephemeral port); no account, no real provider, no egress;
- covers the representative journey **and** at least one error/missing case, catching and printing the real typed error (e.g. `ResponseError`, not-offered) instead of avoiding it;
- closes what it started (`await openai.close()`).

Exact recipes: `features/README.md` is the index; one file per feature.

## Evidence

Every proof writes to `.verify-artifacts/<feature>/` in the worktree root: the command line, stdout, stderr and exit code (e.g. `script -qec` or `... 2>&1 | tee`). State the feature ID and entry point inside the artifact. `.verify-artifacts/` is gitignored: evidence is private, never committed, never attached to a public PR.

Proof standard: drive the real consumer path against the built SDK; capture the action and resulting output, not a summary; the error case must show the actual typed error and message.

## Cleanup

```sh
rm -rf scratch/
```

Remove only the scratch dir this run created; mock servers are closed by the drive itself. Cleanup never touches `.verify-artifacts/` — after cleanup, confirm the evidence files still exist at the named location; a cleanup that eats the proof fails the run.

## Floor (always enforced)

From `constraint-driven-development`, applies to this skill and every change verified through it:

- No new suppression comments: `@ts-ignore`, `eslint-disable`, `# noqa`, `# type: ignore`.
- No unimplemented stubs: `throw new Error("Not implemented")`, empty `catch {}`.
- No skipped tests without a reason in the commit message.
- No secrets in source.
- Deliberate test deletion (a test diet) is allowed only when BOTH hold: the commit message names the test-diet task, and the removed journey remains covered by an existing integration/e2e test. A deletion failing either condition is rejected. This is the only Floor rule that may permit a deletion: skips, stripped assertions, suppression comments, secrets and the security/crypto/data-loss guards are never loosened for any change.
- This skill's proof bar is never weakened to make a change pass: a declared-unavailable surface stays unavailable until it is really driven.

## Helpers

No helper scripts ship with this skill: every drive is a plain `node scratch/<file>.mjs` grounded in the package READMEs (`packages/accounts/README.md` quickstart) and existing fixtures (`packages/accounts/src/testing/mock-openai.ts`, `examples/usage-demo.ts`, `scripts/pack-smoke.ts`). Write the consumer from the feature file, do not reverse-engineer one.
