# Changelog

## Unreleased

## 0.1.0 (2026-10-20)

- Dependency update: pins @byokit/accounts 0.29.0.

- FEATURE: `@byokit/phone`, the first slice of the phone-agent kit: `PhoneSession`, one agent chat that runs on the phone itself beside the Herdr panes of the person's computers. It answers from one account signed in through `@byokit/accounts` on the phone (a ChatGPT plan, or any typed route such as a per-use OpenRouter key) and never moves to another account; `account()` says how that account is billed in the catalogue's own sentence. The chat is an append-only log the app keeps (`PhoneLog`, `memoryLog()`), every step written before the next, so a killed app reopens with the turn `interrupted` (status `blocked`), a retried `requestId` never sends twice, and `resume()` finishes the turn: a tool cut off mid-run reruns only when it is `replaySafe`, otherwise the model is told it stopped. Portable: nothing from Node.
