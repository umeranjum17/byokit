// Boat adapter tests (docs/cloud-kit.md M4 acceptance): the adapter against the
// loopback fake server — rule 3 from the request log, every 6.2 row, exec/write/remove
// semantics, retries, usage/key/plan/why (G2, G3) and the trial retry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { machine } from '../src/machine.ts';
import { boat } from '../src/boat.ts';
import { startFakeSandboxServer, type SandboxServer } from '../src/testing/fake-sandbox-server.ts';
import { memoryStore } from '../src/testing/fake-provider.ts';
import type { MachineRef, Price, Provider } from '../src/types.ts';

const prices = (): readonly Price[] => [{
  size: 'small', perHour: 0.018, planFloorPerMonth: 20, asleepPerHour: 0,
  currency: 'USD', basis: 'incl. IPv4, excl. VAT', source: 'http://boat.test/prices', checked: '2026-09-29',
}];

const setup = async (server: SandboxServer, key = 'test-key'): Promise<{ provider: Provider; ref: MachineRef }> => {
  const provider = boat({ baseUrl: server.url, label: 'Test', prices: prices(), key: async () => key });
  const ref = await provider.create!({ name: 'web', size: 'small', keepCopies: true, idempotencyKey: 'bench-1' });
  return { provider, ref };
};

const bodies = (server: SandboxServer, method: string, path: string): unknown[] =>
  server.requests.filter((r) => r.method === method && r.path === path).map((r) => r.body);

test('rule 3: create carries noEnv, no body carries env, resume/fork carry no noEnv', async () => {
  const server = await startFakeSandboxServer();
  try {
    const { provider, ref } = await setup(server);
    server.setState(ref.id, 'archived');
    await provider.wake!(ref);
    await provider.snapshot!(ref, 'a');
    await provider.fork!(ref, { name: 'copy', size: 'small', idempotencyKey: 'bench-fork' });
    const creates = bodies(server, 'POST', '/sandboxes');
    assert.equal(creates.length, 1);
    assert.deepEqual(creates[0], { type: 'small', ttlSeconds: null, noEnv: true, snapshots: true });
    for (const r of server.requests) {
      if (r.body !== null && typeof r.body === 'object') {
        assert.ok(!('env' in (r.body as Record<string, unknown>)), `${r.method} ${r.path} carries env`);
      }
    }
    for (const resume of bodies(server, 'POST', `/sandboxes/${ref.id}/resume`)) {
      assert.ok(!('noEnv' in (resume as Record<string, unknown>)), 'resume carries noEnv');
    }
    for (const fork of bodies(server, 'POST', `/sandboxes/${ref.id}/fork`)) {
      assert.ok(!('noEnv' in (fork as Record<string, unknown>)), 'fork carries noEnv');
    }
  } finally {
    await server.close();
  }
});

test('trial: create, resume and fork retry once with 7200 and the same idempotency key', async () => {
  const server = await startFakeSandboxServer({ trial: true });
  try {
    const provider = boat({ baseUrl: server.url, label: 'Test', prices: prices(), key: async () => 'test-key' });
    const m = machine({ provider, store: memoryStore() });
    const ref = await m.create({ name: 'web', size: 'small', keepCopies: true });
    const creates = server.requests.filter((r) => r.method === 'POST' && r.path === '/sandboxes');
    assert.equal(creates.length, 2);
    assert.deepEqual((creates[0].body as Record<string, unknown>)['ttlSeconds'], null);
    assert.deepEqual((creates[1].body as Record<string, unknown>)['ttlSeconds'], 7200);
    assert.equal(creates[0].headers['idempotency-key'], creates[1].headers['idempotency-key']);
    server.setState(ref.id, 'archived');
    await m.wake();
    const resumes = bodies(server, 'POST', `/sandboxes/${ref.id}/resume`);
    assert.equal(resumes.length, 2);
    assert.deepEqual((resumes[1] as Record<string, unknown>)['ttlSeconds'], 7200);
    await provider.fork!(ref, { name: 'copy', size: 'small', idempotencyKey: 'fork-1' });
    const forks = bodies(server, 'POST', `/sandboxes/${ref.id}/fork`);
    assert.equal(forks.length, 2);
    assert.deepEqual((forks[1] as Record<string, unknown>)['ttlSeconds'], 7200);
    assert.equal(
      server.requests.find((r) => r.method === 'POST' && r.path === `/sandboxes/${ref.id}/fork`)?.headers['idempotency-key'],
      'fork-1',
    );
    // After the trial ends the next resume is accepted with null.
    server.setTrial(false);
    server.setState(ref.id, 'archived');
    const before = bodies(server, 'POST', `/sandboxes/${ref.id}/resume`).length;
    await m.wake();
    const after = bodies(server, 'POST', `/sandboxes/${ref.id}/resume`);
    assert.equal(after.length, before + 1);
    assert.deepEqual((after[after.length - 1] as Record<string, unknown>)['ttlSeconds'], null);
  } finally {
    await server.close();
  }
});

