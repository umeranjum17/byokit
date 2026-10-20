# OpenClaw key-route live catalogs

A consumer app with an API key on any `@byokit/openclaw` key route asks `kit.models(member, { authChoice })` and gets that route's own catalog: the provider plugin's rows joined by the vendor's own `GET /models` (5.6 Live provider catalogs), not a provider or model list the kit keeps. `addKey({ ..., model })` takes an id the catalog names or lags (warned by its absence from `models()`, never refused).

## Sub-features

- `any-key-route`: a route outside the plan routes (xAI on the fake gateway) lists its catalog once a key is saved, and an add with a listed model registers that model alone.
- `vendor-join`: the plugin's `byokit.catalog` joins the vendor's own list to a fixed plugin catalog (MiniMax live: ids the pinned engine lacks, such as `MiniMax-M3.1-Flash`, appear).
- `unlisted-warns`: `addKey` with a `provider/model` id the catalog lacks is `{ status: 'ok' }`, riding the richest row; an id without its provider, or a catalog with no rows, is `not_included`/`model`.

## How to get to it (user POV)

- The app constructs `new OpenClawKit({ stateDir, engineDir })`, `start()`s it, calls `addKey(member, { authChoice, apiKey })`, then `models(member, { authChoice })` before a model picker and `addKey(..., model)` for the person's choice, then `run`.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md).

- **Offline journey.** `sh scripts/test.sh packages/openclaw/test/kit.test.ts` runs `any key route lists its own catalog…`, the MiniMax, OpenRouter and Go catalog journeys and `a key route whose provider has no catalog…` on the fake gateway: expect them to pass.
- **Live leg (real engine, real key, cheap model).** Write `"$scratch_dir/verify-oc-live.ts"` importing `OpenClawKit` from the package source. Read a sanctioned MiniMax key from the path in `argv[2]` (never print it; fail if any output contains it). Use an `engineDir` under the task's disk scratch (not `/tmp`). `addKey('m1', { authChoice: 'minimax-global-api', apiKey })`, print `models()` ids, an `addKey` with `minimax/not-yet-listed-model`, an `addKey` with the `*Flash*` id, then one `run` asking for one word. `feature=openclaw-live-catalogs; entry=@byokit/openclaw; drive=(env PATH=/usr/bin:$PATH node "$scratch_dir/verify-oc-live.ts" <key path> <scratch dir>)` under a throwaway `HOME`, through the memory gate, then SKILL.md Evidence's capture block.
- **Happy path shows.** Ids the pinned engine's MiniMax plugin lacks (`minimax/MiniMax-M3.1-Flash`, `minimax/MiniMax-M2.1`), `addUnlisted {"status":"ok"}`, and `{"run":true,"text":"ready"}`.
- **Proof.** The artifact holds the listed ids, the add results and the answer; no key text.

## Gotchas

- The vendor list is read with the richest row's api and base URL: `openai-*` → `{base}/models` (bearer); `anthropic-messages` → `{base}/v1/models` (`x-api-key`, MiniMax a bearer). Another api, or a refused list, keeps the plugin's rows.
- Only `opencode-go` and `minimax` are registered whole (`REGISTERED_CATALOGS`); every other provider registers the chosen model alone, because the engine's id canonicalization can make a whole list collide (OpenRouter).
