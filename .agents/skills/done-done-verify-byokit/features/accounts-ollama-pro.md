# Ollama Pro plan-key route

Built `@byokit/accounts/ollama-pro`: save a plan key via the shared secrets seam, chat against a loopback fake of `https://ollama.com/v1` using the consumer-selected `deepseek-v4.1-flash` model. The catalogue maps Ollama Pro to the existing `openai` provider shape; BYOKit supplies no model catalog. Fakes only.

## Sub-features

- Catalogue route `ollama-pro:plan_key` (subscription plan key) maps to the `openai` shape while retaining the Ollama route id and endpoint.
- Seam: `saveOllamaProPlanKey` / `ollamaProPlanAccount` / `deleteOllamaProPlanKey` — one `accounts.ollama-pro:plan_key` entry; missing key says `Add the Ollama Pro plan key first.`
- Provider conformance test resolves the Ollama route through `Accounts.respondKey` and proves the selected provider/model reach `/chat/completions` at the configured base URL; `ollamaProChat` POSTs to a 127.0.0.1 fake with Bearer from the store. Canary never in argv/env/response/errors.
- Computer engine: `computer.engine(store).getModel('ollama-pro', id)` answers (OpenAI-compatible, `https://ollama.com/v1`) so a Pi consumer needs no local alias; proven by the 'consumer resolves ollama-pro' test in `packages/accounts/test/ollama-pro.test.ts` (loopback stub sees POST `/v1/chat/completions`, Bearer key, the named model, `stream: true`).

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md).

- Write `"$scratch_dir/verify-accounts-ollama-pro.mjs"` importing `@byokit/accounts/ollama-pro`, Map store, canary `canary-ollama-pro-verify-key`, loopback `http.createServer`. Assert missing → save → chat → delete → refuse. Never print the canary.
- `feature=ollama-pro; entry=@byokit/accounts/ollama-pro; drive=(node "$scratch_dir/verify-accounts-ollama-pro.mjs")`, then SKILL.md Evidence capture; `leak_check` the canary (exit 0).
