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
- [Accounts key route on a Hermes runtime](./accounts-hermes-throwifaborted.md) — the built portable entry answers `openrouter:key` with `AbortSignal.prototype.throwIfAborted` deleted (Hermes), and an aborted signal still rejects as aborted.
- [Accounts pick and models](./accounts-pick.md) — two signed-in ChatGPT accounts: `Accounts.pick` names the roomier one with its reason, `Accounts.models` lists each account's models, and a resting account's models say why and until when.
- [UI account rows and name suggestions](./ui-account-rows.md) — the built `@byokit/ui/accounts` turns a real two-account ChatGPT `list()` and room readings into plain rows (`ChatGPT · Work` / `Plus · 72% left this week`), honest words per sign-in state, `low` at exactly 20, both usage windows with their resets and age (stale never low), untaken name suggestions, and no credential in a row.
- [UI run picker and Move target](./ui-model-picker.md) — the built `@byokit/ui/accounts` `modelPicker`/`bestMoveTarget` over the shared parity table: the `Auto — most room left` row with the pick's reason, per-account model rows, a signed-out pick that says `Sign in first` and never falls back, Auto disabled typed, and the Auto-ordered move target (undefined with nowhere to move).
- [UI account hooks over live back ends](./ui-account-hooks.md) — the built `@byokit/ui` `useAccounts`/`useModelPicker` with real React over a real two-account ChatGPT `list()` and a real `cliAccounts()` kit: live refresh, explicit select kept across refreshes, a failing room leaving only its row unknown, and a mid-refresh removal dropping the row.
- [Catalogue device sign-in and the picker](./accounts-device.md) — RFC 8628 device sign-in for any provider the catalogue gives device data, with `mockDevice()`.
- [Google Cloud Code Assist sign-in and stand-in](./accounts-google.md) — on a computer, `Accounts.add('google-gemini-cli:browser'|':paste')` and `Accounts.add('google-antigravity:browser'|':paste')` with the `mockGoogle()` stand-in: PKCE, the loopback return to `:8085` (or `:51121` for Antigravity), or a pasted address, `list()` ready with the email, the Code Assist project discovered and kept as account metadata, refresh and logout that revokes at Google, `respond` streaming through `v1internal:streamGenerateContent` (403 tier refusal, 401 refresh-once, signed out), plus the identity replace/add rule, the busy-port wait, cancel, a refused refresh, a refused revoke and an ineligible individual account that keeps nothing.
- [Claude plan refresh](./accounts-claude-refresh.md) — a Claude plan sign-in kept through a lost refresh, rotated on retry, ended only by a revoked grant.
- [Claude plan respond select](./accounts-claude-respond-select.md) — two Claude plan accounts: `respond({ provider: 'claude', select })` answers from the selected account's own bearer, a 429 rests only it, and its expiry signs out only it with the primary ready.
- [Managed CLI launch and move refusals](./accounts-cli-launch.md) — built Accounts launch and Herdr move, isolated native CLI process plus socket Herdr stand-in: typed refusals, no pane creation/default probe, and managed-folder sign-out races.
- [Managed CLI logins](./accounts-cli-logins.md) — two built `@byokit/accounts/cli` managed logins with the same email come back with different `addedAt` from fake native binaries, no credential or network read.
- [Remote agent-CLI sign-in](./accounts-cli-remote-signin.md) — built `@byokit/accounts/cli` reports read-only CLI state and relays a device code / link-and-paste-code over a paired link from fake native binaries, plus a live read-only run against the real CLIs with no sign-in performed.
- [OpenClaw accepted/thinking run progress](./openclaw-run-progress.md) — built public API, real pinned Gateway + offline native CLI stand-in, timestamped progress/admission timeline and account-change refusal.
- [OpenClaw sealed sign-in recovery](./openclaw-auth-recovery.md) — wrong-seal failure retains original bytes; correct-seal retry, healthy restart and fail-closed refusals reach ready (or refuse) through a real spawned pinned engine with an offline native stand-in, plus supplied-gateway marker legs.
- [OpenClaw auth-store seal bound](./openclaw-seal-bound.md) — a killed host's large engine `state` stores (transcripts, media, SQLite) seal as their own objects outside the bounded credential blob and reopen byte for byte; regenerable `home` caches stay on disk; a credential file over the fixed cap refuses with `AuthStoreSealSizeError` naming size and cap, keeping the last good store as it was.
- [OpenClaw engine learning state](./openclaw-learning-state.md) — `learning()`/`setLearning()`/`restoreLearning()` on a stopped home: absence is a value, `propose` is visible, restores are byte for byte, refusals carry the real cause.
- [OpenClaw member auth isolation](./openclaw-member-isolation.md) — on the real pinned engine, a pre-O14 two-member home boots with `authInheritance` forced to `byokit-base`: the never-signed-in member reads signed out and its explicit pick ends `signed-out` with no model request, its sign-out leaves the other member's store byte for byte, and D9 refuses new `--` members while an existing `a--b` still runs.
- [OpenClaw offered-route plugin allow](./openclaw-offered-allow.md) — `KitOptions.offered` puts an explicitly offered sign-in's plugin (OpenRouter) in `plugins.allow`; a defaults-only app does not get it.
- [OpenClaw engine-set freeze cost](./openclaw-engine-freeze.md) — clean first install freezes in seconds with no per-entry fsync; drift still rebuilds, torn sets never launch.
- [OpenClaw install drift diagnostics](./openclaw-install-drift-diagnostics.md) — a failed install or post-build verification retains the first failed check, npm path/version and npm stderr tail at `<stateDir>/logs/engine-install-drift.json` after the failed temp is deleted.
- [OpenClaw account words and restated account types](./openclaw-account-words.md) — the built `@byokit/openclaw` publishes the restated `Account`/`AccountPick`/`Considered`/`RunSelection`/`MoveResult` shapes and the section 5.15 account sentences; a plain consumer reads them and a `%` scan keeps the percent sign out of `words.json`.
- [OpenClaw pure account pick with bound](./openclaw-pick.md) — the built `resolveSelection` replays the shared parity table through the published entry and proves the kit-only `bound` extremes: an explicit signed-out id is chosen and never replaced, and a default outside `bound` is refused and falls back to Auto.
- [OpenClaw add a second ChatGPT account](./openclaw-add-account.md) — built `kit.addAccount` puts a member's second ChatGPT account on its own sealed `m1--<hex6>` agent with `prompt=login`, IDENTITY.md byte-identical; a cancelled sign-in leaves no agent or entry and an API-key choice is refused.
- [OpenClaw run on an account](./openclaw-account-run.md) — built `kit.run({ account })` on an unbound key: the account event first, Auto by room on the account agent's own key, a resting end skipped by the next Auto, and a signed-out chosen account or an empty pick ending `signed-out` with no agent request.
- [OpenClaw OpenCode Go plan key](./openclaw-go-plan-key.md) — built `kit.addAccount` pastes a Go plan key into typed activation; the first run after `done` streams on the plan with usage (offline fake, or `--live` on the real engine); an engine-refused choice reads `no_upstream_flow` and fails with the engine's words.
- [Machine store shared across apps](./accounts-machine-store.md) — a second app process is signed in already from the computer's machine store; a wrong seal and a missing store are refused.
- [ChatGPT refresh refusal](./accounts-refresh-refusal.md) — a phone/browser ChatGPT sign-in kept through a passing 401 at a due or forced refresh, ended only by a revoked grant.
- [Usage plan view](./usage-planview.md) — `@byokit/usage` selectors over fixture call records via `examples/usage-demo.ts`.
- [Cloud M6 physical-phone lab](./cloud-m6-phone.md) — explicit native trial-only create/install/pair/one phone-local agent turn/stop; approved USB stdin key import and verified removal, real phone captures, no computer proxy. Not the full two-adapter M6 or a publishing claim.
- [Cloud boat adapter](./cloud-boat-v1.md) — the built `@byokit/cloud` `boat()` against the loopback bench speaks the public boat-v1 names: `user.id`, nested `sandbox`/`operation`/`snapshot`, `X-Ascii-Confirm-Delete`, `encoding: 'base64'`, `plan` over `limits.info`, and no guessed `key`/`why`.
- [Usage preflight](./usage-preflight.md) — `@byokit/usage` reports a call's cost ceiling from the app's own prices and the remaining allowance before it is sent, declining a costly call and refusing to guess on unknown cases.
- [Usage Claude explicit-file guard](./usage-claude-file-guard.md) — `@byokit/usage` refuses a Claude `credentialsFile`/`configFile`/`statuslineFile` that carries a `.claude`/`.codex`/`.pi` segment, lexically or through a symlink, before any open, while an app-owned file still reads.
- [Usage windows view](./usage-windows-view.md) — `@byokit/usage/view` `windowsView` lists both windows per account tightest first with their millisecond reset, usage/reset lines and an age taken only from `Reading.at` (unknown without one, stale past 24h keeping its numbers).
- [Dictation live preview](./dictation-live-preview.md) — `@byokit/dictation`'s live preview drops a shown silence sentinel as soon as words arrive, keeps a silence-only take's sentinel, and never retracts real shown words.
- [Dictation live preview decode](./dictation-preview-decode.md) — a live preview decodes greedily over a bounded recent window; a final keeps the host's beam and whole-recording windows.
- [Fresh-project pack gate](./pack-fresh-project.md) — `npm run smoke:pack`: install packed tarballs into a scratch app and import them.
- [Gmail send](./connect-mail-send.md) — `@byokit/connect` `MailSender` with fixture OAuth and a canned Gmail transport: approved, denied and missing-scope legs.
- [House Google client file](./connect-house-client.md) — `googleClientFile` from `@byokit/connect/node` feeding a loopback Gmail sign-in and send: missing, refused, consent approved/denied and send approved/denied legs.
- [Herdr task-owned HOME](./herdr-task-home.md) — `@byokit/herdr` `startAgent` with a task HOME on a real, isolated Herdr lab session (needs the environment's Herdr lab helper; never the person's own Herdr).
- [Herdr example host restart](./herdr-example-restart.md) — the packed example's real paired Chromium page reconnects after its task-owned host restarts without enrolment or approval, preserving full grant identity with separately checked `lastSeen` activity updates and identical ingress bytes; initial code entry connects in under 10 seconds.
- [Herdr waitPromptable](./herdr-wait-promptable.md) — the built `@byokit/herdr` `waitPromptable` against its stand-in Herdr: a still-pending launch rejects `agent-not-ready` at the deadline, a flipped launch resolves, and a pane closed mid-wait rejects `pane-unavailable`.
- [Herdr turn start done and files:false](./herdr-turn-accept-done-files-false.md) — the built `@byokit/herdr` `runTurn` starts on an already-`done` agent like `idle`, `files: false` skips the scan so a >10,000-entry tree completes with no changed files, and the default scan still rejects that tree `turn-failed`.
- [Herdr close-widen scope and words](./herdr-widen-scope.md) — the built `@byokit/herdr` close guards name the wider target (`{ scope, id, label }`) on `pane-close-would-widen`/`tab-close-would-widen`/`workspace-close-would-widen`, and a control device over a real link hears the `close.wouldWiden` words instead of `failed`.
- [Herdr scoped edits](./herdr-scoped-edit.md) — the built `@byokit/herdr` `hd.rename`/`hd.focus`/`hd.layout` over a real link rename, focus and lay out only a pane, tab or workspace in `scopeOf(grant)`, mapping to the typed rename/focus/layout.apply calls never `hd.call`; out-of-scope and `view` grants hear the `link.notAllowed` words with nothing changed.
- [Herdr label placement](./herdr-place-label.md) — the built `@byokit/herdr` `startAgent` with `place.workspace` as a label: reuse lands a new tab with `created: false`, no match creates with `created: true`, a failed start keeps the reused workspace, and two matches refuse `workspace-ambiguous` with nothing created.
- [Pair compact QR crash-resume](./pair-compact-resume.md) — a phone killed during approval resumes from its pending grant against the pinned computer (compact and v1 QRs); an impostor at the same address is refused; the compact token stays 109 characters.
- [Discover firewall verdict and pair self-check](./discover-firewall-check.md) — `firewall({ port })` on the built `@byokit/discover` (live honest-unknown plus stubbed deny/clear legs) and `check()` probe-then-pair against a real loopback host from the built `@byokit/pair`.
- [Pair link problem codes](./pair-link-codes.md) — a socket that never opens reports `unreachable` with the same-network-or-firewall next step; an open but silent socket reports `slow` with the wait-and-retry next step; a typed code still pairs.
- [Relay notification action replies](./relay-action-reply.md) — the built `@byokit/relay` action route forwards a bounded opaque sealed reply to the host unchanged, refuses malformed or oversized replies without spending the token, and stores nothing.
- [Relay provisioning-token enrollment](./relay-provision-enroll.md) — the hosted recipe server serves a dial-out computer that enrolls with a single-use account-bound token and pairs its phone with no QR; expired, reused, withdrawn and wrong-account tokens are refused and nothing secret is kept.
- [Realtime voice offline](./realtime-voice-offline.md) — the tap-to-talk voice screen with `BYOKIT_EXAMPLE_FAKE=1`: a stand-in sign-in and a stand-in voice peer on loopback WebRTC take two turns through every screen state in headless Chromium, release ends the mic track, a blocked mic shows the error state, stills at 390 and 320 px; without the flag the stand-in routes return 403.
- [Expo phone connect routes](./expo-connect.md) — catalogue-driven `useConnect` phone list; native light/dark before/after at 320 dp and font 1.3, plus the existing local-fixture ChatGPT journey on a private emulator.
- [PWA Add an account sheet](./pwa-add-sheet.md) — every route grouped by `connectView`, unavailable rows disabled with their words; journey test plus light/dark × narrow/phone/desktop frames.
- [PWA review evidence](./pwa-review-evidence.md) — frames and motion for a user-visible change, in every theme and form factor the app has.
- [Dictation long-take windows](./dictation-whisper-windows.md) — the built `@byokit/dictation` whisper.rn engine steps long-take windows from where the decoder stopped and joins the overlap once, driven by a stubbed decoder over synthetic WAV audio.
- [Decide slim install](./decide-slim-install.md) — the built `@byokit/decide/slim` decides with rules, any host-owned model and Jev with zero peers; the main entry is unchanged and account billing without the peer names it.

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
- [accounts-hermes-throwifaborted](./accounts-hermes-throwifaborted.md) — the built portable key route streams and still aborts when `AbortSignal.prototype.throwIfAborted` is missing.
- [accounts-pick](./accounts-pick.md) — `pick`/`models` over two real accounts, plus persisted Pi/Codex defaults across a separate consumer restart, removal cleanup, credential-free preferences and fail-closed scoped route/model readiness.
- [ui-account-rows](./ui-account-rows.md) — `accountRows`/`rowsOf`/`nameSuggestions` over a real two-account ChatGPT `list()`: plain rows, state words, the 20% low boundary, untaken suggestions, and no credential in a row.
- [ui-model-picker](./ui-model-picker.md) — `modelPicker`/`bestMoveTarget` over the shared parity table: the Auto row and its reason, per-account models, `Sign in first` without fallback, typed Auto-disabled, and the Auto-ordered move target.
 - [ui-account-hooks](./ui-account-hooks.md) — `useAccounts`/`useModelPicker` with real React over a real two-account ChatGPT `list()` and a real `cliAccounts()` kit: live refresh, explicit select kept across refreshes, a failing room leaving only its row unknown, and a mid-refresh removal dropping the row.
 - [accounts-device](./accounts-device.md) — the provider picker and a catalogue-driven device sign-in, refresh and decline, plus Copilot's phone sign-in through its `copilot_internal/v2/token` exchange on github.com (an enterprise domain refused) with the 401/403 refusal.
