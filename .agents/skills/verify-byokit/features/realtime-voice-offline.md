# Realtime voice screen, offline

A person runs the tap-to-talk voice screen with `BYOKIT_EXAMPLE_FAKE=1` and gets whole turns without an account or the network: Sign in opens the stand-in page (`stand-in.html`) where ChatGPT's approval would be, the first tap on the talk button signals through the realtime engine's loopback `endpoint` on the example server and attaches the microphone, the second tap releases it, and the stand-in answers each heard stretch over loopback WebRTC with one user turn, a tone and one agent turn. A fake run is not a live pass.

## Sub-features

- `offline-call`: `/proof` reads `signedIn`, `signalingAnswered`, `connected`, `microphone` and `stopped` true, `userTurns` and `agentTurns` 2, `error` false, and no string values (counts only, never transcript text).
- `tap-to-talk-states`: `#screen[data-state]` goes `signed-out → idle → connecting → listening → thinking → speaking → idle`, a second turn at 320 px, then a blocked microphone → `connecting → error`; every state's `#status` text differs, idle reads `Tap to talk`.
- `mic-released`: after each release every captured track's `readyState` is `ended`.
- `transcript-and-copy`: four transcript lines (`You` / `Assistant`) show on the page; the page text names `ChatGPT plan` and matches none of `gpt-`, `codex`, `realtime`, `webrtc`, `sdp`.
- `no-flag-403`: without the flag every stand-in route (`/stand-in.html`, `/stand-in/approve`, `/stand-in/offer`, `/stand-in/answer`) returns 403, so sign-in stays the real `accounts.login`.

## How to get to it (user POV)

- `BYOKIT_EXAMPLE_FAKE=1 node examples/realtime-voice/server.ts`, open the printed URL, Sign in, Approve sign-in (the stand-in page opens), tap the talk button, tap it again (examples/realtime-voice/README.md).

## Driving it with node scratch consumers

Preconditions: `npm ci`; heavy-job lock held (a Chromium launch); a Chromium for Playwright, its own download else the system's. The page imports `packages/*/src` directly, so no build is needed.

- **Run and capture.** `feature=realtime-voice-offline; entry=examples/realtime-voice/server.ts; export BYOKIT_VOICE_STILLS=<evidence folder outside the repository>; drive=(sh scripts/test.sh examples/realtime-voice/e2e.test.ts)`, then SKILL.md Evidence's capture block. Exit code `0`; both tests pass, and `$BYOKIT_VOICE_STILLS` holds `<state>-<390|320>-<light|dark>.png` for every state (`connecting` at 390 only); open each one. The test launches Chromium with `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`, so the microphone is Chromium's fake device and nothing is played out loud.
- **Failure shows.** A missing turn or connection fails with `proof never got there:` and the whole `/proof` JSON plus any page error.

## Gotchas

- `net::ERR_INSUFFICIENT_RESOURCES` or `Target crashed` at the first navigation is the host's Chromium under load, not the page: a bare loopback page fails the same way; rerun once the host settles.
