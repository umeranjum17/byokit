# Live voice proof

Run `node examples/realtime-voice/server.ts` from the repository root, then open the printed loopback URL in a browser with a real microphone. This is an explicitly live demonstration, outside `npm test` and its egress guard. It uses `Accounts` device sign-in kept at this computer's machine store (`machineStore`), so a second run or another app on this computer reuses it; approve it using your signed-in ChatGPT browser. It never imports another tool's credentials.

Start voice and say only “Hello from BYOKit.” Listen for the demo reply, then interrupt or stop. The server ends each call after 45 seconds and the browser after 40. `/proof` reports sign-in, SDP acceptance, connection, microphone acquisition/activity, received audio-track activity, turn counts and stop. Neither transcripts, audio nor credentials are logged or recorded. Audio-track activity proves reception, not that a person heard the speaker; record that observation separately. The page's explicit interrupt ends its one proof call; the regular client defaults to reconnecting that rotation.

A live pass requires microphone acquisition and activity, accepted signaling, a connected peer, both a user and an agent turn, received output audio, audible playback, and clean stop. A fake media device or loopback provider is not a live pass. Sign-in is discarded when the server exits.
