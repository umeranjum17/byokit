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
It also shows the helper's browser sign-in with a synthetic fixture (the kit's offline browser fake, no Chromium,
no real site): a "Sign in to 127.0.0.1" card waits on `http://127.0.0.1:2820`, takeover shows a labelled stand-in
page live, and Done puts "Signed in to 127.0.0.1 ✓" under the chat. It shows the screens only; it is not browser
protection.

## Away from home: a relay, and notices only the phone can read

`npm start -- --relay https://relay.example` (a relay you run with `@byokit/relay`; add `--enrol <token>` from its
owner on the first start) makes the computer dial out to the relay, so it needs no open port. The terminal also
prints a short code for the relay, and the QR code carries the relay's address too, so a paired phone reaches the
computer from anywhere.

When the helper asks before it acts, the kit sends a notice through the relay to each phone that registered a notice
key and a push address, sealed to that phone's key, with **Allow** and **Deny** on it. A phone app does three things
(`e2e.test.ts` does them in plain Node, as the phone):

```ts
const oc = openclawDevice(link);
await oc.registerNotices(seed);                              // a 32-byte seed only the phone keeps
await link.request('example.push', { expo: expoPushToken }); // its push address, handed to the relay
const approval = oc.openNotice(push.data.data, seed);        // push.data: the notification's data; null unless sealed to it
```

A button pressed on the notice posts `{ token, action }` to the relay's `/relay/v1/push/action`; the relay hands it
to the computer, and the kit (`onAction`) allows or denies. What the push service got in the test run (the envelope
cut short):

```json
{ "to": "ExponentPushToken[away-phone]", "collapseId": "gyX9IxUyWw5_I0os", "priority": "high",
  "data": { "id": "gyX9IxUyWw5_I0os", "title": "Something is waiting for your yes.",
            "data": { "v": 1, "sealed": "FPEu1pJJHgVBEAxv…" }, "actions": ["allow", "deny"], "action": "UhtgFSHSvIKrUmmP…" },
  "title": "Something is waiting for your yes." }
```

The relay and the push service read the kit's generic title, the approval's id (the relay sends each id once) and
the one-use token for its buttons. What the helper wants to do is inside `sealed`. `e2e.test.ts` fails if
any of it shows up on the wire, or if another key opens it. A phone that registered no notice key gets the title
only. This web page takes no push notices itself; a phone app does.

## What's where

- `host.ts`: `new OpenClawKit({ stateDir: './.state', tools: [demo_note], host, config: { plugins: { allow:
  ['openai'] } } })`. `demo_note` (`{ text }`) is gated `{ ask: { summary: 'save a note' } }` and appends to
  `.state/notes.txt`; the engine's own tools ask too. A `@byokit/link` host (key in `.state/link-key.json`, paired
  phones in `.state/grants.json`) answers the phone with `openclawLink(kit, { memberOf: () => 'me' })`: every paired
  phone acts for this app's one member. `serve` finds the address (`@byokit/discover`) and serves the page on the same
  port. With `--relay`, a `RelayClient` made once the host is open carries the kit's sealed notices and brings
  their buttons back (`onAction`), and `example.push` hands a phone's push address to it.
- `web/app.ts`: plain DOM. Pairs with `pairWithCode`/`pairWithOffer` and keeps the pairing in this browser
  (`browserDeviceStore`); then `openclawDevice(link)`: `signIn.start('openai', 'code')` and `signIn.view` through
  `@byokit/ui-core`'s `phaseOf` for the sign-in card, `run` for the streamed reply, `approvals`/`events`/`decide` for
  what waits for a yes. Every status is a sentence from the kit (`words`, `oc.state().words`) or `@byokit/ui-core`
  (`pairingView`, `linkWords`). Sign-ins for the helper's browser: `@byokit/ui-core/kits`' `signInsStore` over
  `oc.browser.signIns` and `oc.events`, each request drawn from `signInSheetView`, takeover into
  `oc.browser.live(source, { lease })` drawn from `livePanelView` (`web/browser.ts`).
- `e2e.test.ts`: packs the packages, installs them into a copy of this folder, runs `host.ts` against the kit's fake
  Gateway and drives a phone-sized headless Chromium through all of the above, Allow and Deny both, then the fixture
  browser sign-in (screenshots named `fixture-*`); then, through a loopback relay whose push service is a recorder, a
  phone in plain Node gets an approval sealed and allows it from the notice. From the repo:
  `npm run build && sh scripts/test.sh examples/openclaw-kit/e2e.test.ts` (`BYOKIT_EXAMPLE_SHOTS=<folder>` keeps
  the screenshots and `relay-wire.json`, what the push service got).
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
