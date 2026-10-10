# Realtime voice proof page, offline

A person runs the voice proof page with `BYOKIT_EXAMPLE_FAKE=1` and gets a whole call without an account or the network: Sign in opens the stand-in page (`stand-in.html`) where ChatGPT's approval would be, Start voice signals through the realtime engine's loopback `endpoint` on the example server, and the stand-in answers over loopback WebRTC with a tone and one user and one agent turn. A fake run is not a live pass.

## Sub-features

- `offline-call`: `/proof` reads `signedIn`, `signalingAnswered`, `connected`, `microphone` and `stopped` true, `userTurns` and `agentTurns` at least 1, `error` false.
- `no-flag-403`: without the flag every stand-in route (`/stand-in.html`, `/stand-in/approve`, `/stand-in/offer`, `/stand-in/answer`) returns 403, so sign-in stays the real `accounts.login`.

## How to get to it (user POV)

- `BYOKIT_EXAMPLE_FAKE=1 node examples/realtime-voice/server.ts`, open the printed URL, Sign in, Approve sign-in (the stand-in page opens), Start voice, Stop (examples/realtime-voice/README.md).

## Driving it

Preconditions: `npm ci`; heavy-job lock held (a Chromium launch); a Chromium for Playwright, its own download else the system's. The page imports `packages/*/src` directly, so no build is needed.

- **Run and capture.** `feature=realtime-voice-offline; entry=examples/realtime-voice/server.ts; drive=(sh scripts/test.sh examples/realtime-voice/e2e.test.ts)`, then SKILL.md Evidence's capture block. Exit code `0`; both tests pass. The test launches Chromium with `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`, so the microphone is Chromium's fake device and nothing is played out loud.
- **Failure shows.** A missing turn or connection fails with `proof never got there:` and the whole `/proof` JSON plus any page error.

## Gotchas

- `net::ERR_INSUFFICIENT_RESOURCES` or `Target crashed` at the first navigation is the host's Chromium under load, not the page: a bare loopback page fails the same way; rerun once the host settles.
