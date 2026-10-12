# PWA Add an account sheet (WP10-S6)

The example PWA's **Add an account** sheet lists every route `accounts.routes()` returns, grouped by `@byokit/ui/connect`'s `connectView`: Plans first, then Pay per use and the rest, each row titled by its provider and way in (`ChatGPT — sign in with a code`), with how it is paid for and whether it works here; ready routes first within each group. A row is a button only when this page can start it (a ready sign-in route whose provider has a card here, e.g. `openai:code` → the ChatGPT card's sign-in). A route that is not ready (`needs_host`, `unsupported_platform`, `no_upstream_flow`; no browser route needs a binary today) shows its readiness words and is disabled. Every ready route this page has no form for (today: the ready key routes) leaves its group for one collapsed **Coming soon** group at the end, closed by default, which opens onto one plain line (`These ways in work in the kit, but this page has no form for them yet.`) and those rows, each still saying `Ready, but this page has no form for it yet.`

## How to get to it (user POV)

Open the PWA, tap **Add an account** under the plan usage link. Scroll the groups; tap the ChatGPT "Sign in with a code" row and the sheet closes on the ChatGPT card showing its code. With ChatGPT already signed in, the same row adds another account on that card; while a sign-in there is still waiting, the row shows that card's pending state and starts nothing new.

## Driving it

- **Journey test.** `sh scripts/test.sh examples/pwa/pwa.test.ts` (Chromium, built bundle): the `Add an account` case asserts the group order (Coming soon last), one row per route, Plans/Pay-per-use billing words, disabled `anthropic:paste` (`Needs the app on your computer.`) and `openai:browser` (`Not available on this device.`) rows that do nothing when force-clicked, a disabled `openai:key` now inside Coming soon, no `no form for it yet` row outside Coming soon with the group starting closed, and `openai:code` starting the ChatGPT device code. The `Add sheet rows start their own card` case covers the signed-in and waiting rows; the `an added sign-in that runs out` case checks an expired add leaves its card not stuck and its expiry words survive a redraw.
- **Frames.** `node .agents/skills/verify-byokit/capture/review-evidence.ts --base origin/main --screens add-sheet-top,add-sheet-ready,add-sheet-unavailable,add-sheet-coming --out <private-evidence-dir>`: light/dark × narrow/phone/desktop, plus motion. Before frames are the base page, which had no sheet (the signed-out cards). `add-sheet-coming` opens the Coming soon group and frames its explanation and rows.

## Gotchas

- Readiness is the kit's, for the browser platform with no host side: the Claude card still signs in through this page's own server (`serve.ts`), while its routes read `Needs the app on your computer.` in the sheet.
