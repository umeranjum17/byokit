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
- [Accounts pick and models](./accounts-pick.md) — two signed-in ChatGPT accounts: `Accounts.pick` names the roomier one with its reason, `Accounts.models` lists each account's models, and a resting account's models say why and until when.
- [Catalogue device sign-in and the picker](./accounts-device.md) — RFC 8628 device sign-in for any provider the catalogue gives device data, with `mockDevice()`.
- [Google Cloud Code Assist sign-in and stand-in](./accounts-google.md) — on a computer, `Accounts.add('google-gemini-cli:browser'|':paste')` and `Accounts.add('google-antigravity:browser'|':paste')` with the `mockGoogle()` stand-in: PKCE, the loopback return to `:8085` (or `:51121` for Antigravity), or a pasted address, `list()` ready with the email, the Code Assist project discovered and kept as account metadata, refresh and logout that revokes at Google, `respond` streaming through `v1internal:streamGenerateContent` (403 tier refusal, 401 refresh-once, signed out), plus the identity replace/add rule, the busy-port wait, cancel, a refused refresh, a refused revoke and an ineligible individual account that keeps nothing.
- [Claude plan refresh](./accounts-claude-refresh.md) — a Claude plan sign-in kept through a lost refresh, rotated on retry, ended only by a revoked grant.
- [OpenClaw accepted/thinking run progress](./openclaw-run-progress.md) — built public API, real pinned Gateway + offline native CLI stand-in, timestamped progress/admission timeline and account-change refusal.
- [OpenClaw sealed sign-in recovery](./openclaw-auth-recovery.md) — wrong-seal failure retains original bytes; correct-seal retry, healthy restart and fail-closed refusals reach ready (or refuse) through a real spawned pinned engine with an offline native stand-in, plus supplied-gateway marker legs.
- [OpenClaw auth-store seal bound](./openclaw-seal-bound.md) — a killed host's large engine `state` stores (transcripts, media, SQLite) seal as their own objects outside the bounded credential blob and reopen byte for byte; regenerable `home` caches stay on disk; a credential file over the fixed cap refuses with `AuthStoreSealSizeError` naming size and cap, keeping the last good store as it was.
- [OpenClaw engine learning state](./openclaw-learning-state.md) — `learning()`/`setLearning()`/`restoreLearning()` on a stopped home: absence is a value, `propose` is visible, restores are byte for byte, refusals carry the real cause.
- [OpenClaw offered-route plugin allow](./openclaw-offered-allow.md) — `KitOptions.offered` puts an explicitly offered sign-in's plugin (OpenRouter) in `plugins.allow`; a defaults-only app does not get it.
- [OpenClaw engine-set freeze cost](./openclaw-engine-freeze.md) — clean first install freezes in seconds with no per-entry fsync; drift still rebuilds, torn sets never launch.
- [OpenClaw install drift diagnostics](./openclaw-install-drift-diagnostics.md) — a failed install or post-build verification retains the first failed check, npm path/version and npm stderr tail at `<stateDir>/logs/engine-install-drift.json` after the failed temp is deleted.
- [OpenClaw account words and restated account types](./openclaw-account-words.md) — the built `@byokit/openclaw` publishes the restated `Account`/`AccountPick`/`Considered`/`RunSelection`/`MoveResult` shapes and the section 5.15 account sentences; a plain consumer reads them and a `%` scan keeps the percent sign out of `words.json`.
- [OpenClaw pure account pick with bound](./openclaw-pick.md) — the built `resolveSelection` replays the shared parity table through the published entry and proves the kit-only `bound` extremes: an explicit signed-out id is chosen and never replaced, and a default outside `bound` is refused and falls back to Auto.
- [Machine store shared across apps](./accounts-machine-store.md) — a second app process is signed in already from the computer's machine store; a wrong seal and a missing store are refused.
- [ChatGPT refresh refusal](./accounts-refresh-refusal.md) — a phone/browser ChatGPT sign-in kept through a passing 401 at a due or forced refresh, ended only by a revoked grant.
- [Usage plan view](./usage-planview.md) — `@byokit/usage` selectors over fixture call records via `examples/usage-demo.ts`.
- [Usage preflight](./usage-preflight.md) — `@byokit/usage` reports a call's cost ceiling from the app's own prices and the remaining allowance before it is sent, declining a costly call and refusing to guess on unknown cases.
- [Dictation live preview](./dictation-live-preview.md) — `@byokit/dictation`'s live preview drops a shown silence sentinel as soon as words arrive, keeps a silence-only take's sentinel, and never retracts real shown words.
- [Dictation live preview decode](./dictation-preview-decode.md) — a live preview decodes greedily over a bounded recent window; a final keeps the host's beam and whole-recording windows.
- [Fresh-project pack gate](./pack-fresh-project.md) — `npm run smoke:pack`: install packed tarballs into a scratch app and import them.
- [Gmail send](./connect-mail-send.md) — `@byokit/connect` `MailSender` with fixture OAuth and a canned Gmail transport: approved, denied and missing-scope legs.
- [House Google client file](./connect-house-client.md) — `googleClientFile` from `@byokit/connect/node` feeding a loopback Gmail sign-in and send: missing, refused, consent approved/denied and send approved/denied legs.
- [Herdr task-owned HOME](./herdr-task-home.md) — `@byokit/herdr` `startAgent` with a task HOME on a real, isolated Herdr lab session (needs the environment's Herdr lab helper; never the person's own Herdr).
- [Pair compact QR crash-resume](./pair-compact-resume.md) — a phone killed during approval resumes from its pending grant against the pinned computer (compact and v1 QRs); an impostor at the same address is refused; the compact token stays 109 characters.
- [Relay notification action replies](./relay-action-reply.md) — the built `@byokit/relay` action route forwards a bounded opaque sealed reply to the host unchanged, refuses malformed or oversized replies without spending the token, and stores nothing.
- [PWA review evidence](./pwa-review-evidence.md) — frames and motion for a user-visible change, in every theme and form factor the app has.
- [Dictation long-take windows](./dictation-whisper-windows.md) — the built `@byokit/dictation` whisper.rn engine steps long-take windows from where the decoder stopped and joins the overlap once, driven by a stubbed decoder over synthetic WAV audio.

