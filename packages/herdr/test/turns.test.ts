import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import { HerdrKit } from '../src/index.ts';
import { startFakeHerdr } from '../src/testing/index.ts';
import { socketTransport } from '../src/socket.ts';
import type { AgentTurnEnd, HerdrSubscribeStop, HerdrTransport } from '../src/types.ts';

const target = { paneId: 'w1:p2', name: 'pi' };
const policy = {
  schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } }, additionalProperties: false },
  validate: (v: unknown): v is { ok: boolean } => typeof v === 'object' && v !== null &&
    'ok' in v && typeof v.ok === 'boolean' && Object.keys(v).length === 1,
};
function output(prompt: string): { path: string; id: string } {
  const path = prompt.match(/JSON file at ("[^\n]+?")\./)?.[1];
  const id = prompt.match(/\{"turnId":"([^"]+)"/)?.[1];
  assert.ok(path && id, 'the agent receives its exact result destination and turn id');
  return { path: JSON.parse(path) as string, id };
}
async function harness() {
  const fake = await startFakeHerdr({ dir: scratchDir('herdr-turn') });
  const real = socketTransport(fake.socketPath);
  let onPrompt: (prompt: string) => Promise<void> = async () => {};
  let afterPrompt: () => Promise<void> = async () => {};
  let disconnect: (() => void) | undefined;
  let prompts = 0;
  let muteWorking = false;
  const transport: HerdrTransport = {
    async call(method, params, timeoutMs) {
      if (method === 'agent.prompt') {
        prompts++;
        await onPrompt(String(params.text));
        const receipt = await real.call(method, params, timeoutMs);
        await afterPrompt();
        return receipt;
      }
      return real.call(method, params, timeoutMs);
    },
    subscribe(subs, on, error) {
      const stop = real.subscribe(subs, (e) => {
        if (!muteWorking || e.agent_status !== 'working') on(e);
      }, error);
      // Only the dedicated runTurn watch (created after start) gets this disconnect injection.
      if (subs.some((s) => s.type === 'pane.agent_status_changed')) {
        const wrapped: HerdrSubscribeStop = Object.assign(() => stop(), {
          ready: stop.ready, onReconnect: stop.onReconnect,
          onDisconnect(fn: () => void) { disconnect = fn; stop.onDisconnect(fn); },
        });
        return wrapped;
      }
      return stop;
    },
    close: () => real.close(),
  };
  const kit = new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath, transport });
  await kit.start(); await kit.statusWatchReady();
  const cwd = fake.world.agents[0].cwd;
  return { kit, fake, cwd,
    onPrompt(fn: typeof onPrompt) { onPrompt = fn; }, afterPrompt(fn: typeof afterPrompt) { afterPrompt = fn; },
    disconnect() { assert.ok(disconnect); disconnect(); }, prompts: () => prompts,
    muteWorking() { muteWorking = true; },
    async dispose() { await kit.stop(); await fake.stop(); },
  };
}

