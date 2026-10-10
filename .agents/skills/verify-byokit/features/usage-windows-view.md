# Usage windows view

`windowsView(reading, nowMs)` from the built `@byokit/usage/view` lists every usage window an account's reading carries — the session and weekly windows Claude and Codex report — tightest first, each with its unchanged millisecond `resetsAt`, a usage line such as “Week: 58% left”, a reset line such as “resets in 4h 40m”, and an as-of age taken only from `Reading.at` (“Read {ago} ago”, “Reading time unknown” without one, no age for a future one).

## Sub-features

- `usage-windows-two`: a Claude or Codex reading gives both the session and the weekly window, ordered tightest (highest used percent) first.
- `usage-windows-reset`: each line carries its millisecond `resetsAt` unchanged from the reading, plus `text` and `resetText`.
- `usage-windows-age`: the age comes only from `Reading.at`; without one the text is “Reading time unknown”; a future `at` carries no age.
- `usage-windows-stale`: a reading older than 24h is marked `stale` while keeping its numbers; a window without a used percent reads “amount unknown”.

## How to get to it (user POV)

- The consumer imports `{ usage }` from `@byokit/usage` and `{ windowsView }` from `@byokit/usage/view`, reads with its own injected transport (or an app-server fake), then renders `view.windows` and `view.ageText`. The kit owns parsing, ordering, reset and age; the app owns sign-in and rendering.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md).

- **Write the consumer.** `"$scratch_dir/verify-windows.mjs"` importing `{ usage }` from `@byokit/usage` and `{ windowsView }` from `@byokit/usage/view`. Inject a `fetch` returning a canned Claude `five_hour`/`seven_day` body. Read `{ provider: 'claude', access: 'synthetic-token', accountId: 'demo' }` at a fixed `nowMs`, call `windowsView`, and print the windows’ `kind`/`usedPercent`/`resetsAt`/`text`/`resetText` and the `ageText`. Assert: two windows, weekly first, millisecond resets unchanged, “Read a moment ago”. Then call `windowsView({ provider: 'claude', windows: [] }, nowMs)` (no `at`) and assert `ageText === 'Reading time unknown'`; read a disconnected source and print its typed `code` (`not-connected`) as the missing case.
- **Run and capture.** `feature=usage-windows-view; entry=@byokit/usage/view; drive=(node "$scratch_dir/verify-windows.mjs")`, then run SKILL.md Evidence’s capture block. Exit code `0`.
- **Read the result.** Two window lines print tightest first with their millisecond resets, the age reads “Read a moment ago”, the undated view reads “Reading time unknown”, and the disconnected read reports `not-connected`.

## Gotchas

- Import the built entries (`@byokit/usage`, `@byokit/usage/view`); never `packages/usage/src`.
- The age is never guessed from file mtime, the poll time or the client clock — only `Reading.at`; an undated or future reading keeps unknown/no age while still listing windows.
- A stale reading still lists its measured windows; `stale` does not blank the numbers.
- No server to clean up — use SKILL.md Cleanup to remove only `"$scratch_dir"` and confirm the captured evidence survives.
