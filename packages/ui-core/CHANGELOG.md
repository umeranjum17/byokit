# Changelog

## Unreleased

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
