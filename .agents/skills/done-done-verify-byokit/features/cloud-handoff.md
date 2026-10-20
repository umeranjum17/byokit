# Cloud run and handoff (app command on the computer)

An app runs its own host command the way the unit runs it, and hands off pairing through a command that picks its own offer file name and blocks until the phone answers. `machine.run(recipe, argv, o?)` runs as the run user in `workDir` with the unit's Node first on `PATH` and `recipe.run.env` set; `machine.newest(recipe, prefix)` reads the newest `<prefix>*` outbox file; `machine.handoff(recipe, argv, { prefix, timeoutMs? })` clears old `<prefix>*` outbox files, starts the command, yields each new offer as `{ file, text }`, delivers answers to the inbox and resolves `done` with the command's `ExecResult`. The `setup()` `pair` gate gets `ctx.run` and `ctx.handoff`.

## Sub-features

- `run-bench`: `sh scripts/test.sh packages/cloud/test/journey-cloud.test.ts` (`an app runs its own command on the kit machine…`): the run user, workDir, node dir and `env PORT=7310` reach the command; any exit passes through; a missing Node rejects `provider` and installs nothing; `newest` picks the last write by prefix.
- `handoff-bench`: same file (`a pair gate hands off through the app's own command…`): inside `setup({ create })`'s pair gate, a stale `muxr-pair-old.json` is gone before the command starts and never yielded, two offers under names the fake command picks stream once each, both answers land in the inbox, `done` is the command's result, `other.json` stays, a bad prefix rejects `bad-recipe`.
- `create-replay-bench`: same file (`a create whose answer was lost is retried with the same key…`): the kit-gap repro, a provider that makes the machine and loses the answer: one machine, one key.
- `shells-on-disk`: `sh scripts/test.sh packages/cloud/test/enrol.test.ts` (`on its own disk the newest offer is chosen by time, a handoff clears old offers…`): the real `NEWEST_SHELL`, `CLEAR_SHELL` and `WORKDIR_SHELL` on a real directory; directories and other prefixes survive the clear.
- `handoff-live`: `capture/cloud-handoff.mjs` on boat.dev, below.

## Live run (boat.dev)

Pack the built kit outside the repo (`npm pack --pack-destination <scratch>` in `packages/cloud`), then `feature=cloud-handoff; entry=@byokit/cloud; drive=(node .agents/skills/done-done-verify-byokit/capture/cloud-handoff.mjs "$boat_key_file" "$tgz")`, where `$boat_key_file` is the fleet's saved Boat key file. Run SKILL.md Evidence's capture block, then `leak_check` the Boat key read into a variable. It creates one `small` sandbox without copies and always deletes it; the driver drops Boat's first create answer after Boat made the machine.

Pass: `setup` is `["checking-access","creating","installing","pairing","ready"]`; `run-view.nodeOnPath` is `<unit-node-dir>/node` (the first entry of the unit file's `PATH`: on Boat a machine Node in range, `/usr/local/bin`, not the pinned one; `process.execPath` would show the symlink's nvm target), `cwd` is the recipe's `workDir` and `lab` is `"Umer"` from `recipe.run.env`; `offers` are two `lab-pair-<random>.json` with `words-1`, `words-2` and never `stale`; `handoff-done.stdout` is `words-1:two words\nwords-2:two words\n`; `new-machines: 1` and `lost-answer-made-this-machine: true`; `removed-1` is `"gone"`; `result: "PASS"`. First passed 2026-10-20. Follow the Boat rule in `cloud-claim.md` (fleet key never printed or revoked, delete only your own machine, no claim).
