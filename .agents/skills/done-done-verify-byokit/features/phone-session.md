# Phone session: sign in, chat with tools, killed app, Try again

`@byokit/phone`'s `PhoneSession` is an agent chat that runs on the phone itself, answering from one account signed in
through `@byokit/accounts` on the phone. Every step goes to the app's own log before the next one, so a killed app
reopens with the turn `interrupted`, nothing reruns by itself, and `resume` finishes it.

## Sub-features

- `billing-label`: `account()` reads `billing: 'subscription'`, "Uses your ChatGPT plan." for a ChatGPT sign-in.
- `tool-turn`: a turn calls the app's tool and ends `done` with the model's answer.
- `kill-reopen`: a real process killed (SIGKILL) while its non-replay-safe tool runs leaves the turn `interrupted` and
  the session `blocked` when another process reopens the same log file; `resume` finishes it with no second tool run.
- `request-id`: sending a finished `requestId` again makes no model request.
- `limit` (error case): a 429 from the plan ends the turn `failed`, `code: 'rate-limited'`, its words, one request only.

## How to get to it (user POV)

- Muxr's "Just this phone": the person signs in to their AI account on the phone, chats, the phone kills the app,
  they reopen it and tap Try again.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md), plus the built `@byokit/phone` and `@byokit/accounts`.

- **Write the consumer.** `"$scratch_dir/verify-phone-session.mjs"` imports `PhoneSession` from `@byokit/phone`,
  `Accounts`, `memoryStore`, `portable` from `@byokit/accounts` and `mockOpenAI` from `@byokit/accounts/testing`.
  A file `PhoneLog` (read lines, append one line, delete) over a log path under `$scratch_dir`. With an argument
  `child <base> <log>` it is the app: it signs in by device code, approves its own code by POSTing `user_code` to
  `<base>/codex/device` (the stand-in's page), keeps itself alive (`setInterval`, as an app is), opens a session whose one tool `save_note` (not replay safe) appends
  to a runs file and then never returns, and sends `remember the milk` as `r1`. Without arguments it is the lab:
  it starts `mockOpenAI()`, spawns the child, waits for a `tool-start` line in the log, sends SIGKILL, then signs in
  again (the relaunched app) and reopens the same log: print `turns[0].state`, `status`, the tools' states, then
  `resume('r1')` and print the state, answer, the runs-file count and the stand-in's `/codex/responses` count; send
  `r1` again and print the count (unchanged). Then `account()`, and the limit leg: set `state.fail` to a 429
  `usage_limit_reached` body, send, print `state`, `code`, `words` and the request count. Exit non-zero on any
  mismatch.
- **Run and capture.** `feature=phone-session; entry=@byokit/phone; drive=(node "$scratch_dir/verify-phone-session.mjs")`,
  then run SKILL.md Evidence's capture block. Exit code `0`.

## Gotchas

- Import only public entries; never `packages/phone/src`.
- The kill must be a real SIGKILL of a separate process: an abort in the same process proves less.
- Non-visual change: no screenshots. Loopback stand-in only; no network, no real account.