- [accounts-google](./accounts-google.md) — the Google Code Assist browser/paste sign-ins (Gemini Code Assist and Antigravity) through the built `Accounts` and the two clients' offline protocol with `mockGoogle()`: PKCE, callback, exchange/refresh, userinfo, sign-out revoke and project answers, plus respond through `v1internal:streamGenerateContent` (403 tier refusal, 401 refresh-once then signed out), busy-port, cancel, invalid_grant, refused revoke and ineligible.
- [accounts-claude-refresh](./accounts-claude-refresh.md) — transient refresh (no answer, 5xx, passing 401) keeps the sign-in, retry rotates the same grant, invalid_grant signs out.
- [accounts-claude-respond-select](./accounts-claude-respond-select.md) — `respond` `select` on two Claude plan accounts: each select answers with its own bearer, a 429 rests only it, its expiry signs out only it, the primary stays ready.
- [accounts-cli-logins](./accounts-cli-logins.md) — two managed CLI logins with one email differ by persisted `addedAt`, driven through the built `@byokit/accounts/cli` against fake native binaries.
- [accounts-cli-remote-signin](./accounts-cli-remote-signin.md) — read-only CLI state plus device-code / link-and-paste-code sign-in over a paired link through the built `@byokit/accounts/cli`, fake native binaries and a live read-only leg with no sign-in.
- [accounts-refresh-refusal](./accounts-refresh-refusal.md) — passing 401 at `access` or `recheck` keeps the ChatGPT sign-in, retry rotates, a revoked grant signs out.
- [openclaw-auth-recovery](./openclaw-auth-recovery.md) — fail-closed startup, retained original and original-key retry through the built OpenClaw kit.
- [openclaw-member-isolation](./openclaw-member-isolation.md) — forced empty auth base, signed-out pick with no model request, scoped sign-out, D9 for new members only.
- [openclaw-install-drift-diagnostics](./openclaw-install-drift-diagnostics.md) — forced fixture-package drift through the built kit's `prepare()` retains every diagnostics field.
- [accounts-machine-store](./accounts-machine-store.md) — one sign-in reused by a second app through `machineStore`, wrong-seal and no-store refusals.
- [usage-planview](./usage-planview.md) — plan/quota view rendered from call records.
- [cloud-boat-v1](./cloud-boat-v1.md) — the boat adapter's public boat-v1 names against the loopback bench.
- [usage-preflight](./usage-preflight.md) — preflight cost ceiling, remaining allowance, declined costly call, and explicit-unknown cases.
- [usage-claude-file-guard](./usage-claude-file-guard.md) — a default-login `.claude`/`.codex`/`.pi` segment (lexically or via symlink) is refused with `UsageError` before any open; an app-owned file still reads.
- [usage-windows-view](./usage-windows-view.md) — both windows per account tightest first with their millisecond reset and lines, plus an age from `Reading.at` only (unknown without one, stale past 24h keeping its numbers).
- [dictation-live-preview](./dictation-live-preview.md) — a shown silence sentinel drops when words arrive, a silence-only take keeps it, and real shown words are never retracted.
- [dictation-preview-decode](./dictation-preview-decode.md) — previews decode greedily over a bounded recent window, finals keep the host beam and whole recording.
- [pack-fresh-project](./pack-fresh-project.md) — the packed-tarball fresh-consumer gate.
- [connect-mail-send](./connect-mail-send.md) — one approval per message, denial without a request, `gmail.send` scope refusal.
- [connect-house-client](./connect-house-client.md) — the house Google client file: missing/refused files, consent approve/deny, send approve/deny.
- [herdr-task-home](./herdr-task-home.md) — an agent pane under a task-owned HOME, read from the agent process and from inside the pane.
- [herdr-wait-promptable](./herdr-wait-promptable.md) — `waitPromptable` on the built `@byokit/herdr`: pending launch times out `agent-not-ready`, a flipped launch resolves, a mid-wait pane close rejects `pane-unavailable`.
- [herdr-turn-accept-done-files-false](./herdr-turn-accept-done-files-false.md) — `runTurn` starts on a `done` agent like `idle`; `files: false` skips the scan on a >10,000-entry tree while the default scan still limits it.
- [herdr-widen-scope](./herdr-widen-scope.md) — the built `@byokit/herdr` names the wider target on a refused widening close and a linked device hears the `close.wouldWiden` words.
- [herdr-place-label](./herdr-place-label.md) — `startAgent` with a workspace label on the built `@byokit/herdr`: reuse with `created: false`, create with `created: true`, a failed start keeping the reused workspace, and the `workspace-ambiguous` refusal creating nothing.
- [pair-compact-resume](./pair-compact-resume.md) — compact/v1 QR kill-during-approval resume, impostor refusal, compact token size and terminal QR.
- [discover-firewall-check](./discover-firewall-check.md) — firewall verdict (live honest-unknown, stubbed deny/clear), probe-then-pair, dead address, bad port.
- [pair-link-codes](./pair-link-codes.md) — unreachable vs slow on dial and check, with the typed-code pair journey.
- [relay-action-reply](./relay-action-reply.md) — the relay action route carries a bounded opaque sealed reply to the host callback, refuses bad replies and stores nothing.
- [relay-provision-enroll](./relay-provision-enroll.md) — dial-out enrollment with a provisioning token through the hosted recipe: no-QR pairing, account scoping, misuse refusals, nothing secret kept.
- [dictation-whisper-windows](./dictation-whisper-windows.md) — long-take automatic windows step from the decoded end (no skip at a pause) and the overlap is joined once (no repeated passage), plus the 30 s-or-shorter and silent-gap extremes.
- [pwa-review-evidence](./pwa-review-evidence.md) — before/after frames and motion per theme/form factor, including Grok device code, one dropped poll, approval, reload and sign-out; the separate built browser-API host-only negative is covered by the PWA journey test.
- [decide-slim-install](./decide-slim-install.md) — slim entry, unchanged main entry, self-naming missing peer, and the offline alone-tarball install.