test('a fast turn emits once with validated JSON and content/mode/symlink changes, including dirty and untracked files', async () => {
  const h = await harness();
  try {
    await writeFile(join(h.cwd, 'dirty.ts'), 'already dirty');
    await writeFile(join(h.cwd, 'deleted.ts'), 'delete');
    await writeFile(join(h.cwd, 'mode.sh'), 'echo hello');
    await symlink('deleted.ts', join(h.cwd, 'link'));
    await mkdir(join(h.cwd, '.git')); await writeFile(join(h.cwd, '.git', 'HEAD'), 'old');
    await mkdir(join(h.cwd, 'cache')); await writeFile(join(h.cwd, 'cache', 'secret'), 'old');
    const events: AgentTurnEnd[] = [];
    const off = h.kit.onTurnEnd((e) => { events.push(e); throw new Error('listener'); });
    let perTurn: AgentTurnEnd<{ ok: boolean }> | undefined;
    h.onPrompt(async (prompt) => {
      const { path, id } = output(prompt);
      await writeFile(path, JSON.stringify({ turnId: id, result: { ok: true } }));
      await writeFile(join(h.cwd, 'dirty.ts'), 'new dirty text');
      await writeFile(join(h.cwd, 'new.ts'), 'new');
      await chmod(join(h.cwd, 'mode.sh'), 0o700);
      await rm(join(h.cwd, 'deleted.ts')); await rm(join(h.cwd, 'link'));
      await symlink('new.ts', join(h.cwd, 'link'));
      await writeFile(join(h.cwd, '.git', 'HEAD'), 'new');
      await writeFile(join(h.cwd, 'cache', 'secret'), 'new');
      // A stale idle before working is not completion.
      h.fake.emit({ type: 'pane.agent_status_changed', pane_id: target.paneId, agent_status: 'idle' });
    });
    // Hold the receipt until the fake has already finished: the end signal must be buffered.
    h.afterPrompt(async () => { await h.kit.wait(target, { until: ['idle'], timeoutMs: 2000 }); });
    const end = await h.kit.runTurn(target, { prompt: 'edit', cwd: h.cwd, result: policy,
      files: { exclude: (path) => path === 'cache' }, onEnd: (e) => { perTurn = e; } });
    assert.equal(end.status, 'idle'); assert.deepEqual(end.result, { state: 'valid', value: { ok: true } });
    assert.deepEqual(end.changedFiles, [
      { path: 'deleted.ts', change: 'deleted' }, { path: 'dirty.ts', change: 'modified' },
      { path: 'link', change: 'modified' }, { path: 'mode.sh', change: 'modified' }, { path: 'new.ts', change: 'added' },
    ]);
    assert.equal(perTurn, end); assert.deepEqual(events, [end]); off();
    assert.ok(!(await readdir(h.cwd)).some((p) => p === `.byokit-turn-${end.id}.json`));
  } finally { await h.dispose(); }
});

test('plain turns need no JSON; blocked approval is not an end and uses the existing answer flow', async () => {
  const h = await harness();
  try {
    let ended = false;
    const turn = h.kit.runTurn(target, { prompt: 'ask permission', cwd: h.cwd, onEnd: () => { ended = true; } });
    await new Promise<void>((resolve) => {
      const off = h.kit.onBlocked((_b, change) => { if (change === 'added') { off(); resolve(); } });
    });
    assert.equal(ended, false);
    const approval = h.kit.blocked()[0];
    await h.kit.answer(approval.paneId, ['y'], { revision: approval.revision });
    const end = await turn;
    assert.deepEqual(end.result, { state: 'not-requested' }); assert.deepEqual(end.changedFiles, []);
    assert.equal(ended, true);
  } finally { await h.dispose(); }
});

test('done is an end after working, but an idle event and a working receipt without observed work are not', async () => {
  const done = await harness();
  try {
    done.afterPrompt(async () => { done.fake.setStatus(target.paneId, 'done'); });
    const end = await done.kit.runTurn(target, { prompt: 'finish', cwd: done.cwd });
    assert.equal(end.status, 'done');
  } finally { await done.dispose(); }
  const missed = await harness();
  try {
    missed.muteWorking();
    await assert.rejects(missed.kit.runTurn(target, { prompt: 'finish', cwd: missed.cwd, timeoutMs: 200 }), { code: 'turn-timeout' });
  } finally { await missed.dispose(); }
});

test('missing, malformed, wrong-turn, schema-invalid, oversized and unsafe results never return unchecked bytes', async () => {
  const h = await harness();
  try {
    const secret = join(h.cwd, 'do-not-read'); await writeFile(secret, 'private');
    const cases = [
      { want: { state: 'missing' }, emit: async (_path: string, _id: string) => {} },
      { want: { state: 'invalid', reason: 'format' }, emit: async (path: string) => { await writeFile(path, 'bad'); } },
      { want: { state: 'invalid', reason: 'format' }, emit: async (path: string) => { await writeFile(path, '{"turnId":"old","result":{}}'); } },
      { want: { state: 'invalid', reason: 'schema' }, emit: async (path: string, id: string) => { await writeFile(path, JSON.stringify({ turnId: id, result: { ok: 'private' } })); } },
      { want: { state: 'invalid', reason: 'too-large' }, emit: async (path: string) => { await writeFile(path, 'x'.repeat(513)); } },
      { want: { state: 'invalid', reason: 'unsafe-file' }, emit: async (path: string) => { await symlink(secret, path); } },
    ];
    for (const c of cases) {
      h.onPrompt(async (prompt) => { const { path, id } = output(prompt); await c.emit(path, id); });
      const end = await h.kit.runTurn(target, { prompt: 'reply', cwd: h.cwd, result: { ...policy, maxBytes: 512 } });
      assert.deepEqual(end.result, c.want); assert.deepEqual(end.changedFiles, []);
    }
    assert.equal(await readFile(secret, 'utf8'), 'private', 'the result symlink target is untouched');
  } finally { await h.dispose(); }
});

