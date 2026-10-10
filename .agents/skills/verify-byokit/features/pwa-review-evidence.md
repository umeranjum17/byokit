# PWA review evidence (frames and motion)

A person opens the byokit example PWA on a phone or a desktop browser, in the theme their device is set to, signs in with a plan they already pay for, and reads what that plan has left. When a change touches any of that, `capture/review-evidence.ts` captures it: every changed screen before and after, in every theme and form factor the app has, plus one motion recording per changed interaction, from the real running app.

## Sub-features

- `screen-frames`: `before__<theme>__<form>.png` and `after__<theme>__<form>.png` for each screen, theme and form factor the app has.
- `screen-motion`: `motion__<interaction>__<theme>__<form>.webm`, recorded from the running app through Playwright's own screen recording.
- `screen-skips`: any theme, form factor or screen the app does not have, written into `manifest.json` with the reason, never silently dropped.
- `screen-before`: the before frame is the example app of `--base <ref>` (default `origin/main`), served from that ref's own copy of the files; a screen that ships its own before route (`usage.html?before`) uses that instead.

## How to get to it (user POV)

- A reviewer opens `usage.html` on a phone, reads the plan view, taps another plan. `signin` is the same app's home: tap **Sign in with ChatGPT** and the device code appears on the card.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md); heavy-job lock held for the whole run (a Chromium launch and a server per screen); a Chromium for Playwright — its own download, else the system's, as `examples/pwa/pwa.test.ts` resolves it.

- **Run the capture.** `feature=review-evidence; entry=capture/review-evidence.ts; drive=(node .agents/skills/verify-byokit/capture/review-evidence.ts --base origin/main --slug <slug>)`, then run SKILL.md Evidence's capture block. Exit code `0`.
- **What it writes.** `.verify-artifacts/review/<slug>/manifest.json` plus, per screen, `before`/`after` frames and one `motion__<interaction>__<theme>__<form>.webm` per theme and form factor. `signin` has light and dark (`index.html` themes on `prefers-color-scheme`); `usage` is light only, and the dark skip is written down with the reason.
- **Account selection.** `ask-select-work` and `ask-select-personal` sign in two ChatGPT accounts through the stand-in (Work first, then Personal) with a per-account usage answer, so Auto names Work by room and answers from it; `ask-select-personal` then hits Work with a 429 and shows the next Auto naming Personal. They exist because `respond`'s account selection is a user-visible change in `examples/pwa/app.ts`.
- **Form factors.** `phone` = 390×844 at 2×, `desktop` = 1280×800 — the widths `examples/pwa` lays out for (`usage.html` breaks at 700px; `index.html` is one column capped at 30em).
- **Proof.** The frames show the real screen with its real state (`signin` after: the stand-in's `MOCK-…` code on the card; `signin-list` after: the signed-out provider rows; `signin-connected` after: the plan badge and the two bottom actions shown as separate tappable actions; `signin-expired` after: the expired banner over a fresh Sign in; `usage` before/after: the old independent selectors and the fixed plan view on the same ledger), and the motion file is a recording of the interaction, not a screenshot series.

## Gotchas

- `--base` must be a ref that has `examples/pwa/serve.ts`; the capture archives that ref's `examples/pwa` (and `examples/usage-demo.ts`, which its `usage.ts` imports) into its own scratch and serves it there, so the before build is the old app code against the **current** `packages/*/dist`. It proves the screen's rendering changed, not the SDK's behavior.
- A screen that did not exist at `--base` has no before frame: the run records that skip with the reason instead of faking a before.
- The stand-in issues the code (`MOCK-…`); the shape is what a real provider's code looks like, not the value.
- Frames are captured with the service worker blocked, so a cached shell cannot serve a stale screen into the evidence.
- `examples/expo` has the same screens on React Native: it needs a running emulator or device, which this host does not have, so it is declared unavailable here rather than substituted with the web frames.