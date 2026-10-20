# ChatGPT refresh refusal

A phone or browser app holding a person's ChatGPT sign-in keeps it when the token endpoint answers a passing 401 (one that names no revoked grant), whether the refresh was due (`access`) or forced after ChatGPT turned a request away (`recheck`); the stored grant is tried again and rotates once the provider is back. Only the provider proving the grant revoked (`invalid_grant`, or OpenAI's `refresh_token_reused` and kin) signs the person out. All against `mockOpenAI()` on loopback.

## Sub-features

- `refresh-passing-401-due`: a due refresh meeting a passing 401 rejects `respond` with `ResponseError` kind `network`; `signedIn` stays `true`, `status` stays `ready`.
- `refresh-passing-401-recheck`: a request refused with 401 forces a refresh that meets a passing 401; `respond` rejects with kind `overloaded` and the sign-in is kept.
- `refresh-retry`: once the token endpoint answers again, `respond` answers and the same grant was sent each time before rotating.
- `refresh-revoked`: a refused request whose forced refresh meets `refresh_token_reused` rejects with kind `signed_out`; `signedIn` reads `false`.

## How to get to it (user POV)

- The app runs the portable entry (`@byokit/accounts` under the `browser` or `react-native` condition): `new Accounts({ store: () => memoryStore(), authBase, apiBase })`, signs in with the device code, then calls `respond(1, { instructions: '', input: 'hi' })` and reads `signedIn(1, 'chatgpt')` and `status(1, 'chatgpt')` after each.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md); no process of a previous drive is running.

- **Write the consumer.** Create `"$scratch_dir/verify-refresh-refusal.mjs"` importing `Accounts, memoryStore` from `@byokit/accounts` and `mockOpenAI` from `@byokit/accounts/testing`. Start the stand-in, set `openai.state.expiresIn = 0` so the sign-in is due, sign in (`login` → `openai.approve(view.code)` → `finished`). Wrap `globalThis.fetch` so `${openai.base}/oauth/token` records each form's `refresh_token` and, while a `passing` flag is on, answers `401 {"error":{"message":"Unauthorized"}}`; everything else goes to the real fetch. Then, printing after each step the error's name, `kind` and message (or the answer), `signedIn`, `status().state` and the grants sent: (1) `respond`; (2) `passing = false`, `openai.state.expiresIn = 864000`, `respond`; (3) `passing = true`, `openai.state.fail = { status: 401, body: '{"error":{"message":"expired"}}' }`, `respond`; (4) `passing = false`, `openai.state.refuse = true`, `openai.state.fail` as in (3), `respond`. Restore `fetch` and close the stand-in at the end; exit 1 unless the four outcomes are `network`, an answer, `overloaded`, `signed_out`.
- **Run and capture.** `feature=accounts-refresh-refusal; entry=@byokit/accounts; drive=(node --conditions=browser "$scratch_dir/verify-refresh-refusal.mjs")`, then run SKILL.md Evidence's capture block. Exit code `0`.
- **Happy path shows.** (1) `ResponseError network`, `signedIn=true status=ready`; (2) `You said: hi`, the first grant sent twice; (3) `ResponseError overloaded`, `signedIn=true`, the second grant sent once.
- **Error case shows.** (4) `ResponseError signed_out`, `signedIn=false`.
- **Proof.** The captured artifact contains command output for the action and resulting state of every sub-feature above.

## Gotchas

- Without `--conditions=browser` Node resolves `@byokit/accounts` to the desktop entry, whose Pi engine refreshes through its own path; this journey is the portable engine's.
- `openai.state.fail` answers only the next question; set it again before each refused request.
