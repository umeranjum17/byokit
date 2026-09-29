// H6 acceptance (docs/runtime-kits.md 6.8): every listed method hit directly over the socket, every
// bin verb via `execFile`, subscribe semantics (ack, frames, empty-id rejection), the
// `ask permission` blocked flow, and `stop()` removing the socket and leaving no temp dirs — all
// without the kit, which H3/H4/H5 build on top of this.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { HERDR_PROTOCOL, HERDR_VERSION } from '../src/constants.ts';
import { startFakeHerdr, writeBinShim, type FakeHerdr } from '../src/testing/index.ts';
import { scratchDir, trackChild } from '../../test-support.ts';

const run = promisify(execFile);

type Answer = { id?: unknown; event?: string; data?: unknown; result?: unknown; error?: { code?: string; message?: string } };

async function withFake(runTest: (fake: FakeHerdr) => Promise<void>): Promise<void> {
  const fake = await startFakeHerdr({ dir: scratchDir('herdr-fake') });
  try {
    await runTest(fake);
  } finally {
    await fake.stop();
  }
}

let seq = 0;

/** One request on its own connection; the fake closes after answering. */
function request(socketPath: string, method: string, params: Record<string, unknown> = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const id = `t${++seq}`;
    let buffer = '';
    const done = (settle: () => void) => {
      socket.removeAllListeners();
      socket.destroy();
      settle();
    };
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim() === '') continue;
        const message = JSON.parse(line) as Answer;
        if (message.id !== id) continue;
        return done(() => resolve(message));
      }
    });
    socket.on('error', (error: Error) => done(() => reject(error)));
    socket.on('close', () => done(() => reject(new Error(`${method}: the fake closed without answering`))));
  });
}

/** Reader for a held-open connection (subscriptions): ordered frames plus a pending count. */
function reader(socket: Socket): { next: () => Promise<Answer>; pending: () => number } {
  const queue: Answer[] = [];
  const waiters: ((answer: Answer) => void)[] = [];
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('error', () => {});   // a destroyed subscription socket is not a test failure
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim() === '') continue;
      const message = JSON.parse(line) as Answer;
      const waiter = waiters.shift();
      if (waiter !== undefined) waiter(message);
      else queue.push(message);
    }
  });
  return {
    next: () => new Promise((resolve) => {
      const queued = queue.shift();
      if (queued !== undefined) resolve(queued);
      else waiters.push(resolve);
    }),
    pending: () => queue.length,
  };
}

const openSocket = (socketPath: string) =>
  new Promise<Socket>((resolve, reject) => {
    const socket = connect(socketPath);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });

const send = (socket: Socket, message: object) => socket.write(`${JSON.stringify(message)}\n`);

