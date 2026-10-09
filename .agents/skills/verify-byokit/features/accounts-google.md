# Google Cloud Code Assist stand-in (mockGoogle)

A test author drives the two Google routes' whole protocol offline: PKCE authorize, the loopback callback, the code exchange and refresh, userinfo, and the Cloud Code Assist `loadCodeAssist`/`onboardUser` project calls, for `google-gemini-cli` (callback `:8085`) and `google-antigravity` (callback `:51121`), all over fetch against `127.0.0.1`. The sign-in flows themselves are later work (WP6-S3/S5), so this is a testing-helper surface, not a user screen: the proof is the recorded token and project answers.

## Sub-features

- `google-pkce`: `authorizeUrl()` builds Google's page with the client's recorded scopes and `access_type=offline`/`prompt=consent`; the stand-in returns `303` to the loopback callback with `code` and `state`, and refuses a non-`S256` challenge.
- `google-exchange`: a `POST /token` with `grant_type=authorization_code` and the matching `code_verifier` answers the recorded token; a wrong verifier is refused.
- `google-refresh`: `grant_type=refresh_token` rotates the recorded grant; after `state.refuse` it answers `invalid_grant`.
- `google-userinfo`: `GET /oauth2/v1/userinfo` answers the recorded email.
- `google-project`: `POST /v1internal:loadCodeAssist` answers a recorded existing project; with `state.provision` it answers `allowedTiers` and `onboardUser` plus its operation poll answer the recorded project; with `state.ineligible` it answers `ineligibleTiers`.

## How to get to it (user POV)

- A test author starts `mockGoogle({ client })` from `@byokit/accounts/testing` and drives its endpoints with `fetch`; `mock.protocol` and `mock.answers` are the recorded facts that `fixtures/conformance/google-oauth-typescript.json` holds. There is no app screen to open yet.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md); no process of a previous drive is running.

- **Write the consumer.** Create `"$scratch_dir/verify-google.mjs"` importing `mockGoogle` from `@byokit/accounts/testing`. For each of `google-gemini-cli` and `google-antigravity`: start the mock, build a PKCE verifier/challenge, `fetch(mock.authorizeUrl({ redirectUri, state, codeChallenge }), { redirect: 'manual' })` and follow the `location` to the loopback callback; exchange the code, read userinfo, call `loadCodeAssist` (existing project, then `provision` for onboard + poll), refresh, then set `state.refuse`/`state.ineligible` and print each `invalid_grant` and `ineligibleTiers` answer. Call `await mock.close()` at the end.
- **Run and capture.** `feature=accounts-google; entry=@byokit/accounts/testing; drive=(node "$scratch_dir/verify-google.mjs")`, then run SKILL.md Evidence's capture block. Exit code `0`.
- **Happy path shows.** For both clients, the recorded `access_token`/`refresh_token`, the recorded `email`, the existing `recorded-project`, and the provisioned `recorded-project` from the onboard operation.
- **Error case shows.** The `400 invalid_grant` on a refused or reused refresh, and the `ineligibleTiers` answer for an individual account with no Code Assist tier.
- **Proof.** The captured artifact contains command output for the action and resulting state of every sub-feature above.

## Gotchas

- The stand-in answers on an OS-assigned loopback port; the client's real callback port (`8085`, `51121`) is a recorded fact in `mock.protocol.callback`, not a port the mock binds.
- It records no client id or client secret: the authorize URL uses a placeholder, and `fixtures/conformance/google-oauth-typescript.json` names the reuse rule without the values.
- `state.provision` and `state.ineligible` are switches for the two project outcomes; reset them between calls.
- There is no runtime sign-in or model adapter yet, so `mockGoogle()` proves the protocol and recorded answers only, never a live account.
