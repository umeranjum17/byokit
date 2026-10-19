# OpenClaw OpenRouter key model

Verification recipe for [live provider catalogs](../../../../docs/runtime-kits.md#live-provider-catalogs-opencode-go-openrouter) (5.6) on the OpenRouter key route: OpenRouter is pay-as-you-go, so a funded key takes any model its own live catalog lists, with no plan check.

## Sub-features

- `addKey({ authChoice: 'openrouter-api-key', model: 'openrouter/deepseek/deepseek-v4.1-flash-1017' })` returns `{ status: 'ok' }`; the key run uses `deepseek/deepseek-v4.1-flash-1017`.
- `models(member, { authChoice: 'openrouter-api-key' })` lists the live catalog, each id `openrouter/<id>` (the catalog ids carry the maker's slash).
- Only the chosen model is registered in `models.providers.openrouter.models`: the pinned engine canonicalizes Google preview ids on `config.patch`, so the whole list is refused (`Ambiguous duplicate ID ...`). A chosen preview id is listed, compared, registered and saved as the canonical id the engine keeps (`google/gemini-3.1-flash-lite-preview` becomes `google/gemini-3.1-flash-lite`).
- Every id has one prefix: a row already prefixed with its own provider (`openrouter/auto`) stays `openrouter/auto`; a maker-slash row gains the provider's (`deepseek/...` becomes `openrouter/deepseek/...`).
- With no saved key the engine answers `byokit.catalog` `failed`; `models()` returns `[]` then, and throws only when the key lane holds the provider's profile.
- An unknown model, a `model` on a non-live route, and a Go `orgId` on OpenRouter each return `{ status: 'not_included', reason: 'model' }`; no Go workspace header is written for OpenRouter.

## How to get to it (user POV)

A person pastes an OpenRouter API key with funds and picks a model such as DeepSeek V4.1 Flash; the agent answers on it.

## Driving it

After SKILL.md Launch and Doctor, from the worktree root:

```bash
feature=openclaw-openrouter-key-model
entry=.agents/skills/verify-byokit/capture/openclaw-openrouter-key-model.mjs
drive=(node "$entry")
```

Use SKILL.md's Evidence capture block. Offline it drives `fakeGateway()` through the key path. `drive=(node "$entry" --engine)` drives the real pinned engine (heavy job: hold the heavy-job lock; set `BYOKIT_SCRATCH` to a disk-backed dir or `BYOKIT_TEST_ENGINE_DIR` to an installed engine set): `byokit.catalog { provider: 'openrouter' }` answers ok with the chosen row, the whole list is refused, and the chosen row registers. It uses a dummy bearer because OpenRouter's `/models` is public; no key and no inference.

## Gotchas

A real key run needs the key in the engine's own auth store (a file under the engine home); the `--engine` leg deliberately avoids it. A real-key inference proof is a credential-touching proof under SKILL.md's rules and needs an authorized key. The engine answers `byokit.catalog` with `failed` (not `no-key`) when no agent holds a key.
