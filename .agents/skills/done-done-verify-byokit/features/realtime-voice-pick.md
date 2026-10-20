# Realtime voice pick, live server

A person opens the voice example on the real server (no `BYOKIT_EXAMPLE_FAKE`) and first chooses which plan or key runs the voice: one row per provider `@byokit/realtime` catalogues (`providers`), a plan row reading "Sign in with your plan" and key rows reading "Paste your API key — billed per use". Choosing one opens its step: ChatGPT voice the Sign in with ChatGPT panel, OpenAI, Gemini and Grok a key form naming the provider. Each step goes back to the pick; nothing switches provider by itself.

## Sub-features

- `pick-rows`: the rows are the kit's `providers`, in order, with plain plan or key words.
- `provider-step`: each row reaches its sign-in or key step and back again on the live server.

## How to get to it (user POV)

- `node examples/realtime-voice/server.ts`, open the printed URL, choose a row (examples/realtime-voice/README.md).

## Driving it

Preconditions: `npm ci`; heavy-job lock held (a Chromium launch); Playwright's Chromium, else the system's.

- **Run and capture.** `feature=realtime-voice-pick; entry=examples/realtime-voice/server.ts; drive=(node .agents/skills/done-done-verify-byokit/capture/realtime-voice-pick.ts <evidence folder outside the repository>)`. It runs the real server in a throwaway HOME, records `pick-<light|dark>.webm` at 390 px and writes `pick-*` and `<sign-in|key>-<provider>-*` stills at 390 and 320 px, light and dark, plus `manifest.json` with `/proof`. Exit code `0`; `/proof` reads `signedIn: false`; open every still and the recordings.
- **Stops before anything leaves.** It never presses Sign in, pastes a key or talks, so no real sign-in, paid key or model call happens; the full call is proved offline by [realtime-voice-offline](./realtime-voice-offline.md).
