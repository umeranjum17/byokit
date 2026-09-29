# Live check: real Herdr, real phone

The e2e test proves the flow against the kit's fake Herdr. This is the same flow once per `@byokit/herdr` release
with the real thing (docs/runtime-kits.md section 8), run in the isolated lab under a `--herdr-lab` brief: never a
person's own Herdr, HOME or agent sign-ins.

## Procedure

1. In the lab, with a task-owned empty `HOME`: install Herdr v0.9.1 from the release asset H2 recorded
   (`packages/herdr/schema/SOURCE.md`) into a task-owned folder; check its sha256 and `herdr --version`.
2. Pack the release candidate's packages (`npm pack -w packages/{herdr,link,relay,reach,seal,ui-core}`), copy
   this folder somewhere short (the Herdr socket lives under `.state/`), `npm i` the tarballs and `esbuild`.
3. `npm start -- --herdr <absolute herdr path> --path "<folder with one agent program>:/usr/bin:/bin" --via tailscale-direct`
   (or `tailscale` / `lan`, whichever the lab has). Record the address printed.
4. On a phone on the lab tailnet: scan the QR code; check the two words match; answer `y` in the terminal.
5. Start an agent; sign it in once inside its own screen (`HERDR_SOCKET_PATH=.state/herdr/herdr.sock herdr` at the
   lab computer, in the lab `HOME`).
6. From the phone: send a message, see the reply on the agent's screen, see `Ready for you.` again.
7. Ask the agent for something that needs permission; answer from **Questions for you** with each of the key
   buttons at least once over the run (`Enter`, `y`, `n`, `Esc`: the app sends Herdr the key names `Enter`, `y`,
   `n`, `Escape`); the question leaves the list and the agent carries on.
8. Restart `npm start`: the phone reconnects without pairing again; the agent's sign-in is still there.
   Once over `--via lan` too (plain http): pair, reload the page, still paired.
9. Screenshot each step on the phone; record the results below and in the PR.

## Results

| Date | Kit version | Herdr version (sha256) | Agent | Route | Steps passed | Screenshots | Notes |
|---|---|---|---|---|---|---|---|
| | | | | | | | |
