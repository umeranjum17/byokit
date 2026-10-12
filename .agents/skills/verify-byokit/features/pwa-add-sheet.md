# PWA Add an account sheet (WP10-S6)

The example PWA's **Add an account** sheet lists every route `accounts.routes()` returns, grouped by `@byokit/ui/connect`'s `connectView`: Plans first, then Pay per use and the rest, each row with how it is paid for, how you sign in and whether it works here. A row is a button only when this page can start it (a ready sign-in route whose provider has a card here, e.g. `openai:code` → the ChatGPT card's sign-in). A route that is not ready (`needs_host`, `unsupported_platform`, `no_upstream_flow`; no browser route needs a binary today) shows its readiness words and is disabled; a ready key route this page has no form for is disabled and says so.

## How to get to it (user POV)

Open the PWA, tap **Add an account** under the plan usage link. Scroll the groups; tap the ChatGPT "Sign in with a code" row and the sheet closes on the ChatGPT card showing its code.

## Driving it

- **Journey test.** `sh scripts/test.sh examples/pwa/pwa.test.ts` (Chromium, built bundle): the `Add an account` case asserts the group order, one row per route, Plans/Pay-per-use billing words, disabled `anthropic:paste` (`Needs the app on your computer.`) and `openai:browser` (`Not available on this device.`) rows that do nothing when force-clicked, a disabled `openai:key`, and `openai:code` starting the ChatGPT device code.
- **Frames.** `node .agents/skills/verify-byokit/capture/review-evidence.ts --base origin/main --screens add-sheet-top,add-sheet-ready,add-sheet-unavailable --out <private-evidence-dir>`: light/dark × narrow/phone/desktop, plus motion. Before frames are the base page, which had no sheet (the signed-out cards).

## Gotchas

- Readiness is the kit's, for the browser platform with no host side: the Claude card still signs in through this page's own server (`serve.ts`), while its routes read `Needs the app on your computer.` in the sheet.
