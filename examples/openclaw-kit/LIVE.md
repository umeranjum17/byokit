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
