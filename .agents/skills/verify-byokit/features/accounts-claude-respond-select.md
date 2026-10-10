# Claude plan respond select

A consumer app with two signed-in Claude plan accounts asks `Accounts.respond({ provider: 'claude', select })` and the answer comes from the selected account's own sign-in, never the primary slot; a 429 on the selected account rests only it and an expiry signs out only it, leaving the primary ready. All against the built `@byokit/accounts` and a loopback stand-in for Claude's token endpoint and Messages SSE.

## Sub-features

- `claude-select-primary`: `select: { account: 'claude' }` answers from the bare primary sign-in; the Messages request carries that account's bearer and never `select` or `provider`.
- `claude-select-second`: `select: { account: 'claude.<id>' }` answers from the second account's own bearer.
- `claude-select-429`: a 429 on the selected account rests only it (one request, no retry on another), the primary stays `ready`, and the thrown `ResponseError` is `kind: 'rate_limit'` with a future `until`.
- `claude-select-expiry`: expiring the selected account (an accepted-but-unusable refresh) throws `ClaudePlanExpiredError`, keeps the primary credential, and a fresh `Accounts` reads the primary `ready` and the selected account `signed_out`.

## How to get to it (user POV)

- The app constructs `new Accounts({ store: () => memoryStore(), fetch, claudePlan: { now: () => Date.now() }, app }, portable)` with a `fetch` that forwards `https://platform.claude.com` and `https://api.anthropic.com` to the loopback stand-in. It signs in two Claude accounts through `add(1, 'claude')` then `paste`/`finished`, reads `list(1)`, and calls `respond` with `select`.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md); no process of a previous drive is running.

- **Write the consumer.** Create `"$scratch_dir/verify-claude-respond-select.mjs"` importing `Accounts, ClaudePlanExpiredError, ResponseError, memoryStore, portable` from `@byokit/accounts`. Start a `node:http` server on `127.0.0.1:0` answering `/v1/oauth/token` (authorization_code issues `access-N`/`refresh-N`; refresh echoes `refresh-N`, and returns `expires_in: 0` for the refresh named in `state.unusableRefresh`) and `/v1/messages` (replays the recorded SSE `answer.stream` from `fixtures/conformance/claude-messages-typescript.json`, records `{ bearer, body }`, and enforces a one-shot `state.fail`). Forward `https://platform.claude.com` and `https://api.anthropic.com` to its base. Sign in two accounts, then print: the ids and that the first is bare `claude`; the primary and second answers with the recorded bearer each (`access-1`, `access-2`) and that neither `select` nor `provider` reached the body; after setting `state.fail { status: 429, body: { error: { type: 'rate_limit_error' } } }`, the caught error's kind and `until > Date.now()`, the request delta (`1`), and both rows' `state`; then set the second credential's `expires` to now with `state.unusableRefresh = 'refresh-2'`, the caught `ClaudePlanExpiredError`, both credentials still present, and a fresh `Accounts`' `list(1)` states. `stop()` the instances and close the server in a `finally`.
- **Run and capture.** `feature=accounts-claude-respond-select; entry=@byokit/accounts; drive=(node "$scratch_dir/verify-claude-respond-select.mjs")`, then run SKILL.md Evidence's capture block. Exit code `0`.
- **Happy path shows.** `primary bearer: access-1 select-leaked: false`; `second bearer: access-2 provider-leaked: false`; `ids: claude,claude.<id> primary-is-bare: true count: 2`.
- **Rest and error cases show.** `429 kind: rate_limit until-future: true one-request: true`; `states after 429: claude=ready,claude.<id>=resting`; `expiry caught: ClaudePlanExpiredError`; `fresh states: claude=ready,claude.<id>=signed_out`.
- **Proof.** The captured artifact contains command output for the action and resulting state of every sub-feature above.

## Gotchas

- The stand-in's Messages endpoint must return the recorded SSE the kit parses; a plain 200 JSON is not a valid answer.
- The kit reads Claude's access from the token endpoint on demand, so a fresh sign-in's `request` count stays at zero until the first `respond`.
- `select: { account: 'claude' }` is the bare primary id; the second account's id includes a dot (`claude.<hex>`), which is what routes to its own engine.
- Expiry is proved by an accepted-but-unusable refresh (`expires_in: 0`): the grant is marked, never deleted, so a fresh `Accounts` reads `signed_out` from the store rather than an in-memory lapse.