const until = async (ok: () => boolean | Promise<boolean>, ms: number, what: string) => {
  const deadline = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() >= deadline) assert.fail(`not reached within ${ms}ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test('fake: the world is one workspace, one tab, two panes, one pi agent', async () => {
  await withFake(async (fake) => {
    assert.deepEqual(fake.world.workspaces.map((w) => w.workspace_id), ['w1']);
    assert.deepEqual(fake.world.tabs.map((t) => t.tab_id), ['w1:t1']);
    assert.deepEqual(fake.world.panes.map((p) => p.pane_id), ['w1:p1', 'w1:p2']);
    assert.equal(fake.world.panes[0].agent_status, undefined, 'w1:p1 is a plain shell');
    assert.equal(fake.world.agents[0].agent, 'pi');
    assert.equal(fake.world.agents[0].agent_status, 'idle');
    assert.equal(fake.world.agents[0].revision, 0, 'revisions start deterministic');
    const snapshot = await request(fake.socketPath, 'session.snapshot');
    const nested = (snapshot.result ?? {}) as { snapshot?: { workspaces?: unknown[]; panes?: unknown[]; agents?: unknown[] } };
    assert.equal(nested.snapshot?.workspaces?.length, 1);
    assert.equal(nested.snapshot?.panes?.length, 2);
    assert.equal(nested.snapshot?.agents?.length, 1);
  });
});

test('fake: ping answers the pinned protocol and version', async () => {
  await withFake(async (fake) => {
    const ping = await request(fake.socketPath, 'ping');
    assert.deepEqual(ping.result, { protocol: HERDR_PROTOCOL, version: HERDR_VERSION });
  });
});

test('fake: workspace methods create (with the root pane), list, get, focus and close', async () => {
  await withFake(async (fake) => {
    const made = await request(fake.socketPath, 'workspace.create', { cwd: '/tmp/h6-ws', label: 'h6' });
    const madeResult = made.result as { workspace: { workspace_id: string }; root_pane: { pane_id: string } };
    assert.match(madeResult.workspace.workspace_id, /^w\d+$/);
    assert.match(madeResult.root_pane.pane_id, new RegExp(`^${madeResult.workspace.workspace_id}:p\\d+$`),
      'workspace.create answers the root pane the kit places agents in');
    const list = await request(fake.socketPath, 'workspace.list');
    assert.equal((list.result as { workspaces: unknown[] }).workspaces.length, 2);
    const got = await request(fake.socketPath, 'workspace.get', { workspace_id: madeResult.workspace.workspace_id });
    assert.equal((got.result as { workspace: { label: string } }).workspace.label, 'h6');
    assert.deepEqual((await request(fake.socketPath, 'workspace.focus', { workspace_id: 'w1' })).result, {});
    assert.deepEqual((await request(fake.socketPath, 'workspace.close', { workspace_id: madeResult.workspace.workspace_id })).result, {});
    const notFound = await request(fake.socketPath, 'workspace.get', { workspace_id: madeResult.workspace.workspace_id });
    assert.equal(notFound.error?.code, 'workspace_not_found');
  });
});

test('fake: tab methods create (with a root pane), list, get, focus and close', async () => {
  await withFake(async (fake) => {
    const made = await request(fake.socketPath, 'tab.create', { workspace_id: 'w1', cwd: '/tmp/h6' });
    const madeResult = made.result as { tab: { tab_id: string }; root_pane: { pane_id: string } };
    assert.equal(madeResult.tab.tab_id, 'w1:t2');
    assert.match(madeResult.root_pane.pane_id, /^w1:p\d+$/);
    const list = await request(fake.socketPath, 'tab.list', { workspace_id: 'w1' });
    assert.deepEqual((list.result as { tabs: { tab_id: string }[] }).tabs.map((t) => t.tab_id), ['w1:t1', 'w1:t2']);
    const got = await request(fake.socketPath, 'tab.get', { tab_id: 'w1:t1' });
    assert.equal((got.result as { tab: { pane_count: number } }).tab.pane_count, 2);
    assert.deepEqual((await request(fake.socketPath, 'tab.focus', { tab_id: 'w1:t2' })).result, {});
    assert.deepEqual((await request(fake.socketPath, 'tab.close', { tab_id: 'w1:t2' })).result, {});
    assert.equal((await request(fake.socketPath, 'tab.get', { tab_id: 'w1:t2' })).error?.code, 'tab_not_found');
  });
});

test('fake: pane methods get, split, read, send_keys, report_metadata, zoom, layout, focus, close', async () => {
  await withFake(async (fake) => {
    const got = await request(fake.socketPath, 'pane.get', { pane_id: 'w1:p1' });
    assert.equal((got.result as { pane: { pane_id: string } }).pane.pane_id, 'w1:p1');
    const split = await request(fake.socketPath, 'pane.split', { target_pane_id: 'w1:p1' });
    const newPane = (split.result as { pane: { pane_id: string } }).pane.pane_id;
    assert.equal(newPane, 'w1:p3', 'splits land in the target pane’s tab with the next number');
    const read = await request(fake.socketPath, 'pane.read', { pane_id: 'w1:p1' });
    assert.deepEqual(read.result, { read: { text: 'ready.', truncated: false } });
    const detection = await request(fake.socketPath, 'pane.read', { pane_id: 'w1:p2', source: 'detection' });
    assert.equal((detection.result as { read: { text: string } }).read.text, '', 'an unblocked agent has no detection text');
    const keys = await request(fake.socketPath, 'pane.send_keys', { pane_id: 'w1:p1', keys: ['l', 's'] });
    assert.deepEqual(keys.result, { pane_id: 'w1:p1', keys: ['l', 's'] });
    const afterKeys = await request(fake.socketPath, 'pane.read', { pane_id: 'w1:p1' });
    assert.equal((afterKeys.result as { read: { text: string } }).read.text, 'ready.\nls', 'sent keys show in the pane text');
    assert.deepEqual((await request(fake.socketPath, 'pane.report_metadata', { pane_id: 'w1:p1', tokens: { out: 3 } })).result, {});
    const zoom = await request(fake.socketPath, 'pane.zoom', { pane_id: 'w1:p1' });
    assert.deepEqual(zoom.result, { zoom: { changed: true, zoomed: true } });
    const layout = await request(fake.socketPath, 'pane.layout', { pane_id: 'w1:p1' });
    const layoutResult = (layout.result as { layout: { tab_id: string; panes: unknown[] } }).layout;
    assert.equal(layoutResult.tab_id, 'w1:t1');
    assert.equal(layoutResult.panes.length, 3, 'the layout covers every pane the tab holds');
    assert.deepEqual((await request(fake.socketPath, 'pane.focus', { pane_id: newPane })).result, {});
    assert.deepEqual((await request(fake.socketPath, 'pane.close', { pane_id: newPane })).result, {});
    assert.equal((await request(fake.socketPath, 'pane.get', { pane_id: newPane })).error?.code, 'pane_not_found');
  });
});

test('fake: agent methods start, prompt, wait, send_keys, list and get', async () => {
  await withFake(async (fake) => {
    const started = await request(fake.socketPath, 'agent.start', { pane_id: 'w1:p1', kind: 'pi', name: 'worker' });
    const agent = (started.result as { agent: { pane_id: string; agent: string; agent_status: string } }).agent;
    assert.equal(agent.pane_id, 'w1:p1');
    assert.equal(agent.agent, 'pi');
    assert.equal(agent.agent_status, 'idle');
    const prompted = await request(fake.socketPath, 'agent.prompt', { target: 'w1:p1', text: 'hello' });
    const promptedResult = prompted.result as { type: string; agent: Record<string, unknown> };
    assert.equal(promptedResult.type, 'agent_prompted');
    const receipt = promptedResult.agent;
    assert.equal(receipt.terminal_id, 'term-w1:p1');
    assert.equal(receipt.agent_status, 'working');
    assert.equal(receipt.workspace_id, 'w1');
    assert.equal(receipt.tab_id, 'w1:t1');
    assert.equal(receipt.pane_id, 'w1:p1');
    assert.equal(typeof receipt.revision, 'number');
    const waited = await request(fake.socketPath, 'agent.wait', { target: 'w1:p1', until: ['idle'], timeout_ms: 2000 });
    assert.equal((waited.result as { agent: { agent_status: string } }).agent.agent_status, 'idle');
    const sent = await request(fake.socketPath, 'agent.send_keys', { target: 'w1:p1', keys: ['y'] });
    assert.deepEqual(sent.result, { target: 'w1:p1', keys: ['y'] });
    const list = await request(fake.socketPath, 'agent.list');
    assert.equal((list.result as { agents: unknown[] }).agents.length, 2, 'the shell agent joined the world one');
    const got = await request(fake.socketPath, 'agent.get', { target: 'w1:p1' });
    assert.equal((got.result as { agent: { name: string } }).agent.name, 'worker');
    assert.equal((await request(fake.socketPath, 'agent.get', { target: 'w1:p9' })).error?.code, 'agent_not_found');
  });
});

test('fake: agent.prompt settles working → idle after 50ms and appends the reply', async () => {
  await withFake(async (fake) => {
    await request(fake.socketPath, 'agent.prompt', { target: 'w1:p2', text: 'do a thing' });
    const working = await request(fake.socketPath, 'agent.get', { target: 'w1:p2' });
    assert.equal((working.result as { agent: { agent_status: string } }).agent.agent_status, 'working');
    await until(async () => {
      const settled = await request(fake.socketPath, 'agent.get', { target: 'w1:p2' });
      return (settled.result as { agent: { agent_status: string } }).agent.agent_status === 'idle';
    }, 2000, 'the 50ms settle to idle');
    const read = await request(fake.socketPath, 'pane.read', { pane_id: 'w1:p2' });
    assert.match((read.result as { read: { text: string } }).read.text, /fake pi: do a thing/);
  });
});

test('fake: `ask permission` blocks with detection text until y/n arrives', async () => {
  await withFake(async (fake) => {
    const statusSeen: string[] = [];
    const socket = await openSocket(fake.socketPath);
    send(socket, { id: 's1', method: 'events.subscribe', params: { subscriptions: [{ type: 'pane.agent_status_changed', pane_id: 'w1:p2' }] } });
    const { next } = reader(socket);
    assert.deepEqual(await next(), { id: 's1', result: { type: 'subscribed' } });
    void (async () => {
      for (;;) {
        const data = (await next()).data as { agent_status?: string };
        if (typeof data?.agent_status === 'string') statusSeen.push(data.agent_status);
      }
    })().catch(() => {});
    await request(fake.socketPath, 'agent.prompt', { target: 'w1:p2', text: 'ask permission' });
    await until(() => statusSeen.includes('blocked'), 2000, 'the blocked status event');
    assert.deepEqual(statusSeen, ['working', 'blocked'], 'the per-pane watch sees both transitions');
    const detection = await request(fake.socketPath, 'pane.read', { pane_id: 'w1:p2', source: 'detection' });
    assert.equal((detection.result as { read: { text: string } }).read.text, 'Allow this? (y/n)');
    await request(fake.socketPath, 'agent.send_keys', { target: 'w1:p2', keys: ['y'] });
    const settled = await request(fake.socketPath, 'agent.get', { target: 'w1:p2' });
    assert.equal((settled.result as { agent: { agent_status: string } }).agent.agent_status, 'idle');
    const after = await request(fake.socketPath, 'pane.read', { pane_id: 'w1:p2', source: 'detection' });
    assert.equal((after.result as { read: { text: string } }).read.text, '', 'answering clears the detection text');
    socket.destroy();
  });
});

test('fake: worktree.create links a checkout into the root workspace', async () => {
  await withFake(async (fake) => {
    const made = await request(fake.socketPath, 'worktree.create', { cwd: join(fake.world.cwd, 'wt'), branch: 'h6' });
    const workspace = (made.result as { workspace: { worktree: { is_linked_worktree: boolean; repo_root: string } } }).workspace;
    assert.equal(workspace.worktree.is_linked_worktree, true);
    assert.equal(workspace.worktree.repo_root, fake.world.cwd, 'the checkout links back to the root workspace');
  });
});

test('fake: server.agent_manifests lists the world kinds; server.stop shuts the fake down', async () => {
  const fake = await startFakeHerdr({ dir: scratchDir('herdr-fake'), world: { kinds: ['pi', 'gemini'] } });
  try {
    const manifests = await request(fake.socketPath, 'server.agent_manifests');
    assert.deepEqual(manifests.result, { manifests: [{ agent: 'pi' }, { agent: 'gemini' }] });
    assert.deepEqual((await request(fake.socketPath, 'server.stop')).result, {});
    await until(() => !existsSync(fake.socketPath), 2000, 'server.stop removes the socket');
  } finally {
    await fake.stop();
  }
});

test('fake: an unknown method answers unknown_method', async () => {
  await withFake(async (fake) => {
    const answer = await request(fake.socketPath, 'plugin.list');
    assert.equal(answer.error?.code, 'unknown_method');
    assert.match(answer.error?.message ?? '', /plugin\.list/);
  });
});

test('fake: subscribe acks { type: subscribed }, frames carry event and data.type, kinds filter', async () => {
  await withFake(async (fake) => {
    const socket = await openSocket(fake.socketPath);
    send(socket, { id: 7, method: 'events.subscribe', params: { subscriptions: [{ type: 'pane.created' }] } });
    const { next, pending } = reader(socket);
    assert.deepEqual(await next(), { id: 7, result: { type: 'subscribed' } });
    fake.emit({ type: 'workspace.created', workspace_id: 'w9' });
    fake.emit({ type: 'pane.created', pane_id: 'w9:p1', label: 'zsh' });
    const frame = await next();
    // Wire frames carry the live underscore spelling (`pane_created`), like the real server.
    assert.equal(frame.event, 'pane_created', 'frames carry the event name at the top level');
    assert.equal((frame.data as { type?: string }).type, 'pane_created', 'frames carry data.type');
    assert.equal((frame.data as { pane_id?: string }).pane_id, 'w9:p1');
    await pause(100);
    assert.equal(pending(), 0, 'the kinds filter dropped workspace.created');
    socket.destroy();
  });
});

test('fake: a filtered kind is watched per pane and carries the revision', async () => {
  await withFake(async (fake) => {
    const socket = await openSocket(fake.socketPath);
    send(socket, {
      id: 1,
      method: 'events.subscribe',
      params: { subscriptions: [{ type: 'pane.agent_status_changed', pane_id: 'w1:p2' }] },
    });
    const { next, pending } = reader(socket);
    assert.equal(((await next()).result as { type?: string }).type, 'subscribed');
    fake.setStatus('w1:p2', 'working');
    const frame = await next();
    assert.equal(frame.event, 'pane_agent_status_changed');
    const data = frame.data as { pane_id?: string; agent_status?: string; revision?: number };
    assert.equal(data.pane_id, 'w1:p2');
    assert.equal(data.agent_status, 'working');
    assert.equal(typeof data.revision, 'number', 'filtered frames carry the deterministic revision');
    fake.setStatus('w1:p1', 'working');
    await pause(100);
    assert.equal(pending(), 0, 'another pane’s status never arrives');
    socket.destroy();
  });
});

test('fake: a batch with a filtered kind without its filter is rejected with an empty id', async () => {
  await withFake(async (fake) => {
    for (const subscriptions of [
      [{ type: 'pane.agent_status_changed' }],
      [{ type: 'pane.created' }, { type: 'pane.agent_status_changed', pane_id: 'w1:p2' }],
      [{}],
    ]) {
      const socket = await openSocket(fake.socketPath);
      socket.on('error', () => {});
      const firstLine = new Promise<Answer>((resolve) => {
        socket.setEncoding('utf8');
        let buffer = '';
        socket.on('data', (chunk: string) => {
          buffer += chunk;
          for (const line of buffer.split('\n')) {
            if (line.trim() === '') continue;
            resolve(JSON.parse(line) as Answer);
            return;
          }
        });
      });
      send(socket, { id: 3, method: 'events.subscribe', params: { subscriptions } });
      const rejection = await firstLine;
      assert.equal(rejection.id, '', 'a rejected subscribe answers id ""');
      assert.equal(rejection.error?.code, 'invalid_subscription');
      await until(() => socket.destroyed, 2000, 'the server closes after a rejection');
    }
  });
});

test('fake: one request per connection — a second request never answers', async () => {
  await withFake(async (fake) => {
    const socket = await openSocket(fake.socketPath);
    const { next, pending } = reader(socket);
    send(socket, { id: 'a', method: 'ping', params: {} });
    const first = await next();
    assert.equal((first.result as { protocol?: number }).protocol, HERDR_PROTOCOL);
    send(socket, { id: 'b', method: 'ping', params: {} });
    await until(() => socket.destroyed, 2000, 'the fake destroys a socket that asks twice');
    assert.equal(pending(), 0, 'the second request on the socket is never answered');
  });
});

test('fake: the bin answers --version and api schema --json, and is 0700', async () => {
  await withFake(async (fake) => {
    const version = await run(fake.bin, ['--version']);
    assert.equal(version.stdout, `herdr ${HERDR_VERSION}\n`);
    const schema = await run(fake.bin, ['api', 'schema', '--json']);
    const parsed = JSON.parse(schema.stdout) as { protocol: number; version: string };
    assert.equal(parsed.protocol, HERDR_PROTOCOL);
    assert.equal(parsed.version, HERDR_VERSION);
    assert.equal(statSync(fake.bin).mode & 0o777, 0o700, 'the shim is 0700');
  });
});

test('fake: the bin forwards JSON CLI verbs to the socket', async () => {
  await withFake(async (fake) => {
    const listed = await run(fake.bin, ['workspace', 'list', '--socket', fake.socketPath]);
    const parsed = JSON.parse(listed.stdout) as { result: { workspaces: { workspace_id: string }[] } };
    assert.deepEqual(parsed.result.workspaces.map((w) => w.workspace_id), ['w1']);
    const envListed = await run(fake.bin, ['workspace', 'list'], { env: { ...process.env, HERDR_SOCKET_PATH: fake.socketPath } });
    assert.equal((JSON.parse(envListed.stdout) as { result: { workspaces: unknown[] } }).result.workspaces.length, 1);
    const failing = (await run(fake.bin, ['workspace', 'get', '--workspace_id', 'w99', '--socket', fake.socketPath]).catch(
      (error: { code?: number; stderr?: string }) => error,
    )) as { code?: number; stderr?: string };
    assert.equal(failing.code, 1);
    assert.match(failing.stderr ?? '', /workspace_not_found/);
  });
});

const spawnTerminal = (fake: FakeHerdr, ...args: string[]): { child: ChildProcess; lines: string[]; out: () => string } => {
  const child = spawn(fake.bin, ['terminal', 'session', ...args]);
  trackChild(child);
  const lines: string[] = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    lines.push(...chunk.split('\n').filter((line) => line.trim() !== ''));
  });
  return { child, lines, out: () => lines.join('\n') };
};

test('fake: the bin terminal session emits one ready frame and echoes sends', async () => {
  await withFake(async (fake) => {
    const { child, lines, out } = spawnTerminal(fake, 'observe', 'w1:p1', '--cols', '80', '--rows', '24');
    await until(() => out().includes('terminal.ready'), 5000, 'the ready frame');
    const ready = JSON.parse(lines[0]) as Record<string, unknown>;
    assert.equal(ready.pane_id, 'w1:p1');
    assert.equal(ready.mode, 'observe');
    assert.equal(ready.takeover, false);
    child.stdin?.write(`${JSON.stringify({ type: 'terminal.input', data: 'echo hi' })}\n`);
    await until(() => out().includes('terminal.frame'), 5000, 'the echo frame');
    const echo = JSON.parse(lines.find((line) => line.includes('terminal.frame'))!) as { data?: string };
    assert.equal(echo.data, 'echo hi');
    child.stdin?.write(`${JSON.stringify({ type: 'terminal.release' })}\n`);
    await until(() => exited(child), 5000, 'release exits the terminal');
  });
});

test('fake: the bin terminal control passes takeover in the ready frame', async () => {
  await withFake(async (fake) => {
    const { child, lines } = spawnTerminal(fake, 'control', 'w1:p1', '--takeover', '--cols', '80', '--rows', '24');
    await until(() => lines.join('\n').includes('terminal.ready'), 5000, 'the ready frame');
    const ready = JSON.parse(lines[0]) as Record<string, unknown>;
    assert.equal(ready.mode, 'control');
    assert.equal(ready.takeover, true);
    child.kill();
    await until(() => exited(child), 5000, 'the terminal child exits');
  });
});

test('fake: the bin server verb serves HERDR_SOCKET_PATH and records its env', async () => {
  const dir = scratchDir('herdr-bin-server');
  const socketPath = join(dir, 'state', 'herdr', 'herdr.sock');
  const bin = writeBinShim({ dir, socketPath });
  const child = spawn(bin, ['server'], {
    env: { ...process.env, HERDR_SOCKET_PATH: socketPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  trackChild(child);
  const lines: string[] = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => lines.push(...chunk.split('\n').filter((line) => line.trim() !== '')));
  await until(() => lines.length >= 1, 5000, 'the startup line');
  const startup = JSON.parse(lines[0]) as { socketPath: string; pid: number; env: Record<string, string> };
  assert.equal(startup.socketPath, socketPath);
  assert.equal(startup.env.HERDR_SOCKET_PATH, socketPath, 'the fake records the exact env it was spawned with');
  const ping = await request(socketPath, 'ping');
  assert.equal((ping.result as { protocol?: number }).protocol, HERDR_PROTOCOL);
  child.kill('SIGTERM');
  await until(() => child.exitCode === 0, 5000, 'SIGTERM exits 0');
  assert.ok(!existsSync(socketPath), 'the socket is gone after the server verb stops');
});

test('fake: stop removes the socket and leaves no temp dirs behind', async () => {
  const dir = scratchDir('herdr-fake-stop');
  const tmpBefore = readdirSync(tmpdir()).sort();
  const fake = await startFakeHerdr({ dir });
  assert.ok(existsSync(fake.socketPath));
  await fake.stop();
  assert.ok(!existsSync(fake.socketPath), 'stop removes the socket');
  const leaked = readdirSync(tmpdir()).filter((entry) => !tmpBefore.includes(entry));
  assert.deepEqual(leaked, [], 'the fake creates nothing outside its dir');
});
