# Changelog

## Unreleased

- FIX: a cut-off answer is now reported as cut off: `respond` throws `IncompleteError` with its reason and partial output, and notifies `onEvent`, instead of returning it as finished.

## 0.7.0 (2026-09-30)

- Add the portable `chatgptPlan` adapter for a host-validated official token-sharing session, checking
  ChatGPT plan usage consent on every access. Uses subscription billing and never falls back to an API key
  (billed per use); the host owns sign-in, identity verification, storage and refresh per person.

## 0.6.0 (2026-09-30)

- `respond` and `Accounts.respond` accept `originator` (or set it once on `Accounts`): the app's own originator header value. Default: 'byokit', as before.
- FIX: a garbled streamed answer no longer arrives as an empty string with HTTP 200: a data line the parser cannot read now throws a ResponseError the app can show.
- FIX: a stream that ends with no words, no completed answer and no tool calls now throws instead of resolving to an empty string.
- FIX: the answer is the words as they streamed in; the completed envelope is only used when nothing streamed. Apps whose completed envelope carries no text no longer see their streamed words replaced by an empty answer.
- FIX: streamed answers split on bare-CR line endings too, so a backend that separates events with carriage returns no longer yields an empty answer.

- `respond` passes the whole question through: a message array (many turns, pictures with `input_image`, a `function_call` with its `function_call_output`), `tools` and `tool_choice` (the app's own function tools and built-ins, including `image_generation`), how hard the model thinks (`reasoning.effort`), and how long the answer is with the shape it must follow (`text.verbosity`, `text.format`). With `tools` the result is the text with every output item (`isFunctionCall` spots a call); without, the plain text as before. `onEvent` sees each tool call and output item as it streams.

## 0.4.1 (2026-09-29)

- FIX: the packed `dist/words.d.ts` keeps `with { type: 'json' }` on its `./words.json` import, so a strict NodeNext consumer with `skipLibCheck: false` no longer fails with TS1543.

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
