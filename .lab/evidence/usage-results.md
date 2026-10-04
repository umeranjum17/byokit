# Usage view qualification

Captured source commit: `018969d3991d8a17436e0349c25e34f4128ccd1d`. The following evidence commit adds only captures and this report; it does not change the captured product code.

Firstmate's 2026-10-01 steering explicitly authorized fixture ledgers for this data-combination bug. These are BYOKit's own PWA and Expo screens rendering the installed workspace `@byokit/usage/view` export. They are **sample activity**, not live provider responses or consumer-adoption proof. Consumer adoption belongs to main's lane after release.

Web: Chromium controlled through chrome-devtools-axi, 1280 × 1100, task-owned server on port 21872. Android: release APK with `EXPO_PUBLIC_USAGE_DEMO=1`, emulator `emulator-5630`, medium_phone AVD started read-only for this task, 1080 × 2400. No physical phone, personal app or sign-in was used.

The same fixture call snapshot feeds both reproductions and fixed views. The before mode deliberately recreates the reported independent-selector defect (quota polling failure converted to zero room, empty activity selectors alongside an all-history count). It is a labelled comparison, not a capture of the old consumer binary. The after mode uses the kit's single account-scoped snapshot: today, activity, people and models agree. Quota is independently measured for the whole plan and explicitly labelled; failed polling is not exhaustion. Unknown measurements remain unknown. All nine Android accessibility dumps confirm four identical token counts per tab and no raw model ids.

## Captures

| Surface | Caption (source commit captured) | Full-resolution still |
|---|---|---|
| web | Before reproduction; same ledger; commit `018969d3991d8a17436e0349c25e34f4128ccd1d` | [Before](web-usage-before.png) |
| web | ChatGPT plan; consistent recorded counts; commit `018969d3991d8a17436e0349c25e34f4128ccd1d` | [ChatGPT plan](web-usage-codex.png) |
| web | Claude plan; consistent recorded counts; commit `018969d3991d8a17436e0349c25e34f4128ccd1d` | [Claude plan](web-usage-claude.png) |
| web | GitHub Copilot plan; consistent recorded counts; commit `018969d3991d8a17436e0349c25e34f4128ccd1d` | [GitHub Copilot plan](web-usage-copilot.png) |
| web | Grok plan; consistent recorded counts; commit `018969d3991d8a17436e0349c25e34f4128ccd1d` | [Grok plan](web-usage-grok.png) |
| web | MiniMax plan; consistent recorded counts; commit `018969d3991d8a17436e0349c25e34f4128ccd1d` | [MiniMax plan](web-usage-minimax.png) |
| web | Gemini plan; consistent recorded counts; commit `018969d3991d8a17436e0349c25e34f4128ccd1d` | [Gemini plan](web-usage-gemini.png) |
| web | Kimi plan; consistent recorded counts; commit `018969d3991d8a17436e0349c25e34f4128ccd1d` | [Kimi plan](web-usage-kimi.png) |
| web | GLM plan; consistent recorded counts; commit `018969d3991d8a17436e0349c25e34f4128ccd1d` | [GLM plan](web-usage-zai.png) |
| web | AI plan; consistent recorded counts; commit `018969d3991d8a17436e0349c25e34f4128ccd1d` | [AI plan](web-usage-opencode.png) |
| android | Before reproduction; same ledger; commit `018969d3991d8a17436e0349c25e34f4128ccd1d` | [Before](android-usage-before.png) |
| android | ChatGPT plan; consistent recorded counts; commit `018969d3991d8a17436e0349c25e34f4128ccd1d` | [ChatGPT plan](android-usage-codex.png) |
| android | Claude plan; consistent recorded counts; commit `018969d3991d8a17436e0349c25e34f4128ccd1d` | [Claude plan](android-usage-claude.png) |
| android | GitHub Copilot plan; consistent recorded counts; commit `018969d3991d8a17436e0349c25e34f4128ccd1d` | [GitHub Copilot plan](android-usage-copilot.png) |
| android | Grok plan; consistent recorded counts; commit `018969d3991d8a17436e0349c25e34f4128ccd1d` | [Grok plan](android-usage-grok.png) |
| android | MiniMax plan; consistent recorded counts; commit `018969d3991d8a17436e0349c25e34f4128ccd1d` | [MiniMax plan](android-usage-minimax.png) |
| android | Gemini plan; consistent recorded counts; commit `018969d3991d8a17436e0349c25e34f4128ccd1d` | [Gemini plan](android-usage-gemini.png) |
| android | Kimi plan; consistent recorded counts; commit `018969d3991d8a17436e0349c25e34f4128ccd1d` | [Kimi plan](android-usage-kimi.png) |
| android | GLM plan; consistent recorded counts; commit `018969d3991d8a17436e0349c25e34f4128ccd1d` | [GLM plan](android-usage-zai.png) |
| android | AI plan; consistent recorded counts; commit `018969d3991d8a17436e0349c25e34f4128ccd1d` | [AI plan](android-usage-opencode.png) |

## Verification

- `npm ci`, `npm run build`, `npm run check`: passed.
- Changed package: 42 usage tests passed under scripts/test.sh with a throwaway HOME and short task TMPDIR. Owner's installed Pi unchanged byte for byte.
- Expo typecheck and Android release build: passed.
- Portable view export bundled for a browser without Node imports in the regression test.
- [Kit word scan](usage-words-grep.txt): no raw model ids in any kit word values; no internal plan names in usage word values.
- [Android UI assertions](usage-ui-checks.txt), the per-tab XML dumps, and [web snapshots](web-tabs.txt) accompany the stills.
- Scope limits: unknown models deliberately display “AI model”; no token-to-quota estimate is fabricated. Historical call coverage outside this app is unknown and is never called “no activity”.
