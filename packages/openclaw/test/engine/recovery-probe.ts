// R1 public-kit caller harness: real pinned Gateway, loopback scripted provider, no accounts.
// Run under the home's heavy-job lock with Node 24; keeps evidence under R1_OUT.
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenClawKit } from '../../src/kit.ts';
import { Engine } from '../../src/engine.ts';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

const repo = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const out = resolve(process.env.R1_OUT ?? join(repo, '.tmp/r1/probe'));
const engineDir = join(repo, 'packages/openclaw/engine');
const tool = { name: 'note', description: 'task-owned test note', parameters: { type: 'object', properties: { phase: { type: 'string' } } } };
const send = (data: unknown) => process.send?.(data);

if (process.argv[2] === 'worker') {
  const [stateDir, url, key, action] = process.argv.slice(3) as [string, string, string, string];
  // Inject only the test egress guard into the child's deliberately minimal env; no engine/source substitution.
  const context = Engine.prototype.doctorContext;
  Engine.prototype.doctorContext = function () {
    const c = context.call(this);
    c.env.NODE_OPTIONS = `--require ${join(repo, 'scripts/test-egress-guard.cjs')}`;
    return c;
  };
  let entered!: () => void;
  const toolEntered = new Promise<void>(resolve => { entered = resolve; });
  const appOwned = process.env.R1_APP_OWNED === '1';
  const kit = new OpenClawKit({ stateDir, engineDir, tools: [tool],
    ...(appOwned ? { appOwnedSessionPrefixes: ['agent:m1:crewhouse:'] } : {}),
    config: {
      models: { providers: { 'byokit-stub': { baseUrl: url, apiKey: 'byokit-stub', api: 'openai-completions', models: [
        { id: 'test', name: 'Test', input: ['text'], contextWindow: 32000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      ] } } },
      agents: { defaults: { model: { primary: 'byokit-stub/test' }, heartbeat: { every: '0m' }, compaction: { memoryFlush: { enabled: false } } } },
    },
    host: { gate: async () => ({ allow: true }), call: async (run, name, input) => {
      send({ type: 'tool', key: run.sessionKey, name, input, at: Date.now() });
      entered();
      if ((action === 'interrupt' || action === 'cancel') && input.phase === 'hold') return new Promise(() => {});
      return 'task note done';
    } },
  });
  try {
    await kit.start();
    assert.equal(kit.state.phase, 'ready');
    send({ type: 'ready', pid: Number(readFileSync(join(stateDir, 'openclaw/gateway.pid'), 'utf8')), at: Date.now() });
    if (action === 'observe') await delay(14000);
    else {
      if (action === 'late') await delay(11000);
      const run = kit.run({ member: 'm1', sessionKey: key,
        message: `R1_KEY=${key}\n${action === 'interrupt' || action === 'cancel' ? 'interrupt' : 'continue'}` });
      if (action === 'cancel') {
        await toolEntered;
        await kit.abort(key);
      }
      send({ type: 'end', result: await run, at: Date.now() });
      await delay(11000); // include the startup recovery timer after a fast app continuation
    }
    send({ type: 'sessions', result: await kit.call('sessions.list', {}), at: Date.now() });
  } finally { await kit.stop(); }
  process.disconnect?.();
} else {
  mkdirSync(out, { recursive: true });
  // Grammar: app turn calls note once; recovery calls an actually offered replay-safe read once.
  // Unlike the general contract stub, do not replay the old app script through a synthetic recovery prompt.
  const calls: any[] = [];
  let scenarioKey = '';
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const text = (m: any): string => typeof m.content === 'string' ? m.content : (m.content ?? []).map((c: any) => c.text ?? '').join('');
    const users = body.messages.map((m: any, i: number) => ({ m, i })).filter(({ m }: any) => m.role === 'user');
    const turn = users.findLast(({ m }: any) => /R1_KEY=|Your previous turn was interrupted/.test(text(m)));
    assert.ok(turn, 'provider must have an app or engine recovery prompt');
    const key = /R1_KEY=([^\s]+)/.exec(body.messages.map(text).join('\n'))?.[1];
    const recovery = text(turn.m).includes('Your previous turn was interrupted');
    const results = body.messages.slice(turn.i + 1).filter((m: any) => m.role === 'tool');
    calls.push({ at: Date.now(), key, scenarioKey, recovery, body });
    writeFileSync(join(out, 'provider-requests.json'), JSON.stringify(calls, null, 2));
    const id = randomUUID();
    const name = recovery ? 'read' : 'note';
    assert.ok(body.tools.some((t: any) => t.function.name === name), `script asks only offered tool ${name}`);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta: object, finish: string | null) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    if (!results.length) {
      if (recovery) await delay(scenarioKey.endsWith(':repeat') ? 30000 : 3000); // ordinary provider latency lets the restarted kit reconnect its bridge
      const input = recovery ? { path: join(out, 'safe-note.txt') } : { phase: text(turn.m).includes('interrupt') ? 'hold' : 'finish' };
      chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${id}`, type: 'function', function: { name, arguments: JSON.stringify(input) } }] }, null);
      chunk({}, 'tool_calls');
    } else {
      chunk({ role: 'assistant', content: recovery ? `recovery read result: ${results.at(-1).content}` : 'app task done' }, null);
      chunk({}, 'stop');
    }
    if (body.stream_options?.include_usage) res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: body.model, choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const stub = { url: `http://127.0.0.1:${address.port}/v1`, calls, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
  writeFileSync(join(out, 'safe-note.txt'), 'task-owned harmless read fixture\n');
  const receipt: { mode: string; key: string; events: any[]; provider: unknown[]; transcripts: unknown[] }[] = [];
  const children = new Set<ChildProcess>();
  const gateways = new Map<number, string>();
  const states = new Set<string>();
  function launch(stateDir: string, key: string, action: string, events: any[]) {
    const child = fork(fileURLToPath(import.meta.url), ['worker', stateDir, stub.url, key, action], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    children.add(child);
    states.add(stateDir);
    child.on('message', (m: any) => {
      events.push({ ...m, child: child.pid });
      writeFileSync(join(out, `${scenarioKey.split(':').at(-1)}-events.json`), JSON.stringify(events, null, 2));
      if (m.type === 'ready') gateways.set(m.pid, stateDir);
    });
    child.stdout?.on('data', (s) => events.push({ type: 'stdout', text: String(s) }));
    child.stderr?.on('data', (s) => events.push({ type: 'stderr', text: String(s) }));
    child.on('exit', (code, signal) => { children.delete(child); events.push({ type: 'exit', code, signal, child: child.pid }); });
    return child;
  }
  async function wait(events: any[], type: string, child: ChildProcess) {
    for (let i = 0; i < 1800; i++) {
      const event = events.find(e => e.type === type && e.child === child.pid);
      if (event) return event;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`worker exited before ${type}: ${JSON.stringify(events.slice(-5))}`);
      await delay(100);
    }
    throw new Error(`timeout waiting for ${type}`);
  }
  function killOwned(pid: number, stateDir: string) {
    const env = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
    assert.ok(env.includes(`OPENCLAW_STATE_DIR=${join(stateDir, 'openclaw/state')}`));
    const identity = JSON.parse(readFileSync(join(stateDir, 'openclaw/gateway.identity'), 'utf8'));
    assert.equal(identity.pid, pid);
    assert.equal(identity.startTime, readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1)!.split(' ')[19]);
    process.kill(pid, 'SIGKILL');
    gateways.delete(pid);
  }
  function transcripts(dir: string): unknown[] {
    const result: unknown[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) result.push(...transcripts(p));
      else if (e.name.endsWith('.jsonl')) result.push({ path: p, text: readFileSync(p, 'utf8') });
      else if (e.name === 'openclaw-agent.sqlite') {
        const db = new DatabaseSync(p, { readOnly: true });
        try { result.push({ path: p, entries: db.prepare('SELECT session_key, entry_json FROM session_nodes').all(),
          events: db.prepare('SELECT session_id, seq, event_json FROM transcript_events ORDER BY session_id, seq').all() }); }
        finally { db.close(); }
      }
    }
    return result;
  }
  try {
    for (const mode of process.argv.slice(2).length ? process.argv.slice(2) : ['late', 'early', 'normal', 'excluded', 'cancel', 'repeat']) {
      const stateDir = join(out, mode);
      const key = mode === 'excluded' ? 'agent:m1:cron:r1' : `agent:m1:crewhouse:bot:${mode}`;
      scenarioKey = key;
      const events: any[] = [];
      const start = stub.calls.length;
      const first = launch(stateDir, key, mode === 'normal' ? 'complete' : mode === 'cancel' ? 'cancel' : 'interrupt', events);
      const ready = await wait(events, 'ready', first);
      if (mode === 'normal' || mode === 'cancel') { await wait(events, 'end', first); await once(first, 'exit'); gateways.delete(ready.pid); }
      else {
        await wait(events, 'tool', first);
        // Crash BOTH owners only after the app tool has actually been entered on the real engine.
        first.kill('SIGKILL');
        killOwned(ready.pid, stateDir);
        await once(first, 'exit');
        await delay(500);
      }
      events.push({ type: 'snapshot-before-restart', transcripts: transcripts(join(stateDir, 'openclaw/state')) });
      if (mode === 'repeat') {
        for (let attempt = 1; attempt <= 3; attempt++) {
          const before = calls.length;
          const recovery = launch(stateDir, key, 'observe', events);
          const recovered = await wait(events, 'ready', recovery);
          for (let i = 0; calls.length === before && i < 900; i++) await delay(100);
          assert.ok(calls.length > before && calls.at(-1).recovery, 'real recovery provider request reached');
          const snapshot = transcripts(join(stateDir, 'openclaw/state')) as any[];
          const entry = JSON.parse(snapshot.find(s => s.entries)?.entries[0].entry_json);
          assert.equal(entry.mainRestartRecovery.chargedAttempts, attempt, 'attempt charged durably before crash');
          events.push({ type: 'recovery-crash', attempt, entry, at: Date.now() });
          recovery.kill('SIGKILL');
          killOwned(recovered.pid, stateDir);
          await once(recovery, 'exit');
          await delay(500);
        }
      }
      const next = launch(stateDir, key, mode === 'late' ? 'late' : ['normal', 'cancel', 'repeat'].includes(mode) ? 'observe' : 'complete', events);
      const nextReady = await wait(events, 'ready', next);
      const ended = once(next, 'exit');
      await Promise.race([ended, delay(90000).then(() => { throw new Error('restart worker deadline'); })]);
      gateways.delete(nextReady.pid);
      const row = { mode, key, events, provider: stub.calls.slice(start), transcripts: transcripts(join(stateDir, 'openclaw/state')) };
      receipt.push(row);
      writeFileSync(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2)); // preserve even a failed assertion
      const entries = row.transcripts as any[];
      const entry = JSON.parse(entries.find(t => t.entries)?.entries[0].entry_json);
      const recovering = row.provider.filter((c: any) => c.recovery).length;
      if (mode === 'normal') assert.equal(recovering, 0);
      if (mode === 'excluded') { assert.equal(recovering, 0); assert.equal(entry.status, 'done'); }
      if (['late', 'early'].includes(mode) && process.env.R1_APP_OWNED === '1') {
        assert.equal(recovering, 0, 'matching app-owned keys never start a synthetic recovery turn');
        assert.equal(row.provider.length, 3, 'one interrupted request + one two-request app continuation');
        assert.equal(entry.status, 'done');
        assert.ok(events.some(e => e.type === 'end' && e.result.ok && e.result.text === 'app task done'));
        assert.equal(JSON.stringify(row.transcripts).includes('unknown run'), false);
        assert.equal(JSON.stringify(row.transcripts).includes('main_session_restart_recovery'), false);
        const initial = events.find(e => e.type === 'snapshot-before-restart')?.transcripts.find((t: any) => t.entries);
        assert.equal(JSON.parse(initial.entries[0].entry_json).sessionId, entry.sessionId, 'continuation preserves session identity');
      }
      if (mode === 'late' && process.env.R1_APP_OWNED !== '1') {
        assert.equal(recovering, 2);
        assert.equal(row.provider.length, 5);
        assert.ok(JSON.stringify(row.transcripts).includes('unknown run'));
        assert.equal(entry.status, 'done');
        assert.ok(events.some(e => e.type === 'end' && e.result.ok));
      }
      if (mode === 'cancel') {
        assert.equal(recovering, 0, 'explicit cancellation must not auto-resume');
        assert.ok(events.some(e => e.type === 'end' && e.result.aborted === true));
      }
      if (mode === 'repeat') {
        // Stock counts consecutive pre-start dispatch failures, not successfully started/crashed turns.
        // docs claim three durable charged attempts, but this actual started-turn path resets the retry count.
        assert.equal(recovering, 4, 'four real started recovery requests across crashes');
        assert.equal(entry.mainRestartRecovery.chargedAttempts, 4);
        assert.equal(entry.mainRestartRecovery.startedAttempt, 4);
        assert.equal(entry.mainRestartRecovery.tombstone, undefined);
      }
      console.log(JSON.stringify({ mode, key, requests: row.provider.length, recoveryRequests: recovering,
        outcomes: events.filter(e => e.type === 'end'), status: entry.status, recovery: entry.mainRestartRecovery,
        unknownRun: JSON.stringify(row.transcripts).includes('unknown run') }));
    }
  } finally {
    for (const child of children) child.kill('SIGKILL');
    // A worker can fail before ready; its recorded, identity-verified gateway is still ours to clean up.
    for (const dir of states) {
      try { killOwned(Number(readFileSync(join(dir, 'openclaw/gateway.pid'), 'utf8')), dir); }
      catch (error) { if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) console.error('cleanup verification failed', error); }
    }
    await Promise.all([...children].map(child => once(child, 'exit')));
    await stub.close();
  }
}
