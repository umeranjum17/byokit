# Herdr move: the new pane's shell confirms the account env

A host app calls `kit.move({ paneId, kind, args, set, unset? })` (or `moveToAccount`). Real Herdr 0.9.1
applies the `pane.split` env but never reports it in `pane.get`, so the kit asks the new pane's own
shell: one private sourcing line tests every `set` value exactly and every `unset` name absent, and
prints a marker, never a value. A pane that did not receive the env refuses the move with `env_mismatch`
and is closed; the source pane stays.

## Sub-features

- `move-confirmed`: the move resolves `ok` while `pane.get` of the new pane carries no `env`.
- `mismatch-refused`: an `unset` name the new shell still holds (`PATH`) refuses with `env_mismatch`, fast.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md). Stand-in Herdr only (`startFakeHerdr`, `world: { kinds: ['claude'] }`).

- **Write the consumer.** `"$scratch_dir/verify-herdr-move-env.mjs"`: start the fake and an adopt-mode `HerdrKit`;
  `kit.move({ paneId: 'w1:p2', kind: 'claude', args: ['--resume', <the agent_session value>], set: { CLAUDE_CONFIG_DIR: '/verify/account' }, timeoutMs: 3000 })`
  resolves `ok`; `kit.call('pane.get', { pane_id })` for the new pane has no `env` key; a second move with
  `unset: ['PATH']` resolves `{ ok: false, code: 'env_mismatch' }`. Exit non-zero on any mismatch, then stop the kit and fake.
- **Run and capture.** `feature=herdr-move-env-verify; entry=@byokit/herdr; drive=(node "$scratch_dir/verify-herdr-move-env.mjs")`;
  then SKILL.md Evidence's capture block. Exit code `0`.
- **Shows.** `move true`, then `unset-present false env_mismatch`.
- **Real Herdr.** The lab proof (isolated session through the fleet helper, no agent CLI) drives `verifyPaneEnv` on 0.9.1: exact values pass, a wrong value, a held `unset` name and a pane split without the env all fail, and no value reaches the scrollback.
