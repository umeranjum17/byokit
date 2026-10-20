# OpenClaw identity merge on addAccount

Verification recipe for [adding an account](../../../../docs/runtime-kits.md#515-accounts-one-shared-grant-one-view-per-account-d17)'s identity rules (O14 step S7): `kit.addAccount` compares the sealed sign-in's `who` (a hash of the provider's account id, never the email) with the member's other accounts of that provider.

## Sub-features

- The same identity refreshes the existing row and `done.id` names it, even with a changed email; the new agent and entry go.
- `again` = X with another identity adds a row; X keeps billing on its own sign-in.
- No account id (no `who`) never merges, even with `again` and the same email.
- Several older accounts sharing a `who` (only from before O14): the earliest `addedAt` takes the sign-in (leg in `packages/openclaw/test/accounts.test.ts`).
- `who` and the account id never reach `accounts()`, views, `done`, errors, logs or kit state.

## How to get to it (user POV)

A person signs in to ChatGPT again as the same account, from "Add another account" or "Sign in again" on a row: the member keeps one row, now fresh. Signing in to another login adds a row and leaves the first one as it was.

## Driving it with node scratch consumers

After SKILL.md Launch and Doctor:

```bash
feature=openclaw-identity-merge
entry=.agents/skills/done-done-verify-byokit/capture/openclaw-identity-merge.mjs
drive=(node "$entry")
```

Use SKILL.md's Evidence capture block. The consumer imports only the built `@byokit/openclaw` and `@byokit/openclaw/testing` entries and sets each sign-in's account id and email with `fakeGateway().signInAs`.

## Gotchas

The fake's `adopt` mirrors `plugin/accounts.js`; the real pinned engine's `adopt` (record moved whole, refused on another `who`) is in `packages/openclaw/test/engine/accounts.test.ts`. No provider, credential or network is involved.
