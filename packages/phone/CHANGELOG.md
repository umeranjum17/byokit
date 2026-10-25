# Changelog

## Unreleased

## 0.1.6 (2026-10-25)

- Dependency update: pins @byokit/accounts 0.34.0.

- DOCS: align npm descriptions, keywords and homepages with the BYOKit README.

## 0.1.5 (2026-10-24)

- Dependency update: pins @byokit/accounts 0.33.0.
- FIX: (from @byokit/accounts 0.33.0) an explicit "not logged in" reply still reads `signed_out`; a fresh managed account whose probe merely failed no longer looks revoked, and `remoteCliHost` still lets that account sign in again in place.
- SECURITY: (from @byokit/accounts 0.33.0) A missing or empty Pi model no longer falls back to a paid default. Pi launches require the model and selected account explicitly; ambient provider keys are never passed on. Offline admission and environment fixtures cover the guarded routes; live Herdr and raw pass-through qualification remain follow-ups.

## 0.1.4 (2026-10-24)

- Dependency update: pins @byokit/accounts 0.32.1.
- FIX: (from @byokit/accounts 0.32.1) Phone and browser apps using `keys().createModels({ authContext })` can now resolve and call vendor live-list model IDs, including OpenRouter IDs absent from the pinned catalogue, without registering their own providers or inventing model rows. API-key billing labels and selected-account key routes are unchanged.

## 0.1.3 (2026-10-24)

- Dependency update: pins @byokit/accounts 0.32.0.

## 0.1.2 (2026-10-24)

- Dependency update: pins @byokit/accounts 0.31.0.

## 0.1.1 (2026-10-20)

- Dependency update: pins @byokit/accounts 0.30.0.
- FIX: (from @byokit/accounts 0.30.0) `resolveModel` reports `listed: true` for an id an Anthropic Messages vendor's live list carries (MiniMax's `MiniMax-M3.1-Flash`), and for an OpenAI-style row that names no limits; before, only a row with limits counted.
- FIX: (from @byokit/accounts 0.30.0) A Pi launch no longer lets Pi pick its own default model for the provider (OpenRouter's was Kimi K2.6, run on a key nobody chose it for). `cliAccounts.launchArgs(id, model)` takes the model the caller chose and returns `['--provider', …, '--model', model]`, and throws "Choose a model for <provider> first" for a Pi row when none is given; `@byokit/decide/pi` likewise requires `model`.
- FIX: (from @byokit/accounts 0.30.0) BYOKit never exports a provider key into the systemd user environment, and `npm run check:user-env` now fails, naming each such variable (never its value) and the `systemctl --user unset-environment` command, when one is there; keys are read only by path through the kit.

- BREAKING: `PhoneSession.open({ ... })` now requires `model` for a ChatGPT account (a string id from `accounts.models()`); other accounts take a `Model<Api>` object. Pass `model: 'gpt-6-sol'` or similar for ChatGPT.

## 0.1.0 (2026-10-20)

- Dependency update: pins @byokit/accounts 0.29.0.

- FEATURE: `@byokit/phone`, the first slice of the phone-agent kit: `PhoneSession`, one agent chat that runs on the phone itself beside the Herdr panes of the person's computers. It answers from one account signed in through `@byokit/accounts` on the phone (a ChatGPT plan, or any typed route such as a per-use OpenRouter key) and never moves to another account; `account()` says how that account is billed in the catalogue's own sentence. The chat is an append-only log the app keeps (`PhoneLog`, `memoryLog()`), every step written before the next, so a killed app reopens with the turn `interrupted` (status `blocked`), a retried `requestId` never sends twice, and `resume()` finishes the turn: a tool cut off mid-run reruns only when it is `replaySafe`, otherwise the model is told it stopped. Portable: nothing from Node.
