# byokit verification map

The maintained source for verifying the user-facing behavior of the built byokit SDK. Read this index before driving, then use the matching feature file as the recipe.

## Baseline preconditions

- Worktree root of a byokit checkout on the branch under test.
- `npm run build` exited 0 (see SKILL.md Launch; deps via `npm ci` in a fresh worktree).
- Doctor (SKILL.md) prints the version and resolves `@byokit/accounts` inside `packages/*/dist`.
- Scratch consumers in the exclusive `$scratch_dir` created by SKILL.md Drive, evidence in an exclusive run directory under `.verify-artifacts/<feature>/`; the latter survives cleanup.
- Loopback stand-ins only (`mockOpenAI()`); never a real provider, account or credential.

## Driving conventions

- Start every recipe from the baseline; write the scratch consumer fresh from the feature file.
- Import public entries only; treat every command in a feature file as literal.
- Set `feature`, `entry` and `drive` as the recipe specifies, then use SKILL.md Evidence’s Bash capture block to record the invoked command and actual exit code.
- A drive that cannot show its output (or whose evidence file is missing after cleanup) is not a proof.
- A user-visible change is proved by SKILL.md's review-evidence capture, not by hand: every changed screen before and after, in every theme and form factor the app has, plus one motion recording per changed interaction. A theme, form factor or screen the app does not have is written down in `manifest.json` with its reason; where the capture cannot reach a proof the reviewer asked for, extend the capture instead of capturing around it.
- Report an unreachable surface (browser, React Native, Android, real provider) as unavailable with the attempted entry and the unmet precondition; never as verified through a different path.

## Available on this host

- [Accounts sign-in and ask](./accounts-signin.md) — the README quickstart against the built `@byokit/accounts` with `mockOpenAI()`.
- [Usage plan view](./usage-planview.md) — `@byokit/usage` selectors over fixture call records via `examples/usage-demo.ts`.
- [Fresh-project pack gate](./pack-fresh-project.md) — `npm run smoke:pack`: install packed tarballs into a scratch app and import them.
- [PWA review evidence](./pwa-review-evidence.md) — frames and motion for a user-visible change, in every theme and form factor the app has.

## Not provable here (declare honestly, do not fake)

- **Browser/PWA surface** (`examples/pwa`): needs Chromium via Playwright; drive only when the environment provides it (`npm run test:browser`, and the review-evidence capture, which brings its own Chromium fallback).
- **React Native / Expo** (`examples/expo`): runtime proof needs a configured emulator/device; see `CONTRIBUTING.md` for the existing bundle and emulator checks. Declare runtime proof unavailable when that prerequisite is unmet. Its screens' phone frames and motion need that same device, so they are not captured from the web app instead.
- **Android mirror** (`android/`): needs `JAVA_HOME`/`ANDROID_HOME`; `android/test.sh` covers it where configured.
- **Real providers** (ChatGPT, Claude, …): no credentials, no egress, per repo test contract (`scripts/test-egress-guard.cjs`).

## Feature entry contract

Each feature file starts with an H1 title and one paragraph of user-visible behavior, then exactly four H2 sections in order: `Sub-features`, `How to get to it (user POV)`, `Driving it with node scratch consumers`, `Gotchas`.

## Features

- [accounts-signin](./accounts-signin.md) — device-code sign-in, status, streamed ask, and the error paths.
- [usage-planview](./usage-planview.md) — plan/quota view rendered from call records.
- [pack-fresh-project](./pack-fresh-project.md) — the packed-tarball fresh-consumer gate.
- [pwa-review-evidence](./pwa-review-evidence.md) — the review-evidence capture: before/after frames per theme and form factor, one motion recording per changed interaction.
