# Herdr blocked approvals answered from a phone

An agent that is `blocked` is a question, and the answer is keys sent to that exact pane occupant. A
person answers Allow, Deny or Skip from their phone; the kit refuses an answer whose question has moved
on (`approval-stale`) instead of typing it into whatever holds the pane now. This is the real-agent
proof: a real Herdr session, a real Cursor agent prompted into its own permission dialog, answered only
through `blocked()` / `answer()`.

## Sub-features

- `allow`: `answer(paneId, ['y'], { revision })` runs the pending command, and the pane leaves `blocked`.
- `deny`: `answer(paneId, ['n'], …)` refuses it; the command does not run and the agent reports the
  rejection.
- `skip`: `answer(paneId, ['esc'], …)` dismisses the dialog the same way, with nothing run.
- `stale-refused`: an answer carrying the previous question's `revision` is refused on a live question,
  nothing is typed, and the current revision still answers it.
- `question-identity`: the kit names each question itself; Herdr's own pane revision is not the identity
  (v0.9.1 reported one revision for four consecutive Cursor questions), and a question that changes while
  the pane stays `blocked` is refused and republished under a new revision.

## How to get to it (user POV)

- An app adopts a running Herdr (`new HerdrKit({ mode: 'adopt', bin, socketPath })`, `await kit.start()`),
  starts an agent (`kit.startAgent({ kind: 'cursor', cwd, place: { workspace: 'new' }, env: { HOME } })`)
  and prompts it into its own approval dialog (`kit.prompt(agent, 'Run exactly …')`).
- The app lists the question from `kit.blocked()` (the pane's `detection` text is `prompt`) and answers it
  with `kit.answer(paneId, keys, { revision })` — the same path a paired phone drives over
  `hd.blocked` / `hd.answer` (features/README.md, the herdr-kit example).

## Driving it

Preconditions: baseline (features/README.md); `/usr/bin/herdr` at the pinned version (`herdr --version`
prints `herdr 0.9.1`); a signed-in `cursor-agent` on PATH; and an **isolated, non-default Herdr session**
provisioned and torn down by the environment's Herdr lab helper (never the person's own session). The
agent runs as that installed CLI under `APPROVALS_LAB_HOME`, so it is signed in exactly as the app's agent
would be; the Herdr server keeps the helper's disposable HOME. Cursor quota is spent: four agent turns.

- **Drive.** `HERDR_LAB_HELPER=<bin/jg-herdr-lab.sh> APPROVALS_LAB_HOME=<signed-in home>` then SKILL.md
  Evidence's capture block with
  `feature=herdr-blocked-approvals; entry=.agents/skills/done-done-verify-byokit/capture/herdr-blocked-approvals.ts;
  drive=(node .agents/skills/done-done-verify-byokit/capture/herdr-blocked-approvals.ts)`.
- The capture provisions one named lab session, runs `packages/herdr/test/lab/approvals.lab.ts` against
  its socket, tears the session down on every exit path, and writes `approvals.json` and `approvals.log`
  into the run's evidence folder. Exit code `0` only when the journey passed and both files exist.
- **allow shows.** The question was `blocked` with the dialog in `prompt` ("Run this command?", "Run
  (once) (y)", "Skip & tell the agent what to do instead (esc or n)"); `keys ["y"]` leaves the pane
  `idle`, and the command's own file exists with the written text.
- **deny / skip show.** The same question answered `["n"]` and `["esc"]`; the pane leaves `blocked`, the
  agent answers "the command did not run / rejected", and the command's file does not exist.
- **stale-refused shows.** `stale.stillBlocked` true, `stale.commandRan` false, `stale.dialogUnchanged`
  true, and `refusedRevision` from the previous question against `currentRevision` on the live one; the
  live question still answers and runs. `paneRevisionOfAnswered` equals `paneRevisionOfLive` — Herdr's own
  revision did not move, which is why the kit issues the identity.

## Gotchas

- Cursor's run-command dialog offers one refusal (`esc` or `n`, "Skip & tell the agent what to do
  instead"); it has no separate Deny key. After a refusal it opens a "tell the agent what to do instead"
  line — an empty Enter skips it, and the journey does that before prompting again.
- The dialog's `Tab` ("add to allowlist") approves *and* allowlists the command for the account, after
  which that binary runs without a dialog. Never press it in this proof; a run that uses an allowlisted
  binary silently proves nothing.
- Cursor writes files without a dialog in this build, so only the run-command question is reachable; the
  "write to this file?" rule in the Cursor detection manifest was not observed here.
- Keep each question's command distinct so the captured text and the side effect identify the leg.
- The lab session's socket must stay under 108 bytes; the helper owns the short path.
