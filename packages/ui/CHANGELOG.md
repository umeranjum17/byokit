# Changelog

## Unreleased

- Dependency update: pins @byokit/accounts 0.26.0.

- Dependency update: pins @byokit/accounts 0.25.1.

- Dependency update: pins @byokit/accounts 0.25.0.

- Dependency update: pins @byokit/accounts 0.24.3.

## 0.9.0 (2026-10-17)

- Dependency update: pins @byokit/accounts 0.24.2.

- FEAT: The key card has a `workspace` state (`result: 'workspace'`, words "This key works for more than one
  workspace. Pick the one to use."), so an app shows the workspace pick for a plan key that acts for several
  workspaces (OpenCode Go) and submits again with the one picked.

- Dependency update: pins @byokit/accounts 0.24.1.

## 0.8.0 (2026-10-16)

- Dependency update: pins @byokit/accounts 0.24.0.

- FEAT: `accountRows(accounts, room, now, windows?)` and `AccountsSource.windows` take an account's `windowsView` from `@byokit/usage/view`: a ready row gains `windows` (each usage window, tightest first, with its line, its reset line and its millisecond reset) and `asOf` (`Read 2 minutes ago`, `Read 2 days ago (stale)` past a day). A window whose reset is already past reads `Session: reset since this reading` (no percent, no countdown), and so does the row's room line (`Plus · Reset since this reading`). A stale row is never `low`, and a reading without its own time (an openclaw room) shows its resets and no age. New types `UsageWindow`, `UsageWindows` and `AsOf`. The PWA example's account card draws both windows with their resets and age, keeps the last reading when a refresh fails so it shows as stale instead of unknown, and fits the longest address at 320px with larger text.
- FEAT: `runStore` tolerates an account run's first frame: the run stream may open with an `account` event (O14m) naming the account the reply bills to, which the run view ignores while the reply, tools and end behave as before.
- FIX: a subscription row whose route name already says plan ("Qwen Token Plan", "Qwen Token Plan CN", "Qwen Token Plan Individual") no longer reads "Uses your ... plan" with the word twice: `connectView` leaves the template's trailing plan out when the name already carries the word (any case). Names without it ("Qwen") still read "Uses your Qwen plan".

- Dependency update: pins @byokit/accounts 0.23.0.

## 0.7.0 (2026-10-12)

- Dependency update: pins @byokit/accounts 0.22.0.

- FEAT: Add `useAccounts` and `useModelPicker` to `@byokit/ui` (with the `accountsSource`/`cliSource` one-line-per-member adapters): live rows with `refresh()`, a failing room leaving only its row `Room left unknown`, a `remove()` landing mid-refresh still dropping the row, and a picker whose `select()` marks the selection at once and keeps it across refreshes. The openclaw adapter stays pending O14.
- FEAT: Add `accountRows`, `rowsOf`, `nameSuggestions` and the `AccountsSource`, `AccountRow`, `Account` and `Room` types (also `@byokit/ui/accounts`, no React): one plain-words row per account (`ChatGPT · Work` / `Plus · 72% left this week`), honest words for every sign-in state, `low` at or below 20%, a `sign_in`/`wait` action, and untaken account-name suggestions from an email's local part that never put an email in a title.
- FEAT: `herdrTreeView` groups carry `project`, the workspace folder's own name without the tab label, so rows can name an agent (computer, project, agent) without internal tab labels.
- FEAT: Browser sign-in sheet and live panel views: `signInSheetView(request, { name, holder })` gives the sentence, buttons and chat chip for each request state; `signInsStore(oc)` keeps requests live from sign-in pings; `livePanelView(state)` says when to draw frames, take input, show "Reconnecting…" or ask to confirm an unexpected address. Typed structurally against `@byokit/openclaw` spec 5.17.
- FEAT: Add `connectView(routes, step)`, `connectStep`, `signInFor` (also `@byokit/ui/connect`, no React) and `useConnect`: every account route the kits list, grouped as Plans (offered by default), Pay per use, On this computer, Your own server, Cloud account, Other ways to connect, and Speech, search and media, each row with plain billing, method and readiness words. Billing decides the group, so no API, cloud, local, server or unknown-billing row is ever in Plans; key routes reuse `keyView`, sign-in routes hand `useSignIn` their row.
- FEAT: Add `modelPicker` and `bestMoveTarget` to `@byokit/ui/accounts` (no React, no Node): the run picker with the `Auto — most room left` row carrying the pick's own reason, one plain row per account with its model rows and the selection marked, unavailable rows with a typed why and `until`, Auto disabled with a typed reason when no account can be named, and the Auto-ordered account a running session should move to (`Move to Work` / `Couldn't move to Work`).
- FEAT: plain pairing words for the phone page: `connectedWords(hostName, url?, kind?)` renders the connected line with the route just dialled (`Connected to Kitchen computer - same Wi-Fi.`), `routeShort(route)` gives the inline label, and `pairErrorWords(error)` reads a failed pairing as expired, wrong-code or the link's own sentence from @byokit/link's error code.
- FEAT: `describeRoute` labels in plain words: `Same Wi-Fi`, `Temporary public link`, `Away from home` (this kit's relay address) and `Your own server`. No route, choice or status sentence carries an address, a protocol name or relay jargon.
- The PWA example's account card now runs on the shared views: `accountRows`/`modelPicker` from `@byokit/ui/accounts` draw the rows and the run picker (Auto carries its own reason, a signed-out pick shows `Sign in first` and runs nothing), and `bestMoveTarget`/`moveWords` suggest the roomier account when the chosen one is low.
- `@byokit/ui-core` is now published as `@byokit/ui`, with the same API and the same entries (`.`, `./phase`, `./route`, `./link`, `./kits`, `./steps`, `./connect`); its earlier versions are the `@byokit/ui-core` releases below. **Deprecated:** the `@byokit/ui-core` name; it stays published as a shim that re-exports this package through 0.7.x and is removed in 0.8.0.
- Accept OpenClaw's admitted/thinking progress frames structurally without changing the existing run reducer's rendered state.

- Dependency update: pins @byokit/accounts 0.21.0.

- Run views accept structured-output failures and display the kit’s plain validation message.

## 0.6.0 (2026-10-01)



- API key (billed per use): framework-free `keyStep` and `keyView` entry-card states and plain billing/error words, without keeping a credential in view state.

## 0.5.0 (2026-10-01)



- `routeChoices()`: every onboarding route (`tailscale`, `tailscale-direct`, `private`, `lan`, plus `cloudflare`
  and `external`) in everyday words (`{ code, title, sentence, needs }`), in recommendation order. The one word
  table reach's `recommend()` draws `sentence` and `needs` from.

## 0.4.0 (2026-09-30)

- `@byokit/ui-core/steps` (no React): `stepsView(steps)` turns the caller's own steps into the rows a stepper or
  inline checks draw (`{ id, state: todo | checking | ok | failed, words, fix }`, same in a terminal and on a
  phone); `stepsText(rows, { title })` draws the same rows as text lines for a terminal. Step ids stay
  caller-defined, and a failed step without its own `fix` says "Try again."

## 0.3.0 (2026-09-30)

- FIX: pairing links parse on React Native, where `URL.canParse` is missing and `hostname` is empty for `ws://`:
  `describeRoute` reads the scheme and host itself.
- `@byokit/ui-core/kits` (no React): view state for the runtime kits, typed structurally against
  `@byokit/openclaw/device` and `@byokit/herdr/device` so neither kit is a dependency. Reducers `runStep`,
  `approvalsStep` and `herdrStep`; views `runView` (the reply, the tool at work, and how a run ended in the kit's own
  sentence), `approvalWords`, `herdrTreeView`, `agentIn` and `blockedView`; live stores `runStore`, `approvalsStore`
  (listed once the event stream is open, dropped as each approval expires) and `herdrStore` (one `hd.events` stream
  per device however many views watch it; a waiting agent's revision follows the tree, so an answer is never stale).
  Stores reopen their stream soon after the link comes back (a stopped or refused link included, after its `retry()`)
  and stop for good once the pairing is removed.
- React hooks `useRun`, `useApprovals`, `useHerdrTree` and `useBlocked` over those stores, for React and React Native.
- `qrMatrix(text, { border })` takes the quiet border in modules (2 unless given, as before), and `qrText(text,
  { border })` draws the same QR as half-block text rows for a terminal, so a setup script shows a code a phone can scan.
- `consentWords` and `pairingView` take an optional `device` (`phone`, or `browser`, which opens the pairing link
  instead of scanning) and one app sentence (`detail`) after the title.
- `useSignIn` works without `start`: when something else starts the sign-in, the sheet only watches, and nothing
  begins as it opens.

## 0.2.0

- `@byokit/ui-core/link`: `qrMatrix`, `consentWords`, `pairingView` and `linkWords` for pairing with `@byokit/link` in any UI.

## 0.1.1

- The Apache-2.0 LICENSE ships in the tarball.

## 0.1.0

- Headless sign-in state and plain-words copy for any UI.