## Not provable here (declare honestly, do not fake)

- **Browser/PWA surface** (`examples/pwa`): needs Chromium via Playwright; drive only when the environment provides it (`npm run test:browser`, and the review-evidence capture, which brings its own Chromium fallback).
- **React Native / Expo** (`examples/expo`): runtime proof needs a configured emulator/device; see `CONTRIBUTING.md` for the existing bundle and emulator checks. Declare runtime proof unavailable when that prerequisite is unmet. Its screens' phone frames and motion need that same device, so they are not captured from the web app instead.
- **Android mirror** (`android/`): needs `JAVA_HOME`/`ANDROID_HOME`; `android/test.sh` covers it where configured.
- **Real providers** (ChatGPT, Claude, …): no credentials, no egress, per repo test contract (`scripts/test-egress-guard.cjs`).

## Feature entry contract

Each feature file starts with an H1 title and one paragraph of user-visible behavior, then exactly four H2 sections in order: `Sub-features`, `How to get to it (user POV)`, `Driving it with node scratch consumers`, `Gotchas`.

## Features

- [openclaw-abort](./openclaw-abort.md) — healthy real-engine cancellation, engine-drop and already-gone catchable failures, invalid key mapping, no unhandled rejection in the handled consumer journey.

- [accounts-signin](./accounts-signin.md) — device-code sign-in, status, streamed ask, and the error paths.
- [accounts-pick](./accounts-pick.md) — `pick`/`models` over two real accounts: roomier winner with reason, a rest moving the pick, per-account model availability, and the unknown-id and no-reading cases.
- [accounts-device](./accounts-device.md) — the provider picker and a catalogue-driven device sign-in, refresh and decline.
- [accounts-google](./accounts-google.md) — the Gemini Code Assist browser/paste sign-in through the built `Accounts` and the two clients' offline protocol with `mockGoogle()`: PKCE, callback, exchange/refresh, userinfo, sign-out revoke and project answers, plus respond through `v1internal:streamGenerateContent` (403 tier refusal, 401 refresh-once then signed out), busy-port, cancel, invalid_grant, refused revoke and ineligible.
- [accounts-claude-refresh](./accounts-claude-refresh.md) — transient refresh (no answer, 5xx, passing 401) keeps the sign-in, retry rotates the same grant, invalid_grant signs out.
- [accounts-refresh-refusal](./accounts-refresh-refusal.md) — passing 401 at `access` or `recheck` keeps the ChatGPT sign-in, retry rotates, a revoked grant signs out.
- [openclaw-auth-recovery](./openclaw-auth-recovery.md) — fail-closed startup, retained original and original-key retry through the built OpenClaw kit.
- [openclaw-install-drift-diagnostics](./openclaw-install-drift-diagnostics.md) — forced fixture-package drift through the built kit's `prepare()` retains every diagnostics field.
- [accounts-machine-store](./accounts-machine-store.md) — one sign-in reused by a second app through `machineStore`, wrong-seal and no-store refusals.
- [usage-planview](./usage-planview.md) — plan/quota view rendered from call records.
- [usage-preflight](./usage-preflight.md) — preflight cost ceiling, remaining allowance, declined costly call, and explicit-unknown cases.
- [dictation-live-preview](./dictation-live-preview.md) — a shown silence sentinel drops when words arrive, a silence-only take keeps it, and real shown words are never retracted.
- [dictation-preview-decode](./dictation-preview-decode.md) — previews decode greedily over a bounded recent window, finals keep the host beam and whole recording.
- [pack-fresh-project](./pack-fresh-project.md) — the packed-tarball fresh-consumer gate.
- [connect-mail-send](./connect-mail-send.md) — one approval per message, denial without a request, `gmail.send` scope refusal.
- [connect-house-client](./connect-house-client.md) — the house Google client file: missing/refused files, consent approve/deny, send approve/deny.
- [herdr-task-home](./herdr-task-home.md) — an agent pane under a task-owned HOME, read from the agent process and from inside the pane.
- [pair-compact-resume](./pair-compact-resume.md) — compact/v1 QR kill-during-approval resume, impostor refusal, compact token size and terminal QR.
- [relay-action-reply](./relay-action-reply.md) — the relay action route carries a bounded opaque sealed reply to the host callback, refuses bad replies and stores nothing.
- [dictation-whisper-windows](./dictation-whisper-windows.md) — long-take automatic windows step from the decoded end (no skip at a pause) and the overlap is joined once (no repeated passage), plus the 30 s-or-shorter and silent-gap extremes.
- [pwa-review-evidence](./pwa-review-evidence.md) — the review-evidence capture: before/after frames per theme and form factor, one motion recording per changed interaction.
