# Ollama Pro plan-key route

Built `@byokit/accounts/ollama-pro`: save a plan key via the shared secrets seam, chat against a loopback fake of `https://ollama.com/v1` with default model `deepseek-v4.1-flash`. Fakes only.

## Sub-features

- Catalogue route `ollama-pro:plan_key` (subscription plan key, strong model `deepseek-v4.1-flash`).
- Seam: `saveOllamaProPlanKey` / `ollamaProPlanAccount` / `deleteOllamaProPlanKey` — one `accounts.ollama-pro:plan_key` entry; missing key says `Add the Ollama Pro plan key first.`
- `ollamaProChat` POSTs `/chat/completions` to a 127.0.0.1 fake with Bearer from the store; canary never in argv/env/response/errors.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md).

- Write `"$scratch_dir/verify-accounts-ollama-pro.mjs"` importing `@byokit/accounts/ollama-pro`, Map store, canary `canary-ollama-pro-verify-key`, loopback `http.createServer`. Assert missing → save → chat → delete → refuse. Never print the canary.
- `feature=ollama-pro; entry=@byokit/accounts/ollama-pro; drive=(node "$scratch_dir/verify-accounts-ollama-pro.mjs")`, then SKILL.md Evidence capture; `leak_check` the canary (exit 0).
