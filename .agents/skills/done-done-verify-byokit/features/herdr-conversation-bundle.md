# Carry a Pi or Claude conversation between computers

Outcome: an app carries one Pi or Claude Code conversation between two explicit account folders through the built
host kit, without knowing transcript layout or moving sign-ins. Claude proof uses an existing local transcript,
copied unchanged into isolated folders; the journey never starts a CLI or reads credentials.

## Drive

Build the SDK, then write a task-private plain Node consumer outside the repository. Resolve only the built
public `@byokit/herdr` and `@byokit/herdr/testing` entries using `createRequire` rooted at the checkout;
assert that resolution ends in `dist/index.js`. Do not import the internal conversation module.

1. Allocate owned scratch, resolve its physical path with `realpathSync`, then make isolated account folders
   A and B there. Platform temp-directory aliases must not turn a bounds test into a path-safety refusal.
   Keep the explicit negative symlink cases below. Seed A with a default Pi session fixture, using the documented
   layout cited by `packages/herdr/src/conversations.ts`, plus a separate synthetic credential canary.
2. Run `startFakeHerdr` in a short private scratch path. Start the exported host kit against its socket,
   then call `startAgent` against the fake only, with an explicit replacement HOME and PI_CODING_AGENT_DIR,
   an offline fixture model name and `installProbe: { path: [] }`. The fake does not launch a CLI or model.
   Publish the fixture's session through the fake's documented world handle.
3. Call `kit.exportConversation(ref, { to })`, then `importConversation` into B with the returned kind and id.
   Print the typed receipts, manifest's relative paths/sizes/digests and a digest of B's filename/mode/content
   tree. Compare the restored file byte-for-byte, verify that the credential canary is absent from the bundle,
   and export B through the same public API to compare the two complete bundles byte-for-byte.
4. Exercise both a published session path and id. Show typed existing-conversation, lowered-bound,
   digest-tamper, duplicate-path, traversal, symlink and special-file refusals without printing payload text.
5. For rollback, seed an additional same-id file in another writable session directory. Make the incoming
   destination directory read-only, request overwrite and compare B's tree digest before/after failure.
   Originals must be byte-identical, including the extra file removed before placement failed. Restore the
   directory's observed mode, never a guessed mode. Check that private staging was removed.
6. Close the kit and fake in finally blocks and remove only this run's scratch directory. No real Herdr,
   agent CLI, sign-in, model session or lifecycle command is driven.

Run that consumer with `done-done run -- node "$CONVERSATION_CAPTURE" "$SCRATCH"` from the clean committed
checkout, with the task's approved evidence root configured. The consumer writes its actual stdout to
`$DONE_DONE_EVIDENCE_ROOT/conversation.log` and `steps.json` in the same folder. Retain the consumer source,
command and output with the private evidence. Judge the sealed capture through `done-done receipt` for the
bounded outcome above, never an unperformed CLI resume.

## Claude real-session drive

With an existing real Claude session file selected from `~/.claude/projects`, copy it into an exclusive task
scratch folder (never modify the source), then run the public built-package consumer in an open done-done evidence run:

```sh
done-done run --open
DONE_DONE_EVIDENCE_ROOT="$EVIDENCE_DIR" node .agents/skills/done-done-verify-byokit/capture/herdr-claude-conversation.mjs "$SCRATCH" "$CLAUDE_TRANSCRIPT"
done-done run --close "$RUN_ID"
```

The capture prints receipts only, writes `conversation.json` and `steps.json` to the run evidence folder,
verifies byte-identical restored history and same-ID/same-digest re-export, and never prints transcript text.
Keep the copied private transcript out of the repository and remove the registered scratch folder after the run.

## Limits

Pi's default JSONL store and Claude Code's per-project JSONL transcripts are supported. Codex, opencode and
Gemini remain unsupported. The real Claude journey copies one existing transcript into isolated folders, imports
it, and confirms its unchanged conversation ID and digest on a fake resume; it does not start a real CLI. A real
CLI resume on a second computer needs the agent's own sign-in there and belongs to muxr's next journey. No
example UI is added. Subscription/API billing labels are unchanged.
