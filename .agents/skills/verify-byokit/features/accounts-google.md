# Google Cloud Code Assist sign-in and stand-in (mockGoogle)

On a computer, `@byokit/accounts` signs a person in to Google Cloud Code Assist (the Gemini CLI client) with PKCE: `Accounts.add(member, 'google-gemini-cli:browser')` opens Google's own page, the browser returns to the client's fixed loopback port `:8085`, and `list()` then shows a Gemini account ready with the email from the sign-in; `google-gemini-cli:paste` takes the pasted redirect address instead and opens no listener. The `mockGoogle()` stand-in answers the whole protocol offline for both Google clients (`google-gemini-cli` `:8085`, `google-antigravity` `:51121`): PKCE authorize, the loopback callback, the token exchange and refresh, userinfo, and the Cloud Code Assist `loadCodeAssist`/`onboardUser` project calls.

## Sub-features

- `google-pkce`: `authorizeUrl()` builds Google's page with the client's recorded scopes and `access_type=offline`/`prompt=consent`; the stand-in returns `303` to the loopback callback with `code` and `state`, and refuses a non-`S256` challenge.
- `google-exchange`: a `POST /token` with `grant_type=authorization_code` and the matching `code_verifier` answers the recorded token; a wrong verifier is refused.
- `google-refresh`: `grant_type=refresh_token` rotates the recorded grant; after `state.refuse` it answers `invalid_grant`.
- `google-userinfo`: `GET /oauth2/v1/userinfo` answers the recorded email.
- `google-project`: `POST /v1internal:loadCodeAssist` answers a recorded existing project; with `state.provision` it answers `allowedTiers` and `onboardUser` plus its operation poll answer the recorded project; with `state.ineligible` it answers `ineligibleTiers`.
- `google-signin-browser`: `Accounts.add(member, 'google-gemini-cli:browser')` returns a waiting sign-in whose URL is the client's authorize page; fetching it and following its `location` to `127.0.0.1:8085` completes the sign-in, and `list()` shows the account `ready` with `email`.
- `google-signin-paste`: `Accounts.add(member, 'google-gemini-cli:paste')` returns the same page, opens no loopback listener, and completes when `Accounts.paste()` receives the redirect address.
- `google-busy-port`: with `:8085` already held, the browser sign-in waits for the port and completes once it is free; `Accounts.cancel()` closes the listener and keeps nothing.

## How to get to it (user POV)

- On a computer, an app calls `new Accounts({ store, authBase })` from `@byokit/accounts` and `add(member, 'google-gemini-cli:browser')` (or `:paste`); it shows `signIn.url` to open, then `list(member)` shows the account. `mockGoogle()` from `@byokit/accounts/testing` is the offline stand-in for that page and every endpoint.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md); no process of a previous drive is running; `:8085` free.

- **Write the consumer.** Create `"$scratch_dir/verify-google.mjs"` importing `Accounts`, `memoryStore` from `@byokit/accounts` and `mockGoogle` from `@byokit/accounts/testing`. Part A, the stand-in, for each of `google-gemini-cli` and `google-antigravity`: start the mock, build a PKCE verifier/challenge, `fetch(mock.authorizeUrl({ redirectUri, state, codeChallenge }), { redirect: 'manual' })` and follow the `location` to the loopback callback; exchange the code, read userinfo, call `loadCodeAssist` (existing project, then `provision` for onboard + poll), refresh, then set `state.refuse`/`state.ineligible` and print each `invalid_grant` and `ineligibleTiers` answer; close it. Part B, the sign-in, on a fresh mock and `new Accounts({ store: () => memoryStore(), authBase: mock.base, app: 'verify' })`: (1) `add(1, 'google-gemini-cli:browser')`, `fetch(signIn.url, { redirect: 'manual' })`, `fetch(location)`, `finished`, and print `list(1)` (provider, state, email) and the refresh answer from `runtime(1).getAuth('google-gemini-cli', { minOAuthValidityMs: 10**9 })`, then `logout`; (2) `add(1, 'google-gemini-cli:paste')`, `paste(1, id, location)`, `finished`, print `list(1)`; (3) hold `:8085`, `add` browser without awaiting, show it has not returned, free the port and print it completing; (4) `add` browser then `cancel`, print that the store and `list` are empty. Print whether `recorded-access`/`recorded-refresh` appear in `list`/`status`/the index, then close the mock.
- **Run and capture.** `feature=accounts-google; entry=@byokit/accounts, @byokit/accounts/testing; drive=(node "$scratch_dir/verify-google.mjs")`, then run SKILL.md Evidence's capture block. Exit code `0`.
- **Happy path shows.** For both clients the recorded `access_token`/`refresh_token`, the recorded `email`, the existing `recorded-project` and the provisioned `recorded-project`; for the sign-in, a `ready` row with `umer@example.com` and `rotated-access` after the refresh.
- **Error case shows.** The `400 invalid_grant` on a refused or reused refresh, the `ineligibleTiers` answer for an individual account with no Code Assist tier, and a refused refresh at `getAuth` with no token in the error.
- **Proof.** The captured artifact contains command output for the action and resulting state of every sub-feature above.

## Gotchas

- The stand-in answers on an OS-assigned loopback port; the client's real callback port (`8085`, `51121`) is a recorded fact in `mock.protocol.callback`, not a port the mock binds.
- It records no client secret: the authorize URL uses the client's public id, and `fixtures/conformance/google-oauth-typescript.json` names the reuse rule without any secret.
- `state.provision` and `state.ineligible` are switches for the two project outcomes; reset them between calls.
- `google-antigravity` is a data-only client here; its routes land in WP6-S5. The sign-in flow is `google-gemini-cli` only.
- There is no Code Assist model adapter yet (WP6-S6), so `Accounts.respond` for a Gemini account is out of scope; the proof is the sign-in and the recorded protocol answers.
