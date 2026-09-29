# Changelog

## Unreleased

- `@byokit/ui-core/kits` (no React): view state for the runtime kits, typed structurally against
  `@byokit/openclaw/device` and `@byokit/herdr/device` so neither kit is a dependency. Reducers `runStep`,
  `approvalsStep` and `herdrStep`; views `runView` (the reply, the tool at work, and how a run ended in the kit's own
  sentence), `approvalWords`, `herdrTreeView`, `agentIn` and `blockedView`; live stores `runStore`, `approvalsStore`
  (listed once the event stream is open, dropped as each approval expires) and `herdrStore` (one `hd.events` stream
  per device however many views watch it; a waiting agent's revision follows the tree, so an answer is never stale).
  Stores reopen their stream soon after the link comes back (a stopped or refused link included, after its `retry()`)
  and stop for good once the pairing is removed.
- React hooks `useRun`, `useApprovals`, `useHerdrTree` and `useBlocked` over those stores, for React and React Native.

## 0.2.0

- `@byokit/ui-core/link`: `qrMatrix`, `consentWords`, `pairingView` and `linkWords` for pairing with `@byokit/link` in any UI.

## 0.1.1

- The Apache-2.0 LICENSE ships in the tarball.

## 0.1.0

- Headless sign-in state and plain-words copy for any UI.