test('watch rejection, wrong directory and file limits reject before prompt delivery', async () => {
  const h = await harness();
  try {
    h.fake.failNextAck();
    await assert.rejects(h.kit.runTurn(target, { prompt: 'no', cwd: h.cwd }), { code: 'turn-watch-lost' });
    await assert.rejects(h.kit.runTurn(target, { prompt: 'no', cwd: scratchDir('different-cwd') }), { code: 'turn-cwd' });
    await writeFile(join(h.cwd, 'one'), '1234'); await writeFile(join(h.cwd, 'two'), '5678');
    await assert.rejects(h.kit.runTurn(target, { prompt: 'no', cwd: h.cwd, files: { maxFiles: 1 } }), { code: 'turn-failed' });
    await assert.rejects(h.kit.runTurn(target, { prompt: 'no', cwd: h.cwd, files: { maxBytes: 1 } }), { code: 'turn-failed' });
    assert.equal(h.prompts(), 0);
  } finally { await h.dispose(); }
});

test('watch loss, cancellation, timeout, replacement and kit stop never emit an end or stop the agent', async () => {
  for (const kind of ['disconnect', 'cancel', 'timeout', 'replace', 'stop'] as const) {
    const h = await harness();
    const ends: AgentTurnEnd[] = []; h.kit.onTurnEnd((e) => ends.push(e));
    try {
      const controller = new AbortController();
      h.onPrompt(async () => {
        if (kind === 'disconnect') h.disconnect();
        if (kind === 'cancel') controller.abort();
        if (kind === 'replace') h.fake.emit({ type: 'pane.agent_detected', pane_id: target.paneId });
        if (kind === 'stop') await h.kit.stop();
      });
      const turn = h.kit.runTurn(target, { prompt: 'ask permission', cwd: h.cwd,
        timeoutMs: kind === 'timeout' ? 200 : 2000, signal: controller.signal });
      const codes = { disconnect: 'turn-watch-lost', cancel: 'turn-cancelled', timeout: 'turn-timeout', replace: 'turn-unavailable', stop: 'turn-unavailable' };
      await assert.rejects(turn, { code: codes[kind] });
      assert.deepEqual(ends, []);
      assert.ok(h.fake.world.agents.some((a) => a.pane_id === target.paneId), 'agent was not stopped');
    } finally { await h.dispose(); }
  }
});

test('overlapping turns are refused; a rejected prompt never emits even if end events arrived', async () => {
  const h = await harness();
  try {
    let ready!: () => void;
    const delivering = new Promise<void>((resolve) => { ready = resolve; });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    h.onPrompt(async () => { ready(); await held; throw new Error('delivery refused'); });
    const events: AgentTurnEnd[] = []; h.kit.onTurnEnd((e) => events.push(e));
    const first = h.kit.runTurn(target, { prompt: 'hold', cwd: h.cwd });
    await delivering;
    await assert.rejects(h.kit.runTurn(target, { prompt: 'second', cwd: h.cwd }), { code: 'turn-busy' });
    await assert.rejects(h.kit.runTurn({ paneId: 'w1:p1' }, { prompt: 'same-root', cwd: h.cwd }), { code: 'turn-busy' });
    await mkdir(join(h.cwd, 'nested'));
    await assert.rejects(h.kit.runTurn({ paneId: 'w1:p1' }, { prompt: 'nested-root', cwd: join(h.cwd, 'nested') }), { code: 'turn-busy' });
    h.fake.setStatus(target.paneId, 'working'); h.fake.setStatus(target.paneId, 'done');
    release(); await assert.rejects(first, { code: 'turn-failed' });
    assert.deepEqual(events, []);
  } finally { await h.dispose(); }
});
