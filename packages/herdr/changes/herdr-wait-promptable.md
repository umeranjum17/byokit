- `@byokit/herdr` exports `isPromptable(agent)`, the single readiness gate `prompt` already used, and adds
  `kit.waitPromptable(target, { timeoutMs })`: it waits until a just-started agent can take a prompt instead of the
  host polling `prompt` and catching `agent-not-ready`. It resolves once the kit's snapshot is promptable, rejects
  `agent-not-ready` at the deadline, and rejects `pane-unavailable` when the pane closes mid-wait.
