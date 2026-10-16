# Service kit: per-user systemd unit (Linux)

`@byokit/service` writes one `byokit-<name>.service` per-user systemd unit through `@byokit/cloud/unit`,
starts it with `systemctl --user enable --now`, reads it back with `status()` and removes it with
`uninstall()` ([spec](../../../../docs/service-kit.md)). The real install only ever runs on a **disposable
GitHub-hosted runner**: never install a unit on this host, the person's computer.

## Built consumer on this host (refusals only, nothing installed)

Build and run Doctor from SKILL.md first. From the worktree root, with the skill's Evidence block
(`feature=service-linux`, `entry=<scratch>/service-refusals.mjs`, `drive=(node "$entry")`):

```js
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(process.cwd() + '/');
const k = await import(require.resolve('@byokit/service'));
console.log('built-entry:', require.resolve('@byokit/service'));
for (const [o, code] of [[{ name: 'Bad' }, 'bad-name'], [{ name: 'echo', bin: 'rel/echo' }, 'bad-bin'], [{ name: 'echo', bin: '/nonexistent/echo' }, 'missing-bin']]) {
  await assert.rejects(k.install(o), (e) => e instanceof k.ServiceError && e.code === code);
  await k.install(o).catch((e) => console.log('typed-error:', e.code, e.message));
}
await assert.rejects(k.status({ name: 'Bad' }), { code: 'bad-name' });
const linger = new k.ServiceError('linger', 'refused', { detail: { command: 'sudo loginctl enable-linger umer' } });
console.log('words:', k.stateWords({ phase: 'running' }, { app: 'Tracker' }), '|', k.errorWords(linger, { app: 'Tracker' }));
```

Every refusal rejects before any command runs or any path is written.

## Real host (disposable runner only)

CI job `service-linux` (`.github/workflows/ci.yml`) on `ubuntu-latest`: `loginctl enable-linger` without
`sudo`, then `node --test packages/service/test/linux.journey.ts`. The file runs the one `serviceContract`
suite (see [service-testing](./service-testing.md)) against the real manager and the section 7 journey: it installs a node loopback echo
as `bin` and asserts `status` `not-installed` → `running`, `systemctl --user is-active` `active`, `Linger=yes`,
the echo answering on 127.0.0.1, a manual stop reading `status` `stopped`, a re-install restarting it, then after `uninstall` the unit file gone,
`is-active` `inactive` and `status` `not-installed`. It skips anywhere but GitHub Actions on Linux. Before it, the same job proves a refused linger: a setup step
(sudo, setup only; the kit never runs sudo) denies the runner's own linger with a polkit rule, then
`linger.journey.ts` asserts `ServiceError` `linger` with `detail.command` `sudo loginctl enable-linger runner`, linger
still off and the unit file present (spec 4.1 writes it first); the rule is lifted, linger re-enabled, and the
leftover unit uninstalls. CI job `service-macos` (`macos-latest`) runs `unsupported.journey.ts`: `install` and
`uninstall` reject `unsupported`, `status` resolves `{ phase: 'unsupported' }`, nothing written.

Before a PR exists, run the same job from a throwaway branch with a one-job workflow (`on: push` to that
branch only), save the run log as evidence, and delete the branch. Pass = the test line shows `✔`, not skipped.
Reboot and sign-out survival is unproven: a hosted runner never reboots under the job.
