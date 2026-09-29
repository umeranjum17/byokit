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
| 2026-09-29 | 0.1.0 (RC, this tree) | 0.9.1 (`2a02fed1…5c54b7`, matches `packages/herdr/schema/SOURCE.md`) | none — skipped, see §5 | lan (app boot) + loopback (H7 link proof) | 1, 2, 3 (boot only) | none — no phone in the lab | Lab run under a `--herdr-lab` brief; fleet `default` tripwire verified unchanged at teardown. Phone/agent steps skipped with reasons below. |

### 2026-09-29 run notes (release 0.1.0)

- Lab isolation: provisioned `fm-lab-byk-hd-publish-*` via `bin/fm-herdr-lab.sh`; the running
  fleet `default` session (`/home/umer/.config/herdr/herdr.sock`) was recorded before anything
  started and verified identical at teardown. Task `HOME` and all state lived under a
  task-owned scratch dir; the person's own Herdr, HOME and sign-ins were never touched.
- Step 1: asset `herdr-linux-x86_64` downloaded from the H2-recorded URL into the task dir,
  sha256 `2a02fed16beb651ef006e1d43f048f652ca4dc58ad053cd2d44450563d5c54b7` recomputed over
  the bytes, `herdr --version` → `herdr 0.9.1`.
- Step 2: packed the RC (`byokit-herdr-0.1.0.tgz`, `byokit-link-0.3.1.tgz`,
  `byokit-relay-0.1.3.tgz`, `byokit-reach-0.2.0.tgz`, `byokit-seal-0.1.0.tgz`,
  `byokit-ui-core-0.2.0.tgz`), copied this folder to a short task path, `npm i` the tarballs,
  `esbuild` bundled `web/app.ts` clean.
- Step 3 (boot only): `node host.ts --herdr <task asset> --path "<empty task dir>:/usr/bin:/bin"
  --via lan --port 7310` printed the QR code, a pairing code and
  `http://192.168.1.144:7310/`, then `Connected to Herdr.`; `GET /` over loopback → 200
  (the Agents page). The host stopped cleanly afterwards. Pairing/code-words confirmation
  needs a phone, so the rest of step 3 is skipped.
- Own-mode kit proof: `packages/herdr/test/lab/contract.lab.ts` against the same asset in
  `own` mode — **17 pass, 0 fail, 10 skipped** (same shape as `packages/herdr/schema/LAB.md`);
  the H7 link/device/notices/terminal-over-link cases pass over a real Host + DeviceLink pair
  on loopback. Every skip needs a signed-in agent CLI or a fake-only helper.
- §4, §6–§9 (phone): skipped — no phone on the lab network and no human to scan/confirm words.
- §5 (agent sign-in): skipped — no agent CLI can be signed in inside the lab home without a
  human login. The pinned schema offers no unsigned custom kind (`agent start --help` lists
  `pi` among possible values, no `bash`), so no agent path exists that avoids a sign-in.
  The lab contract run records the same skips with the same reason.
