# Accounts pick and models

A consumer app with two signed-in ChatGPT accounts asks `Accounts.pick` which account a run should use, sees the roomier one named with its reason, and reads each account's models through `Accounts.models` — all against the built `@byokit/accounts` and the loopback stand-in.

## Sub-features

- `pick-auto`: with two ready accounts and a room reading each, `pick(member, { account: 'auto' }, room)` names the roomier account and its catalogue model, with the `auto.room` reason.
- `pick-after-rest`: after `failed(member, id, 429)`, only that account rests, and the next Auto names the other.
- `rest-next-reset`: `failed(member, id, "… usage limit. Next reset in 4 hours, 3:00 PM.")` rests that account until the stated reset (~4h), not the 60-minute fallback; the same wording with no number falls back to 60 minutes.
- `models-ready`: `models(member, id)` lists the catalogue's strong/fast models, `available: true`.
- `models-resting`: for the resting account, every model is `available: false`, `why: 'resting'`, with `until`.
- `pick-unknown-id`: an id not in the list returns `ok: false`, `code: 'unknown_account'`; `models` refuses it.
- `pick-no-reading`: a `room` source absent leaves every reading unknown, so list order decides.

## How to get to it (user POV)

- The app constructs `new Accounts({ authBase, apiBase, app, store: () => memoryStore() }, portable)` with `mockOpenAI()`'s base URLs, signs in two identities with `add`/`finished`, renames the second `Work`, then calls `pick` before a run and `models` for a chosen account.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md); no process of a previous drive is running.

- **Write the consumer.** Create `"$scratch_dir/verify-accounts-pick.mjs"` importing `Accounts, memoryStore, portable, ResponseError` from `@byokit/accounts` and `mockOpenAI` from `@byokit/accounts/testing`. Sign in `umer-personal` (plus) and `umer-work` (team) into one `memoryStore`, rename the second `Work`, then print the `models` rows, the `pick` on rooms work 60 / personal 30, the `pick` after `failed(member, work, new ResponseError('429 …', 'rate_limit', …))`, the resting account's `models`, an explicit unknown id, an absent-room pick, the `models` refusal, and the rest after `failed(member, personal, "You've reached your Codex subscription usage limit. Next reset in 4 hours, 3:00 PM.")`. `await openai.close()` in a `finally`.
- **Run and capture.** `feature=accounts-pick; entry=@byokit/accounts; drive=(node "$scratch_dir/verify-accounts-pick.mjs")`, then run SKILL.md Evidence's capture block. Exit code `0`.
- **Happy path shows.** `pick: Work gpt-6-sol - Right now that's Work: 60% left this week`, and `models ready: [["gpt-6-sol","strong",true],["gpt-6-luna","fast",true]]`.
- **Rest and error cases show.** `after limit: Personal`; `next reset: +240min, future=true`; `resting models: gpt-6-sol:resting:true, gpt-6-luna:resting:true`; `unknown id: unknown_account`; `no readings: Personal`; `models unknown id error: No such account.`.
- **Proof.** The captured artifact contains command output for the action and resulting state of every sub-feature above.

## Gotchas

- The identity fixture uses `umer-personal` / `umer-work`; changing `openai.state` between sign-ins is what makes the second identity a separate account.
- `pick` takes one reading per account through the `room` callback; the callback receives the account row, so key it by `account.id`.
- `failed` rests only the named account; `models` then reads `resting` from that row's `state` and its `until`.
- The unknown-id and absent-room cases print from the same list; keep their output distinct so the artifact shows each.
