# OpenClaw member auth isolation

Verification recipe for section 5.15 Isolation and D9 in `docs/runtime-kits.md`: on an install with two or more members, a member runs only on its own sign-ins, sign-out removes only that member agent's own profiles, and D9's member rule applies to new members only.

## Sub-features

- Every boot forces `agents.defaults.authInheritance.agentId = 'byokit-base'`, an id the kit never creates, so a saved pre-O14 config that names the first member stops applying.
- A member that never signed in reads signed out; an explicit `provider/model` pick of another member's provider ends `{ ok: false, kind: 'signed-out' }` with no model request.
- `signOut(member, provider)` passes the agent's own `profileIds`; another member's profile store stays byte for byte.
- New members follow D9 (no `--`, at most 24 characters, never `byokit-*`); an existing older-rule member such as `a--b` still runs; `main`, `openclaw`, `crestodian` and `byokit-base` are never a member, though `main` exists on every install.

## How to get to it (user POV)

A host with two members, `m1` signed in to ChatGPT and `m2` never signed in, upgrades the kit: `m2` no longer answers on `m1`'s plan, and `m2` signing out never signs `m1` out.

## Driving it with node scratch consumers

After SKILL.md Launch and Doctor, run the shipped public-entry consumer from the worktree root (it installs the pinned engine into the supplied scratch root on first use, a heavy job):

```bash
feature=openclaw-member-isolation
entry=.agents/skills/verify-byokit/capture/openclaw-member-isolation.mjs
drive=(node "$entry" "$HOME/.cache/fm-scratch/openclaw-member-isolation" --expect-isolation)
```

Use SKILL.md's Evidence capture block. The consumer imports only `@byokit/openclaw` and `@byokit/openclaw/testing`, seeds synthetic retained sign-ins through `migrateRetainedLogin`, writes the pre-O14 `authInheritance: m1` into the saved config, then boots the real engine and prints the forced setting, each member's providers, the refused pick with its stub request count, the `a--b` run, the D9 refusals and the sign-out comparison, ending `MEMBER-ISOLATION OK`. Without `--expect-isolation` it prints the same readings without asserting; on a pre-O14 build that shows the saved `m1` owner kept and `c--d`, `byokit-base` and `main` accepted as members (the before).

## Gotchas

Remove the scratch root afterwards (it holds the engine set). The tokens are synthetic (`a-m1`, `a-m2`); no provider, account or network beyond the engine install is used. The same journey is the engine job's `packages/openclaw/test/engine/accounts.test.ts`. A native Claude Code login has no engine profile, so `signOut(member, 'claude-cli')` sends no request. On the 2026.8.35 pin a kit install's shared auth store is already `state-db` (`auth.sharedStore` in `state/state/openclaw.sqlite`), where the pin ignores `authInheritance`, so the stale owner leaks only on an install whose store has not moved yet; `m2`'s readings look the same before and after on a fresh install. Under load a seed can come back `failed` (the doctor's exit); with `--expect-isolation` that fails the run instead of passing a vacuous sign-out check. There is no changed screen.
