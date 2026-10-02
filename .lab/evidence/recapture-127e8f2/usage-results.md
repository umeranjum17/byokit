# Usage view recapture on current main

Captured source commit: `8ee492744bd678803d002f8fd5427d4ba1de8e39` (PR branch rebased onto main `127e8f2d`, release 13). The commit that adds this folder changes only evidence. The original captures at `018969d3` stay one folder up, unchanged, for comparison.

These are BYOKit's own PWA and Expo screens rendering the workspace `@byokit/usage/view` export on the same fixture ledger that firstmate authorized on 2026-10-01. They show **sample activity**, not live provider responses or adoption by a consumer app.

Web: Chromium through chrome-devtools-axi at 1280 × 1100, served by a task-owned server on port 21872. The web stills are byte-identical to the originals.
Android: release APK built with `EXPO_PUBLIC_USAGE_DEMO=1` on a task-started read-only `medium_phone` emulator (`emulator-5630`) at 1080 × 2400. No physical phone, personal app or sign-in was used.

## Captures

| Surface | Caption | Full-resolution still |
|---|---|---|
| web | Before reproduction (labelled, same ledger); commit `8ee492744bd678803d002f8fd5427d4ba1de8e39` | [Before](web-usage-before.png) |
| web | ChatGPT plan; consistent recorded counts; commit `8ee492744bd678803d002f8fd5427d4ba1de8e39` | [ChatGPT plan](web-usage-codex.png) |
| web | Claude plan; consistent recorded counts; commit `8ee492744bd678803d002f8fd5427d4ba1de8e39` | [Claude plan](web-usage-claude.png) |
| web | GitHub Copilot plan; consistent recorded counts; commit `8ee492744bd678803d002f8fd5427d4ba1de8e39` | [GitHub Copilot plan](web-usage-copilot.png) |
| web | Grok plan; consistent recorded counts; commit `8ee492744bd678803d002f8fd5427d4ba1de8e39` | [Grok plan](web-usage-grok.png) |
| web | MiniMax plan; consistent recorded counts; commit `8ee492744bd678803d002f8fd5427d4ba1de8e39` | [MiniMax plan](web-usage-minimax.png) |
| web | Gemini plan; consistent recorded counts; commit `8ee492744bd678803d002f8fd5427d4ba1de8e39` | [Gemini plan](web-usage-gemini.png) |
| web | Kimi plan; consistent recorded counts; commit `8ee492744bd678803d002f8fd5427d4ba1de8e39` | [Kimi plan](web-usage-kimi.png) |
| web | GLM plan; consistent recorded counts; commit `8ee492744bd678803d002f8fd5427d4ba1de8e39` | [GLM plan](web-usage-zai.png) |
| web | AI plan; consistent recorded counts; commit `8ee492744bd678803d002f8fd5427d4ba1de8e39` | [AI plan](web-usage-opencode.png) |
| android | Before reproduction (labelled, same ledger); commit `8ee492744bd678803d002f8fd5427d4ba1de8e39` | [Before](android-usage-before.png) |
| android | ChatGPT plan; consistent recorded counts; commit `8ee492744bd678803d002f8fd5427d4ba1de8e39` | [ChatGPT plan](android-usage-codex.png) |
| android | Claude plan; consistent recorded counts; commit `8ee492744bd678803d002f8fd5427d4ba1de8e39` | [Claude plan](android-usage-claude.png) |
| android | GitHub Copilot plan; consistent recorded counts; commit `8ee492744bd678803d002f8fd5427d4ba1de8e39` | [GitHub Copilot plan](android-usage-copilot.png) |
| android | Grok plan; consistent recorded counts; commit `8ee492744bd678803d002f8fd5427d4ba1de8e39` | [Grok plan](android-usage-grok.png) |
| android | MiniMax plan; consistent recorded counts; commit `8ee492744bd678803d002f8fd5427d4ba1de8e39` | [MiniMax plan](android-usage-minimax.png) |
| android | Gemini plan; consistent recorded counts; commit `8ee492744bd678803d002f8fd5427d4ba1de8e39` | [Gemini plan](android-usage-gemini.png) |
| android | Kimi plan; consistent recorded counts; commit `8ee492744bd678803d002f8fd5427d4ba1de8e39` | [Kimi plan](android-usage-kimi.png) |
| android | GLM plan; consistent recorded counts; commit `8ee492744bd678803d002f8fd5427d4ba1de8e39` | [GLM plan](android-usage-zai.png) |
| android | AI plan; consistent recorded counts; commit `8ee492744bd678803d002f8fd5427d4ba1de8e39` | [AI plan](android-usage-opencode.png) |

## Verification

- [Gates after the rebase](usage-rebased-127e8f2-gates.txt): `npm ci`, build and check pass, and 50 usage tests pass with 1 optional test skipped. The [Expo typecheck](expo-typecheck.txt) and the [release build](android-build.txt) also pass.
- [Android UI checks](usage-ui-checks.txt): in all nine fixed tabs, today, 30 days, people and models show the same per-plan total, and no model ids or internal plan names appear. Only the labelled before reproduction shows "OpenAI Codex", "Rate limited 0% left", "0 tokens" and "Pi 4.6B".
- [Web snapshots](web-tabs.txt): each fixed tab shows its total exactly four times.
- [Kit words grep](usage-words-grep.txt): no raw model ids in the 262 values of all 12 words.json files, and no internal plan names in the usage words.
