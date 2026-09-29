# Changelog

## 0.4.0

- Each catalogue row carries its billing (`subscription`, `api`); show `billingWords(p)` next to every provider you list.
- FIX: OpenRouter (API billing) is no longer offered by default on computers; `offered()` without keys returns subscription rows only. Name it explicitly (`offer: ['openrouter']`) to keep offering it.
- FIX: a locked-keychain read (iOS returns "User interaction is not allowed" while the phone is locked) no longer signs the person out: `keepFresh` treats it as unknown and tries later, only a refused refresh fires `onExpired`.
- `secureStore(secure, name, options?)` passes `options` (e.g. `{ keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }`) to every keychain get, set and delete; the default is unchanged.
## 0.3.1

- `respond(member, { instructions, input, onText })` asks ChatGPT with the member's own sign-in, the answer streaming in over an injected `fetch` (whole answer at once when the fetch can't stream); limits and lapsed sign-ins are acted on as `failed()` does.
- FIX: a plain HTTP 429 or an undated `rate_limit_exceeded` is a temporary rate limit, not "plan doesn't include this"; a streamed error keeps its code.
- FIX: a refresh that fails on the network before asking is reported as network trouble; a refused refresh signs the account out.

## 0.3.0

- FIX: `@byokit/accounts/testing` `decoy()` now requires a caller-owned root; migrate from `decoy()` to `decoy(root)` and clean up that root when done.
