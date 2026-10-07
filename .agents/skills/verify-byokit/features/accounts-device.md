# Catalogue device sign-in and the picker

A consumer app offers the person every provider the accounts catalogue can sign in to on this device, picks one, and completes its RFC 8628 device sign-in: the code appears, the person approves it on their own phone, and the sign-in lands in that member's store — all against a loopback stand-in, with no provider of its own in the code.

## Sub-features

- `device-picker`: `accounts.providers` (and `signInChoices()`) list every provider the device can sign in to, in catalogue order; a provider joins by catalogue `device` data alone.
- `device-signin`: `login` shows a waiting device code and the provider's page; approving the code there finishes the sign-in and `status` reads `ready`.
- `device-refresh`: a token that dies is refreshed on the provider's own token endpoint, so `status` stays `ready`.
- `device-kept-grant`: a provider that keeps its grant (answers a refresh with no new refresh token, `mockDevice({ rotate: false })`) stays `ready` refresh after refresh; a revoked grant still ends at `needs_again`.
- `device-declined`: declining on the provider's page keeps nothing and says so in one sentence.

## How to get to it (user POV)

- The consumer app constructs `new Accounts({ deviceBase }, portable)` against `mockDevice()`'s base, reads `accounts.providers`, calls `login(1, key)` for the chosen one, shows `view.code`/`view.url`, and the person approves at the provider's page; then `finished`, `status`, `keepFresh`, `logout`.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md); no process of a previous drive is running.

- **Write the consumer.** Create `"$scratch_dir/verify-accounts-device.mjs"` importing `Accounts, portable, signInChoices` from `@byokit/accounts` and `mockDevice` from `@byokit/accounts/testing`. Print the picker, sign in with `grok` and with `kimi` (approve each code at the stand-in), print `status` for each, run `keepFresh` and print the refresh request the stand-in saw; repeat the sign-ins against `mockDevice({ expiresIn: 1, rotate: false })`, run `keepFresh` three times and print each `status`; then clear `device.state.live` (the provider revokes) and print `status` after one more `keepFresh`; then start one sign-in and decline it, printing `view().error`. Call `await device.close()` at the end.
- **Run and capture.** `feature=accounts-device; entry=@byokit/accounts; drive=(node "$scratch_dir/verify-accounts-device.mjs")`, then run SKILL.md Evidence's capture block. Exit code `0`.
- **Happy path shows.** `picker: grok,kimi`, a `FIXTURE-` code with the stand-in's `/activate` page for each provider, `status: ready` for both, a `grant_type=refresh_token` request, and `ready` after every refresh from the kept-grant stand-in.
- **Error case shows.** `needs_again` after the kept grant is revoked, the declined sign-in's one-sentence error, and `status` still `signed_out`.
- **Proof.** The captured artifact contains command output for the action and resulting state of every sub-feature above.

## Gotchas

- `deviceBase` replaces each provider's own host while keeping its documented paths, so the stand-in answers `/oauth2/device/code` and `/oauth2/token` as well as Kimi's.
- The stand-in rotates the refresh token on every answer by default; `rotate: false` keeps the grant live and answers refresh with a new access token only.
- The default store is in memory, so a declined or cancelled sign-in leaves nothing behind for anyone.
- `signInChoices()` is catalogue data only: no network, no credentials, no readiness claim.
