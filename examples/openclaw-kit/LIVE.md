# Live check: real engine, real ChatGPT sign-in, real phone

The e2e test proves the flow against the kit's fake Gateway. This is the same flow once per `@byokit/openclaw`
release with the real thing (docs/runtime-kits.md section 8), run in the isolated lab: the pinned engine installed
into this folder's `.state`, a ChatGPT sign-in kept in the lab's retained test home, never a person's own HOME,
`~/.openclaw`, `~/.codex` or sign-ins.

## Procedure

1. In the lab, with the lab's retained test `HOME`: pack the release candidate's packages
   (`npm pack -w packages/{openclaw,link,relay,reach,seal,ui-core}`), copy this folder somewhere short (the kit's
   bridge socket lives under `.state/`), `npm i` the tarballs and `esbuild`.
2. `npm start -- --via tailscale-direct` (or `tailscale` / `lan`, whichever the lab has). The first start installs
   the pinned engine (`openclaw@2026.8.1`): see `Getting things ready on this computer…`, then `Ready.` Record the
   address printed and the engine version in `.state/openclaw/engine/node_modules/openclaw/package.json`.
3. On a phone on the lab tailnet: scan the QR code; check the two words match; answer `y` in the terminal.
4. Tap **Sign in with ChatGPT**; the phone shows a code and the ChatGPT page. Sign in with the lab's test ChatGPT
   account and type the code; the phone moves to **Talk to it** by itself. (Already signed in from an earlier run:
   sign out from the phone first, so the sign-in itself is proven.)
5. Send `Say hello in five words.`: the reply streams in and ends; no error line under it.
6. Send `Use the demo_note tool to save a note that says live check.`: the phone shows **Your helper wants to save a
   note. Allow it?** Tap **Allow**: `.state/notes.txt` ends with `live check`, and the reply says it was saved.
7. Send the same with `denied check` and tap **Deny**: `.state/notes.txt` is unchanged, and the run still ends.
8. Restart `npm start`: the phone reconnects without pairing again, and goes straight to **Talk to it** (the
   engine kept the sign-in). Once over `--via lan` too (plain http): pair, reload the page, still paired.
9. Check the lab HOME's canaries (`~/.pi`, `~/.openclaw`, `~/.codex`, `~/.claude`) are untouched: everything this
   app wrote is under this folder's `.state`.
10. Screenshot each step on the phone; record the results below and in the PR.

## Results

| Date | Kit version | Engine version | Route | Steps passed | Screenshots | Notes |
|---|---|---|---|---|---|---|
| 2026-10-04 | 0.6.0 (this tree, `0913c2d2`) | `openclaw@2026.8.1` (published pin, unmodified) | lan (app boot) + task-owned Android emulator WebView | 1, 2, 3, 9 | 9 stills + 1 screen recording of the pairing/sign-in request (private lab, attached to the PR) | Steps 4–8 have written reasons below: the one missing input is a human ChatGPT sign-in. No person's own sign-in, HOME or token was read or copied. |

### 2026-10-04 run notes (0.6.0 against published `openclaw@2026.8.1`)

Isolation: a task-owned empty lab `HOME` and a task-owned `.state` held the engine, the bridge socket and the
retained test account; the four lab canaries (`~/.pi`, `~/.openclaw`, `~/.codex`, `~/.claude`) were `OK` before
and after every step. The person's own `HOME`, `~/.pi`, `~/.codex` and sign-ins were never read, copied or
written. No upstream patch, fork or locally modified engine build took part: the pin installed from npm and
answered on its own HTTP page.

What passed:

- Step 1 — the release candidate's packages packed, the copied folder installed them and bundled the web app.
- Step 2 — the first start printed `Getting things ready on this computer…` then `Ready.`, and `GET /` on the
  printed address returned 200. The engine in `.state/openclaw/engine/node_modules/openclaw` reported `2026.8.1`.
- Step 3 — the real app paired with the real engine: the QR code, the two words to compare and the terminal `y`
  all took part, and the app reached **Connected to Umer**.
- Step 9 — every canary still `OK`; everything the app wrote stayed under the folder's `.state`.

What did not pass, and why:

- Step 4 (ChatGPT sign-in) — the app reached the real consent step and displayed a real sign-in request, then the
  request expired on its own (`The sign-in took too long. Start it again.`). The only authorized way to complete
  that consent is a browser already signed in to OpenAI. On this machine the shared desktop browser's OpenAI
  session has ended: the sign-in page shows only `Your session has ended` with a `Log in` button. Completing it
  needs a person's own authentication, so no password was typed, no account was created and no stored credential
  or existing token was used. This is the single missing input for steps 5–8.
- Steps 5, 6, 7 (streaming reply, **Allow**, **Deny**) — each one starts by sending a message to the engine, which
  answers only once step 4 completes. Unverified here, not failing: the kit's own e2e test drives the same flow
  against the fake Gateway.
- Step 8 (restart and reconnect without pairing) — the same missing sign-in: the app can only go straight to
  **Talk to it** when the engine still holds the sign-in.
- Step 10 (a still per step, one recording per kit) — partial: the captures cover boot, pairing and the sign-in
  request. A recording of the signed-in journey cannot exist until step 4 completes.

Media: the captures live in the task's private lab (`.lab/evidence/openclaw-live-method-change-0913c2d2/` and
`.lab/evidence/openai-session-0913c2d2/`, each `captions.json` naming the commit) and are attached to the PR.
They are deliberately not committed here: this repository is public and the captures carry a lab host address, a
pairing code and a device sign-in code.