test('status maps every 6.2 row, waking after archived and during wake', async () => {
  const server = await startFakeSandboxServer({ slowWakeReads: 3 });
  try {
    const { provider, ref } = await setup(server);
    const rows: Array<[string, string]> = [
      ['init', 'creating'], ['provisioning', 'creating'], ['provisioned', 'creating'], ['cloning', 'creating'],
      ['ready', 'on'], ['idle', 'on'], ['running', 'on'],
      ['archiving', 'stopping'], ['archived', 'asleep'], ['error', 'failed'], ['cancelled', 'gone'],
    ];
    for (const [raw, mapped] of rows) {
      server.setState(ref.id, raw);
      assert.equal(await provider.status(ref), mapped, raw);
    }
    // Waking after archived: the adapter remembers the last provider state per id.
    server.setState(ref.id, 'archived');
    assert.equal(await provider.status(ref), 'asleep');
    server.setState(ref.id, 'provisioning');
    assert.equal(await provider.status(ref), 'waking');
    // During wake(): a concurrent status is waking, and wake resolves at on.
    server.setState(ref.id, 'archived');
    const waking = provider.wake!(ref);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await provider.status(ref), 'waking');
    await waking;
    assert.equal(await provider.status(ref), 'on');
    // A 404 is gone; a failed request is unknown.
    assert.equal(await provider.status({ ...ref, id: 'sb-nope' }), 'gone');
    server.failNext([{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }]);
    assert.equal(await provider.status(ref), 'unknown');
  } finally {
    await server.close();
  }
});

