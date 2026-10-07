# Claude plan refresh

A consumer app holding a person's Claude plan sign-in keeps it through a refresh that gets no answer or a server error, and the next try rotates the same grant; only the provider refusing the grant signs the person out. All against a loopback stand-in for Claude's token endpoint.

## Sub-features

- `claude-refresh-transient`: a 503 from the token endpoint throws a plain error saying the sign-in is kept; `signedIn` stays `true` and `status` stays `ready`.
- `claude-refresh-retry`: the next `getAuth` sends the same grant again and returns the rotated access.
- `claude-refresh-refused`: an `invalid_grant` (400) throws `ClaudePlanExpiredError`, removes the stored sign-in and `status` reads `signed_out`.

## How to get to it (user POV)

- The consumer app constructs `new Accounts({ store: () => memoryStore(), claudePlan: { tokenUrl } })`, seeds a due Claude plan credential through `(await a.runtime(1)).credentialStore.modify('byokit-claude-plan', …)`, then calls `getAuth('byokit-claude-plan')` and reads `signedIn(1, 'claude')` and `status(1, 'claude')` after each answer.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md); no process of a previous drive is running.

- **Write the consumer.** Create `"$scratch_dir/verify-claude-refresh.mjs"` importing `Accounts, memoryStore` from `@byokit/accounts`. Start a `node:http` server on `127.0.0.1:0` that records each JSON body's `refresh_token` and answers from a queue; pass its URL as `claudePlan.tokenUrl`. Seed `{ type: 'oauth', access: 'old-access', refresh: 'grant-1', expires: Date.now() + 60_000 }`. Queue and call `getAuth` three times: `503 {}`; `200 { access_token: 'new-access', refresh_token: 'grant-2', expires_in: 60 }`; `400 { error: 'invalid_grant' }`. After each, print the result or the error's name and message, `signedIn`, `status().state` and the grants sent. Close the server at the end.
- **Run and capture.** `feature=accounts-claude-refresh; entry=@byokit/accounts; drive=(node "$scratch_dir/verify-claude-refresh.mjs")`, then run SKILL.md Evidence's capture block. Exit code `0`.
- **Happy path shows.** After the 503: an `Error` whose message says the sign-in is kept, `signedIn=true status=ready`; after the rotation: `access=new-access` with grants sent `["grant-1","grant-1"]`.
- **Error case shows.** `ClaudePlanExpiredError: Sign in with Claude again.`, `signedIn=false status=signed_out`, and the stored credential gone.
- **Proof.** The captured artifact contains command output for the action and resulting state of every sub-feature above.

## Gotchas

- A refresh happens only when the access expires within five minutes, so the seed expires in 60 s and the rotated answer uses `expires_in: 60` to make the next call refresh again.
- Two processes sharing one store need a store with a cross-process lock (`fileStore`); `packages/accounts/test/signin.test.ts` drives that case with real child processes.
