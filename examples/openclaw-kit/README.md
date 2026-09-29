# OpenClaw kit example

Your ChatGPT plan working for you on this computer, from your phone: pair the phone with this computer, sign in with
ChatGPT, send the helper a message, and allow or deny what it asks before it acts. The computer runs `host.ts`
(`@byokit/openclaw`, with its own OpenClaw engine in `./.state`); the phone opens a plain web page this computer
serves, over your home network or Tailscale. The ChatGPT sign-in is kept by the engine on this computer; this app
never sees it.

## Minutes to working

You need Node 22.18 or later. The first start downloads and installs the pinned OpenClaw engine into `./.state`,
which takes a few minutes; after that it runs offline, except for the model itself.

```sh
npm i
npm start
```

1. The terminal shows a QR code and a typed code, then `Getting things ready on this computer. The first time takes
   a few minutes.`, and later `Ready.`
2. On the phone, scan the QR code with the camera (it opens this app's page), or open the address printed under it
   and type the code. Both last five minutes; press Enter in the terminal for new ones.
3. The phone and the terminal show the same two words. If they match, answer `y` in the terminal.
4. On the phone, tap **Sign in with ChatGPT**. It shows a code: open the ChatGPT page it links to, sign in there and
   type the code. The phone moves on by itself once ChatGPT says yes.
5. Type a message and tap **Send**. The reply streams in under it.
6. Ask it to save a note (for example "save a note that says buy milk"). Before it does, the phone shows **Your
   helper wants to save a note. Allow it?** Tap **Allow** and the note lands in `.state/notes.txt`, or **Deny** and
   nothing is saved. Everything else the helper would do on this computer (searching the web, say) asks the same way.

Over Tailscale the page is https and the phone keeps its pairing sealed in the browser. Over your home network it is
plain http, which browsers don't let a page seal with, so the pairing is kept in the browser's ordinary storage
there; prefer Tailscale when you can.

Options: `--port` (default 7310), `--via` (`auto`: Tailscale when it is installed, else your home network; or
`tailscale`, `tailscale-direct`, `private`, `lan`), `--name` (what the phone calls this computer).

Try it without the engine or an account: `BYOKIT_EXAMPLE_FAKE=1 npm start` runs the kit's stand-in Gateway. Its
sign-in shows the code `CREW-2026` and says yes by itself a few seconds later; its helper answers
`fake: <your message>`, and a message containing `[tool demo_note {"text":"buy milk"}]` asks to save that note.

## What's where

- `host.ts`: `new OpenClawKit({ stateDir: './.state', tools: [demo_note], host, config: { plugins: { allow:
  ['openai'] } } })`. `demo_note` (`{ text }`) is gated `{ ask: { summary: 'save a note' } }` and appends to
  `.state/notes.txt`; the engine's own tools ask too. A `@byokit/link` host (key in `.state/link-key.json`, paired
  phones in `.state/grants.json`) answers the phone with `openclawLink(kit, { memberOf: () => 'me' })`: every paired
  phone acts for this app's one member. `serve` finds the address (`@byokit/reach`) and serves the page on the same
  port.
- `web/app.ts`: plain DOM. Pairs with `pairWithCode`/`pairWithOffer` and keeps the pairing in this browser
  (`browserDeviceStore`); then `openclawDevice(link)`: `signIn.start('openai', 'code')` and `signIn.view` through
  `@byokit/ui-core`'s `phaseOf` for the sign-in card, `run` for the streamed reply, `approvals`/`events`/`decide` for
  what waits for a yes. Every status is a sentence from the kit (`words`, `oc.state().words`) or `@byokit/ui-core`
  (`pairingView`, `linkWords`).
- `e2e.test.ts`: packs the packages, installs them into a copy of this folder, runs `host.ts` against the kit's fake
  Gateway and drives a phone-sized headless Chromium through all of the above, Allow and Deny both. From the repo:
  `npm run build && sh scripts/test.sh examples/openclaw-kit/e2e.test.ts` (`BYOKIT_EXAMPLE_SHOTS=<folder>` keeps
  the screenshots).
- `LIVE.md`: the check with the real engine, a real ChatGPT sign-in and a real phone, run once per kit release.

## Troubleshooting

| What you see | What to do |
|---|---|
| Getting things ready on this computer. The first time takes a few minutes. | The engine is installing into `.state`; wait for `Ready.` It needs the network this once. |
| This computer couldn't start the helper. Restart the app to try again. | See `.state/logs/openclaw.log` for why, then restart `npm start`. The first install needs the network. |
| Something stopped. Starting it again by itself. | The engine stopped and the kit is starting it again; wait for `Ready.` |
| This app needs an update to keep working. | The engine in `.state` isn't the one this kit pins even after installing it; restart `npm start`, and `npm i` a newer `@byokit/openclaw` if it keeps saying this. |
| Sign in with ChatGPT to start. | Tap **Sign in with ChatGPT** and type the code on ChatGPT's page. |
| Another sign-in is already in progress. Finish or cancel it, then try again. | Another device is signing in on this computer; finish it there, or wait for it to run out. |
| The sign-in took too long. Start it again. | The code ran out; tap **Sign in with ChatGPT** for a new one. |
| ChatGPT needs a break until {time}. | Your plan's limit is reached; it comes back by itself at that time. |
| Your ChatGPT plan doesn't include this. | The plan can't use what was asked; try a smaller request, or another plan. |
| Can't reach ChatGPT right now. This keeps trying by itself. | Check this computer's internet connection. |
| Nobody answered in time, so this wasn't allowed. (in the helper's reply) | A request waited too long for a yes; send the message again and answer it. |
| This device can't do that. Ask the person at the computer. | This phone was paired to watch only; pair it again from this app's codes. |
| Can't reach your computer. Check it's on and connected. (while pairing) | Phone and computer need the same network or tailnet; check the address printed in the terminal opens on the phone. |
| Can't reach {computer} right now. This device keeps trying by itself. | The app on the computer stopped, or the phone left its network; start it again with `npm start` and the phone reconnects by itself. |
| That code didn't match. Check it, or show a new one on your computer. | Press Enter in the terminal for fresh codes and type the new one. |
| Your computer said no to this device. | Someone answered `n` in the terminal; pair again and answer `y`. |
| This device was removed on {computer}. | Its pairing was deleted from `.state/grants.json`; pair again. |
