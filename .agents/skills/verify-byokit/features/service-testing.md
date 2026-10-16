# Service kit: the fake exec and the contract suite (`./testing`)

`@byokit/service/testing` ships `FakeSystemd` — a fake `ServiceExec`, an in-memory `systemd
--user` that answers the commands the kit runs (`mkdir -p`, cloud's WRITE_SHELL,
`loginctl enable-linger`, `systemctl --user …`, `test -f`, `rm -f`) — and `serviceContract`,
the one contract suite that runs the same assertions against the fake and a real manager
([spec](../../../../docs/service-kit.md)). The whole journey runs through the `exec` seam, so
nothing touches a real manager, a real unit file or the network; the real-manager half is
CI job `service-linux` (see [service-linux](./service-linux.md)).

## Built consumer on this host

Build and run Doctor from SKILL.md first. From the worktree root, with the skill's Evidence block
(`feature=service-testing`, `entry=<scratch>/service-testing.mjs`, `drive=(node "$entry")`):

```js
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(process.cwd() + '/');
const k = await import(require.resolve('@byokit/service'));
const t = await import(require.resolve('@byokit/service/testing'));
console.log('built-entry:', require.resolve('@byokit/service/testing'));
const fake = new t.FakeSystemd();
await k.install({ name: 'tracker', bin: process.execPath, env: { PORT: '4400' }, exec: fake.exec });
assert.deepEqual(await k.status({ name: 'tracker', exec: fake.exec }), { phase: 'running' });
const order = fake.runs.map((r) => r.argv[0]);
assert.deepEqual(order.slice(0, 6), ['test', 'mkdir', 'sh', 'loginctl', 'systemctl', 'systemctl']);
assert.ok(fake.unitBytes('tracker').includes('ExecStart='), 'the unit bytes the renderer wrote');
await k.uninstall({ name: 'tracker', exec: fake.exec });
assert.deepEqual(await k.status({ name: 'tracker', exec: fake.exec }), { phase: 'not-installed' });
fake.lingerOk = false;
await k.install({ name: 'tracker', bin: process.execPath, exec: fake.exec })
  .then(() => assert.fail('expected a linger refusal'))
  .catch((e) => console.log('typed-error:', e.code, e.detail.command));
assert.equal(fake.runs.filter((r) => r.argv[0] === 'sudo').length, 0, 'never sudo');
console.log('words:', k.stateWords({ phase: 'stopped' }, { app: 'Tracker' }));
```

The fake never leaves memory: `fake.runs` records every command, `fake.unitBytes` reads the
rendered unit, `setShow` forces `status` states, `lingerOk = false` models the polkit refusal
and `fail` models a failing command.

## The contract suite

`serviceContract(label, make)` runs the same assertions against every bench (spec 8):

- `packages/service/test/contract.test.ts` — the fake bench; runs locally, under
  `scripts/test.sh` (throwaway HOME) and in the CI `check` job's `npm test`.
- `packages/service/test/linux.journey.ts` — the real `systemd --user` bench plus the section 7
  journey; runs in CI job `service-linux` on a disposable runner, skipped anywhere else.

Case names carry the label (`fake 1: …`, `systemd --user 1: …`); cases marked `(fake)` need the
fake's observation points and skip on a real manager.