test('exec: quoting round-trips, root adds sudo, stdin is staged at 0600 and the code is kept', async () => {
  const server = await startFakeSandboxServer();
  try {
    const { provider, ref } = await setup(server);
    const argv = ['echo', "it's", 'a;b', '$x', 'back\\slash', 'plain'];
    server.machine.script('echo', { code: 0, stdout: 'hi\n', stderr: '', timedOut: false });
    const r = await provider.exec(ref, argv, { timeoutMs: 5000 });
    assert.deepEqual(r, { code: 0, stdout: 'hi\n', stderr: '', timedOut: false });
    const wire = bodies(server, 'POST', `/sandboxes/${ref.id}/commands`)[0] as Record<string, unknown>;
    assert.match(wire['command'] as string, /^timeout -k 10 5 /);
    assert.match(wire['command'] as string, /'it'\\''s'/);
    assert.deepEqual(wire['timeoutSeconds'], 15);
    assert.deepEqual(wire['detached'], false);
    assert.deepEqual(server.machine.runs.at(-1)?.argv, argv);

    await provider.exec(ref, ['true'], { timeoutMs: 1000, root: true });
    const rootWire = bodies(server, 'POST', `/sandboxes/${ref.id}/commands`).at(-1) as Record<string, unknown>;
    assert.match(rootWire['command'] as string, /^sudo -n timeout -k 10 1 /);
    assert.equal(server.machine.runs.at(-1)?.root, true);

    server.machine.script('cat', { code: 3, stdout: '', stderr: 'nope', timedOut: false });
    const input = new TextEncoder().encode('secret-bytes');
    const withInput = await provider.exec(ref, ['cat'], { timeoutMs: 5000, input });
    assert.equal(withInput.code, 3);
    assert.equal(withInput.stderr, 'nope');
    const staged = bodies(server, 'POST', `/sandboxes/${ref.id}/commands`).at(-1) as Record<string, unknown>;
    const stagedCmd = staged['command'] as string;
    const stagePath = / < (\/tmp\/byokit-in-[0-9a-z]{16}); r=\$\?; rm -f \1; exit \$r$/.exec(stagedCmd)?.[1];
    assert.ok(stagePath, `stdin wrapper keeps the exit code: ${stagedCmd}`);
    assert.equal(server.machine.runs.at(-1)?.inputBytes, input.length);
    assert.equal(server.machine.files.get(stagePath)?.mode, 0o600);

    server.machine.script('slow', { code: 124, stdout: '', stderr: '', timedOut: false });
    const timed = await provider.exec(ref, ['slow'], { timeoutMs: 2000 });
    assert.deepEqual([timed.code, timed.timedOut], [124, true]);
  } finally {
    await server.close();
  }
});

test('exec over 590s runs detached and reads the result from the command route', async () => {
  const server = await startFakeSandboxServer();
  try {
    const { provider, ref } = await setup(server);
    server.machine.script('long', { code: 0, stdout: 'done\n', stderr: '', timedOut: false });
    const r = await provider.exec(ref, ['long'], { timeoutMs: 600_000 });
    assert.deepEqual(r, { code: 0, stdout: 'done\n', stderr: '', timedOut: false });
    const posts = bodies(server, 'POST', `/sandboxes/${ref.id}/commands`);
    assert.equal(posts.length, 1);
    assert.deepEqual((posts[0] as Record<string, unknown>)['detached'], true);
    assert.ok(!('timeoutSeconds' in (posts[0] as Record<string, unknown>)), 'detached runs carry no provider timeout');
    assert.ok(server.requests.some((q) => q.method === 'GET' && q.path.startsWith(`/sandboxes/${ref.id}/commands/`)));
  } finally {
    await server.close();
  }
});

test('write outside /home/user/ and /tmp/ rejects before any request', async () => {
  const server = await startFakeSandboxServer();
  try {
    const { provider, ref } = await setup(server);
    const before = server.requests.length;
    const bad = await provider.write(ref, '/etc/evil', new Uint8Array([1]), 0o644).then(() => null, (e) => e);
    assert.equal(bad?.code, 'bad-recipe');
    assert.equal(server.requests.length, before);
    const bytes = new TextEncoder().encode('hello');
    await provider.write(ref, '/home/user/app/x.txt', bytes, 0o600);
    assert.deepEqual(server.machine.readFile('/home/user/app/x.txt'), bytes);
    assert.equal(server.machine.files.get('/home/user/app/x.txt')?.mode, 0o600);
  } finally {
    await server.close();
  }
});

test('create retries with the same Idempotency-Key after a dropped connection', async () => {
  const server = await startFakeSandboxServer();
  try {
    const provider = boat({ baseUrl: server.url, label: 'Test', prices: prices(), key: async () => 'test-key' });
    await provider.account();
    const m = machine({ provider, store: memoryStore() });
    server.dropNext(1);
    const ref = await m.create({ name: 'web', size: 'small', keepCopies: true });
    assert.equal(ref.name, 'web');
    const creates = server.requests.filter((r) => r.method === 'POST' && r.path === '/sandboxes');
    assert.equal(creates.length, 2, 'the dropped attempt was retried');
    assert.equal(creates[0].dropped, true);
    const keys = new Set(creates.map((r) => r.headers['idempotency-key']));
    assert.equal(keys.size, 1, 'every attempt carries the same key');
  } finally {
    await server.close();
  }
});

test('remove sends the delete-confirmation header, polls the deletion, then deletes only its own snapshots', async () => {
  const server = await startFakeSandboxServer();
  try {
    const { provider, ref } = await setup(server);
    await provider.snapshot!(ref, 'a');
    // A snapshot from another machine, plus an unrelated one, must survive.
    await provider.snapshot!({ ...ref, name: 'other' }, 'x');
    const listed = (await (await fetch(`${server.url}/named-snapshots`, {
      headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
    })).json()) as { snapshots: { name: string }[] };
    assert.ok(listed.snapshots.some((s) => s.name === 'byokit-web-a'));
    const m = machine({ provider, store: memoryStore({ ref, providerKey: '' }) });
    await m.remove(ref.id);
    const deleted = server.requests.find((r) => r.method === 'DELETE' && r.path === `/sandboxes/${ref.id}`);
    assert.equal(deleted?.headers['x-delete-confirmation'], ref.id);
    assert.ok(server.requests.some((r) => r.method === 'GET' && r.path.startsWith('/deletion-operations/')));
    const snapDeletes = server.requests.filter((r) => r.method === 'DELETE' && r.path.startsWith('/named-snapshots/'));
    assert.deepEqual(snapDeletes.map((r) => r.path), ['/named-snapshots/byokit-web-a']);
    assert.equal(m.ref, null);
  } finally {
    await server.close();
  }
});

test('401 rejects unauthorized, 429 and 5xx retry three times, and the key never leaks into errors', async () => {
  const server = await startFakeSandboxServer();
  try {
    const bad = boat({ baseUrl: server.url, label: 'Test', prices: prices(), key: async () => 'sk-secret-123' });
    const e = await bad.account().catch((err) => err);
    assert.equal(e.code, 'unauthorized');
    assert.ok(!e.message.includes('sk-secret-123'), 'the key never appears in an error message');
    const good = boat({ baseUrl: server.url, label: 'Test', prices: prices(), key: async () => 'test-key' });
    server.failNext([{ status: 429 }, { status: 503 }, { status: 500 }]);
    const before = server.requests.length;
    assert.equal(await good.account(), 'acct-test');
    assert.equal(server.requests.length - before, 4, 'three retries after the first attempt');
    server.failNext([{ status: 429 }, { status: 429 }, { status: 429 }, { status: 429 }]);
    const exhausted = boat({ baseUrl: server.url, label: 'Test', prices: prices(), key: async () => 'test-key' });
    const e2 = await exhausted.account().then(() => null, (err) => err);
    assert.equal(e2?.code, 'provider');
  } finally {
    await server.close();
  }
});

test('usage maps to Usage, a zero balance rejects balance, key maps expiry', async () => {
  const server = await startFakeSandboxServer();
  try {
    const { provider, ref } = await setup(server);
    const u = await provider.usage!(ref, '2026-09-01T00:00:00.000Z');
    assert.deepEqual(
      { from: u.from, hours: u.hours, amount: u.amount, currency: u.currency },
      { from: '2026-09-01T00:00:00.000Z', hours: 24, amount: 0.5, currency: 'USD' },
    );
    assert.match(u.to, /^\d{4}-\d{2}-\d{2}T/);
    server.setBalance(0);
    await assert.rejects(provider.usage!(ref, '2026-09-01T00:00:00.000Z'), /balance/);
    assert.deepEqual(await provider.key!(), { expires: null, scopes: [] });
  } finally {
    await server.close();
  }
  const keyed = await startFakeSandboxServer({ keyExpiresAt: '2027-01-01', keyScopes: ['read', 'resume'] });
  try {
    const { provider, ref } = await setup(keyed);
    assert.deepEqual(await provider.key!(), { expires: '2027-01-01', scopes: ['read', 'resume'] });
    void ref;
  } finally {
    await keyed.close();
  }
});

test('plan maps the trial answer', async () => {
  const server = await startFakeSandboxServer({
    trial: true, trialEndsAt: '2026-10-06', canStayOn: false, checkoutUrl: 'http://boat.test/checkout',
  });
  try {
    const { provider } = await setup(server);
    assert.deepEqual(await provider.plan!(), {
      inTrial: true, trialEndsAt: '2026-10-06', canStayOn: false, checkoutUrl: 'http://boat.test/checkout',
    });
  } finally {
    await server.close();
  }
  const plain = await startFakeSandboxServer();
  try {
    const { provider } = await setup(plain);
    assert.deepEqual(await provider.plan!(), {
      inTrial: false, trialEndsAt: null, canStayOn: true, checkoutUrl: null,
    });
  } finally {
    await plain.close();
  }
});

test('why maps every stop reason, and null without one', async () => {
  const server = await startFakeSandboxServer();
  try {
    const { provider, ref } = await setup(server);
    const rows: Array<[string, string]> = [
      ['user', 'you'], ['balance', 'out-of-credit'], ['trial', 'trial-limit'], ['idle', 'idle'], ['strange', 'provider'],
    ];
    for (const [reason, mapped] of rows) {
      server.setStopReason(reason);
      await provider.sleep!(ref);
      assert.equal(await provider.why!(ref), mapped, reason);
      server.setState(ref.id, 'ready');
    }
    const fresh = await startFakeSandboxServer();
    try {
      const second = await setup(fresh);
      await second.provider.sleep!(second.ref);
      assert.equal(await second.provider.why!(second.ref), null);
    } finally {
      await fresh.close();
    }
  } finally {
    await server.close();
  }
});

test('fixtures map http://boat.test onto the loopback bench through fetch', async () => {
  const server = await startFakeSandboxServer();
  try {
    const port = new URL(server.url).port;
    const provider = boat({
      baseUrl: 'http://boat.test/api/v1',
      label: 'Test',
      prices: prices(),
      key: async () => 'test-key',
      fetch: ((url: unknown, init: unknown) =>
        fetch(String(url).replace('http://boat.test', `http://127.0.0.1:${port}`), init as RequestInit)) as typeof fetch,
    });
    assert.equal(await provider.account(), 'acct-test');
  } finally {
    await server.close();
  }
});
