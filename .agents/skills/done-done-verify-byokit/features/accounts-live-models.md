# Accounts live model lists

A consumer app with a key account asks `Accounts.models(member, id)` and gets the vendor's own current models, read live from that vendor's `GET /models` with the account's own key (the route's `models` endpoint in `routes.json`), not a list the kit keeps; `Accounts.pick` with a model id the vendor's list lags still picks the account and names the id in `unlisted` so the app can warn.

## Sub-features

- `live-openai-style`: an OpenAI-style route (`groq:key` on a loopback fake) lists the vendor's ids, sent with `authorization: Bearer <key>`.
- `live-anthropic-style`: an Anthropic Messages route (`anthropic:key` fake; `minimax:key` live) lists from `{base}/v1/models` with `anthropic-version`; Anthropic gets `x-api-key`, MiniMax a bearer; `display_name` becomes `name`.
- `unlisted-warns`: `pick(member, { account, model: '<id the list lacks>' })` is `ok: true` with `unlisted: ['<id>']`; a listed id has no `unlisted`.
- `model-required`: BYOKit keeps no default model: `pick` with no model names the first id of the account's live list, and a ChatGPT `respond` without `model` is refused (`ResponseError`, kind `null`, "Name the model to ask…") before any request is sent.
- `list-unreadable`: a list that fails (404, offline) gives `models()` `[]` (BYOKit keeps no list to fall back to) and never blocks a pick that names its model.

## How to get to it (user POV)

- The app constructs `new Accounts({ store, keyStore })` (computer) or `new Accounts(opts, withKeys(portable))`, adds a key with `add(member, '<route id>', { key })`, then calls `models(member, id)` before showing a model picker and `pick` before a run.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md); `npm run build` done.

- **Offline journey.** `sh scripts/test.sh packages/accounts/test/key-routes.test.ts` runs `a key account lists its vendor’s own live models…` on both the computer and portable entries with a fake `fetch` (no egress): expect it to pass.
- **Live leg (real key, cheap model).** Write `"$scratch_dir/verify-live-models.mjs"` importing `Accounts, memoryStore, computer, resolveModel` from `@byokit/accounts`. Read a sanctioned MiniMax key from the path in `argv[2]` (never print it; fail if any output contains it). `add('umer', 'minimax:key', { key })`, `saveKey(..., { billedPerUse: true })`, print `models()` ids, the `pick` of `not-yet-listed-model`, then one `respondKey` on a `*Flash*` id from the live list resolved by `resolveModel(computer.engine(memoryStore()), 'minimax', id, { apiKey })` with `maxTokens: 64`. `feature=accounts-live-models; entry=@byokit/accounts; drive=(node "$scratch_dir/verify-live-models.mjs" <key path>)`, then SKILL.md Evidence's capture block, under a throwaway `HOME`.
- **No kit model.** Write `"$scratch_dir/verify-b2.mjs"` like the live leg (same key by path), adding `pick` with no model (expect the first live id, e.g. `MiniMax-M3.1-Flash`) and, on `mockOpenAI()`, ChatGPT's `models()` from `/codex/models`, a model-less `respond` refused with `requestsSent: 0`, then a `respond` with `model: 'gpt-6-sol'` answered.
- **Happy path shows.** More ids than the pin's MiniMax rows (the vendor's list, e.g. `MiniMax-M3.1-Flash`, `MiniMax-M2.7`), `pickUnlisted {"ok":true,"unlisted":["not-yet-listed-model"]}`, and a real answer (`stop: "stop"`) on a live-listed id.
- **Proof.** The artifact holds the listed ids, the pick and the answer; no key text.

## Gotchas

- A key account's route id is its `account.route` (`minimax:key`); a sign-in account (Grok, Copilot, Kimi, Meta, MiniMax device) uses its token from `runtime().getAuth`, with Copilot's own base and headers.
- No list (routes without `models`: Bedrock, Azure, Vertex, Cloudflare, Google AI Studio, Mistral, Radius, Typesafe, custom) list nothing: `models()` is `[]` and the app names the model itself (the PR's exceptions).
- OpenCode Go's list needs a key the gateway accepts: a refused key (401 `Invalid credential`) lists nothing, as an unreadable list does.
