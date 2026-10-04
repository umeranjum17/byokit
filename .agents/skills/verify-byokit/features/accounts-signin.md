# Accounts sign-in and ask

A consumer app signs a member into ChatGPT by device code against the loopback stand-in, reads the connected status, and asks a question that streams back — the `@byokit/accounts` README quickstart, driven against the built package.

## Sub-features

- `signin-code`: `login` shows a waiting device code; approving it on the provider page completes the sign-in.
- `signin-status`: `status` reports `ready` with human words after `finished`.
- `signin-ask`: `respond` streams the answer and returns the final text.
- `signin-errors`: a provider not offered rejects; asking with no sign-in raises `ResponseError`.

## How to get to it (user POV)

- The consumer app constructs `new Accounts({ authBase, apiBase, offer }, portable)` with `mockOpenAI()`'s base URLs, calls `login(1, 'chatgpt')`, shows the code, then `finished`/`status`/`respond` (README "Quickstart").

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md); no process of a previous drive is running.

- **Write the consumer.** Create `scratch/verify-accounts-signin.mjs` importing `Accounts, portable` from `@byokit/accounts` and `mockOpenAI` from `@byokit/accounts/testing`, exactly as the SKILL.md Drive section and the README quickstart show, including both error cases (`offer: ['chatgpt']` then `login(1, 'grok')`; a bare `Accounts` instance calling `respond` with no sign-in) and `await openai.close()` at the end.
- **Run and capture.** `node scratch/verify-accounts-signin.mjs 2>&1 | tee .verify-artifacts/accounts-signin/drive.txt; echo "EXIT=$?"`. Exit code `0`.
- **Happy path shows.** `signin: waiting code MOCK-1000…`, `status: ChatGPT is connected.`, the streamed `You said: <input>` and `final: You said: <input>`.
- **Error cases show.** `not-offered error: AI account not offered here` and `missing-signin error: ResponseError ChatGPT isn't signed in yet.`
- **Proof.** The tee'd artifact contains command output for the action and resulting state of every sub-feature above.

## Gotchas

- The code is `MOCK-1000…` because the stand-in issues it; a real provider's code differs in shape only.
- `openai.approve(shown.code)` plays the person typing the code; without it `finished` never resolves.
- The in-memory default store means concurrent runs cannot interfere; still give each run its own `scratch/` file and evidence dir.
- `respond` with `onText` streams to stdout — capture must include the streamed fragment, not only the final line.
