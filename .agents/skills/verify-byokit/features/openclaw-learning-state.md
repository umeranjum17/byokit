# OpenClaw engine learning state

Verification recipe for [OpenClaw's engine learning state](../../../../packages/openclaw/README.md#engine-learning-state): an app reads, sets and restores the engine's learning mode on a stopped home, with absence a value and `propose` visible.

## Sub-features

- `learning()` reads `skills.workshop.autonomous.mode` as `{ present: false } | { present: true; mode }` from the config file the engine loads at boot.
- `setLearning('off' | 'propose' | 'auto' | 'default')` writes the mode (`default` removes the key) and returns the state it replaced; only that key changes, byte for byte.
- `restoreLearning(captured)` lands the captured state exactly (absence restores absence) and reads back.
- Refusals: an unknown mode lists the accepted values, a stored out-of-enum value throws naming it, and a `skills` key in `KitOptions.config` refuses both writers.

## How to get to it (user POV)

Prepare a retained home, then maintain it while stopped: capture `learning()`, `setLearning('off')` before repair, `restoreLearning(captured)` after — no gateway running.

## Driving it with node scratch consumers

After SKILL.md Launch and Doctor, run the public-entry consumer shipped in `capture/openclaw-learning-state.mjs` from the worktree root:

```bash
feature=openclaw-learning-state
entry=.agents/skills/verify-byokit/capture/openclaw-learning-state.mjs
drive=(node "$entry" "$evidence_dir")
```

Use SKILL.md's Evidence capture block after allocating `evidence_dir`. The consumer imports only the built public `@byokit/openclaw` entry, `prepare()`s a real home layout (`spawnEngine: false`), and exercises the whole surface against the real config file, including every refusal with its actual error message.

## Gotchas

This drive proves the stopped-home surface and the file contract; that a real engine boot applies the mode and projects the `skill-collection-review-<agentId>` cron job is proved by `npm run test:engine` (`packages/openclaw/test/engine/learning.test.ts`), not here. The scratch state dir is removed in `finally`; no provider, credential or network is involved. There is no changed app screen, theme or device UI.
