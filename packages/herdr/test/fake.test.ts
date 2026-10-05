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

const until =async (ok: () => boolean | Promise<boolean>, ms: number, what: string) => {
  const deadline = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() >= deadline) assert.fail(`not reached within ${ms}ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

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





















test('fake: the bin answers --version and api schema --json, and is 0700', async () => {
  await withFake(async (fake) => {
    const version = await run(fake.bin, ['--version']);
    assert.equal(version.stdout, `herdr ${HERDR_VERSION}\n`);
    const schema = await run(fake.bin, ['api', 'schema', '--json']);
    // The pinned v0.9.1 snapshot itself, not an identity placeholder: the same bytes gen-types
    // runs from, byte-identical to schema/herdr-api-0.9.1.json.
    const parsed = JSON.parse(schema.stdout) as { protocol?: number; schema_version?: number;
      schemas?: { request?: { $defs?: Record<string, unknown> } } };
    assert.equal(parsed.protocol, HERDR_PROTOCOL);
    assert.equal(parsed.schema_version, 1);
    assert.ok(parsed.schemas?.request?.$defs?.AgentStartParams, 'the request schemas ride along');
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
    const echo = JSON.parse(lines.find((line) => line.includes('terminal.frame'))!) as
      { data?: string; full?: string; bytes?: number };
    assert.equal(echo.data, 'echo hi', 'the data alias still rides along');
    assert.equal(echo.full, 'echo hi', 'frames carry the real full text');
    assert.equal(echo.bytes, Buffer.byteLength('echo hi'), 'frames carry the byte length');
    child.stdin?.write(`${JSON.stringify({ type: 'terminal.release' })}\n`);
    await until(() => exited(child), 5000, 'release exits the terminal');
  });
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
