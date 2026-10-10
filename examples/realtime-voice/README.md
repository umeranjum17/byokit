# Live voice proof

Run `node examples/realtime-voice/server.ts` from the repository root, then open the printed loopback URL in a browser with a real microphone. This is an explicitly live demonstration, outside `npm test` and its egress guard. It uses `Accounts` device sign-in kept at this computer's machine store (`machineStore`), so a second run or another app on this computer reuses it; approve it using your signed-in ChatGPT browser. It never imports another tool's credentials.

Start voice and say only “Hello from BYOKit.” Listen for the demo reply, then interrupt or stop. The server ends each call after 45 seconds and the browser after 40. `/proof` reports sign-in, SDP acceptance, connection, microphone acquisition/activity, received audio-track activity, turn counts and stop. Neither transcripts, audio nor credentials are logged or recorded. Audio-track activity proves reception, not that a person heard the speaker; record that observation separately. The page's explicit interrupt ends its one proof call; the regular client defaults to reconnecting that rotation.

A live pass requires microphone acquisition and activity, accepted signaling, a connected peer, both a user and an agent turn, received output audio, audible playback, and clean stop. A fake media device or loopback provider is not a live pass. Sign-in is discarded when the server exits.

## Offline run

`BYOKIT_EXAMPLE_FAKE=1 node examples/realtime-voice/server.ts` runs the same page with nothing leaving the computer: Sign in opens a stand-in page instead of ChatGPT's, and that page then answers the call over loopback WebRTC with a tone and one user and one agent turn. The engine signals to the server's own loopback endpoint; without the flag those stand-in routes return 403 and sign-in is the real one. `sh scripts/test.sh examples/realtime-voice/e2e.test.ts` drives it in headless Chromium with a fake microphone, and CI runs it. A fake run is not a live pass.
