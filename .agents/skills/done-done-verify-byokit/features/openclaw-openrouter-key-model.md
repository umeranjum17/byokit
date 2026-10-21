# OpenClaw OpenRouter key model

Verification recipe for [live provider catalogs](../../../../docs/runtime-kits.md#live-provider-catalogs-opencode-go-openrouter) (5.6) on the OpenRouter key route: OpenRouter is pay-as-you-go, so a funded key takes any model its own live catalog lists, with no plan check.

## Sub-features

- `addKey({ authChoice: 'openrouter-oauth', apiKey })` (Crewhouse's key sign-in: the browser choice, no model) returns `{ status: 'ok' }`: a choice of a provider with one key route billed alike takes that route. A choice that takes no key (`openai`, an unknown one) throws its cause, never `not_included`. On the real engine (`--engine`) a stand-in key under `openrouter-oauth` reaches OpenRouter's key probe and ends `{ status: 'invalid', reason: 'auth' }`.
- `addKey({ authChoice: 'openrouter-api-key', model: 'openrouter/deepseek/deepseek-v4.1-flash-1017' })` returns `{ status: 'ok' }`; the key run uses `deepseek/deepseek-v4.1-flash-1017`.
- `models(member, { authChoice: 'openrouter-api-key' })` lists the live catalog, each id `openrouter/<id>` (the catalog ids carry the maker's slash).
- The add registers the provider's live list in `models.providers.openrouter.models`, beside the chosen model: the engine's catalog stops at a registered list, so a sign-in that registered the chosen model alone left the member with that one row and nothing else to pick. The chosen model id sits beside the provider's own default (`openrouter/auto`), and every model the vendor lists stays pickable on the key lane (the MiniMax models, `minimax/minimax-m3.1-flash` and its free variant, among them). The pinned engine canonicalizes Google preview ids on `config.patch`, so the rows are deduped by the id it keeps: the pair is one row and the list is never refused (`Ambiguous duplicate ID ...`). A chosen preview id is listed, compared, registered and saved as the canonical id the engine keeps (`google/gemini-3.1-flash-lite-preview` becomes `google/gemini-3.1-flash-lite`).
- Every id has one prefix: a row already prefixed with its own provider (`openrouter/auto`) stays `openrouter/auto`; a maker-slash row gains the provider's (`deepseek/...` becomes `openrouter/deepseek/...`).
- With no saved key the engine answers `byokit.catalog` `failed`; `models()` returns `[]` then, and throws only when the key lane holds the provider's profile.
- An unknown model, a `model` on a non-live route, and a Go `orgId` on OpenRouter each return `{ status: 'not_included', reason: 'model' }`; no Go workspace header is written for OpenRouter.

## How to get to it (user POV)

A person pastes an OpenRouter API key with funds and picks a model such as DeepSeek V4.1 Flash; the agent answers on it.

## Driving it

After SKILL.md Launch and Doctor, from the worktree root:

```bash
feature=openclaw-openrouter-key-model
entry=.agents/skills/done-done-verify-byokit/capture/openclaw-openrouter-key-model.mjs
drive=(node "$entry" "$evidence_dir")
```

Use SKILL.md's Evidence capture block. Offline it drives `fakeGateway()` through the key path: the add registers the provider's live list beside the chosen model, the key lane lists the MiniMax models beside `openrouter/auto`, and the run answers on the chosen model. `drive=(node "$entry" --engine)` drives the real pinned engine (heavy job: hold the heavy-job lock; set `BYOKIT_SCRATCH` to a disk-backed dir or `BYOKIT_TEST_ENGINE_DIR` to an installed engine set): `byokit.catalog { provider: 'openrouter' }` answers ok with the chosen row, the raw list is refused (its preview pair collides, which is why the kit dedupes the rows by the id the engine keeps), and the chosen row registers; then a stand-in key under `openrouter-oauth` is probed and refused. It uses a dummy bearer because OpenRouter's `/models` is public; no real key and no inference.

## Gotchas

A real key run needs the key in the engine's own auth store (a file under the engine home); the `--engine` leg deliberately avoids it. A real-key inference proof is a credential-touching proof under SKILL.md's rules and needs an authorized key. The engine answers `byokit.catalog` with `failed` (not `no-key`) when no agent holds a key.

Keep `BYOKIT_SCRATCH` short: the engine's bridge socket under it fails with `listen EINVAL` past the Unix socket path limit.
