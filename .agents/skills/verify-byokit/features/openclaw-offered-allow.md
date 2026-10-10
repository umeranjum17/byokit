# OpenClaw offered-route plugin allow

Verification recipe for [OpenClaw's config invariants](../../../../docs/runtime-kits.md#56-config-invariants): an app that offers an explicit sign-in such as OpenRouter gets that route's plugin in `plugins.allow`, so the engine's wizard is not a dead end before any browser step, while a defaults-only app stays unchanged.

## Sub-features

- `KitOptions.offered` names the accounts an app offers (the provider, auth choice or alias a route carries, e.g. `'openrouter'`).
- `reconcileConfig` adds the `plugin` id of every route those names match to `plugins.allow`, alongside the kit id and every default-eligible bundled route's plugin; routes nobody offers, and routes with `needs.plugin`, stay out.
- The merge keeps the app's own `config.plugins.allow` entries and never duplicates.

## How to get to it (user POV)

An app ships a sign-in card with OpenRouter on it and passes those accounts in `KitOptions.offered`. On the first boot the engine would otherwise refuse the click with `OpenRouter OAuth is disabled (blocked by allowlist)`; with the offered set it returns the authorize URL.

## Driving it with node scratch consumers

After SKILL.md Launch and Doctor, run the public-entry consumer shipped in `capture/openclaw-offered-allow.mjs` from the worktree root:

```bash
feature=openclaw-offered-allow
entry=.agents/skills/verify-byokit/capture/openclaw-offered-allow.mjs
drive=(node "$entry" "$evidence_dir")
```

Use SKILL.md's Evidence capture block after allocating `evidence_dir`. The consumer imports only the built public `@byokit/openclaw` entry, `prepare()`s two real home layouts (`spawnEngine: false`) — one defaults-only, one offering `['chatgpt', 'grok', 'copilot', 'openrouter']` — and asserts the written `plugins.allow`.

## Gotchas

This drive proves the written config contract. The real engine's wizard refusing the click without the plugin, and returning the authorize URL with it, is the Crewhouse gate at `ch-te-gate` row 2 (`.../data/ch-te-gate/report.md`); the reconcile rule is unit-covered by `packages/openclaw/test/config.test.ts` and the boot by `packages/openclaw/test/kit.test.ts`. No provider, credential or network is involved; there is no changed app screen, theme or device UI.
