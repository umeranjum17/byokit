// O16 real Gateway acceptance. A loopback provider scripts replies; only the stock scheduler starts reviews.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, existsSync } from 'node:fs';
import { processStartTime } from '../../src/engine-patches.ts';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenClawKit } from '../../src/kit.ts';
import { readAgentDayUsage } from '../../src/day-usage.ts';
import { useModelStub, STUB_USAGE } from '../../src/testing/model-stub.ts';
import { scratchDir } from '../../../test-support.ts';
// Each case reads the UTC day (and month ledger) it started in, but the engine is a separate process stamping charges with
// its own clock, so a case still running at the next UTC midnight finds them in tomorrow's reading. Start it after midnight,
// and fail a case that straddled one anyway instead of letting it read as a usage bug.
const utcDay = () => new Date().toISOString().slice(0, 10);
let caseDay: string;
beforeEach(async () => {
  const left = Date.parse(utcDay()) + 86_400_000 - Date.now();
  if (left < 600_000) await delay(left + 1000); // 600_000: the longest case's own timeout
  caseDay = utcDay();
});
afterEach(() => { assert.equal(utcDay(), caseDay, 'case straddled UTC midnight: its day window no longer matches the engine clock'); });
test('O16 real Workshop, cold cache, failed writes, crash interruption and bounded month reads', { timeout: 600_000 }, async () => {
  let reviews = 0, foreground = 0, holdReviews = false;
  let releaseReview: (() => void) | undefined;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const review = body.messages.some((m: any) => m.role === 'user' && String(m.content).includes('Skill review. The turn above has ended'));
    if (review) reviews++; else foreground++;
    if (review && holdReviews) await new Promise<void>(resolve => { releaseReview = resolve; res.once('close', resolve); });
    const tool = !review && body.messages.filter((m: any) => m.role === 'tool').length < 9;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta: object, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id: `reply-${foreground + reviews}`,
      object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model,
      choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    send(tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `call_${foreground}`, type: 'function', function: { name: 'report', arguments: '{}' } }] } :
      { role: 'assistant', content: review ? 'No reusable skill.' : 'Done.' });
    send({}, tool ? 'tool_calls' : 'stop');
    if (body.stream_options?.include_usage) res.write(`data: ${JSON.stringify({ id: 'usage', object: 'chat.completion.chunk', model: body.model,
      choices: [], usage: STUB_USAGE })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const stateDir = process.env.BYOKIT_O16_STATE_DIR ?? scratchDir('o16-workshop');
  const kit = new OpenClawKit({ stateDir, engineDir: process.env.BYOKIT_O16_ENGINE_DIR,
    tools: [{ name: 'report', description: 'Progress', parameters: { type: 'object' } }],
    config: { skills: { workshop: { autonomous: { mode: 'auto' } } }, agents: { defaults: { heartbeat: { every: '0m' }, compaction: { memoryFlush: { enabled: false } } } } },
    host: { gate: async () => ({ allow: true }), call: async () => 'Progress recorded.' } });
  const day = new Date().toISOString().slice(0, 10), startMs = Date.parse(day), endMs = startMs + 86_400_000 - 1;
  const window = { startMs, endMs, mode: 'utc' as const };
  let first, second, cold;
  const receipts: Record<string, unknown> = {};
  const raw = () => kit.callDynamic('byokit.usage.engineStarted', { agentId: 'm1', startMs, endMs }) as Promise<any>;
  const until = async (predicate: () => Promise<boolean>, message: string) => {
    const deadline = Date.now() + 100_000;
    while (Date.now() < deadline) { if (await predicate()) return; await delay(500); }
    assert.fail(message);
  };
  const foregroundRun = async (name: string) => {
    const result = await kit.run({ member: 'm1', sessionKey: `agent:m1:o16:${name}`, message: 'Record nine progress steps, then finish.' }, () => {});
    assert.equal(result.ok, true);
  };
  try {
    await kit.start();
    const identity = JSON.parse(readFileSync(join(stateDir, 'openclaw/gateway.identity'), 'utf8'));
    assert.match(identity.bootId, /^[0-9a-f-]{36}$/);
    await useModelStub(kit, { port: address.port, url: `http://127.0.0.1:${address.port}/v1`, calls: [], close: async () => {} });
    await kit.ensureMember('m1');
    const run = await kit.run({ member: 'm1', sessionKey: 'agent:m1:o16:workshop', message: 'Record nine progress steps, then finish.' }, () => {});
    assert.equal(run.ok, true); assert.equal(foreground, 10);
    const deadline = Date.now() + 100_000;
    while (Date.now() < deadline) {
      const raw = await kit.callDynamic('byokit.usage.engineStarted', { agentId: 'm1', startMs, endMs }) as any;
      if (raw.facts?.some((f: any) => f.phase === 'ended')) break;
      await delay(500);
    }
    await delay(35_000);
    cold = await readAgentDayUsage(kit, 'm1', window);
    assert.equal(cold.transcripts.state, 'unavailable', 'first sessions.usage must honestly surface the cold cache');
    assert.equal(cold.knownTotalTokens, undefined);
    const freshBy = Date.now() + 60_000;
    do { await delay(1500); first = await readAgentDayUsage(kit, 'm1', window); }
    while (first.transcripts.state !== 'available' && Date.now() < freshBy);
    assert.equal(reviews, 1); assert.equal(first.transcripts.state, 'available');
    assert.equal(first.transcripts.totals?.totalTokens, 180);
    assert.equal(first.engineStarted.state, 'available'); assert.equal(first.engineStarted.charges.length, 1);
    const charge = first.engineStarted.charges[0];
    assert.equal(charge.state, 'counted'); assert.equal(charge.tokens?.total, 18); assert.equal(charge.bootId, identity.bootId);
    assert.match(charge.chargeId, /^skill-workshop-review:/); assert.equal(charge.kind, 'workshop-review');
    assert.equal(first.knownTotalTokens, 198);
    const exceedsCap = (known: number) => known > 190;
    assert.equal(exceedsCap(first.transcripts.totals!.totalTokens), false); assert.equal(exceedsCap(first.knownTotalTokens!), true);
    await delay(35_000);
    second = await readAgentDayUsage(kit, 'm1', window);
    assert.deepEqual(second.engineStarted, first.engineStarted); assert.equal(second.knownTotalTokens, 198); assert.equal(reviews, 1);
    // A month write fault loses two attempts; a later successful review must not repair the hole.
    const monthFile = join(stateDir, `openclaw/usage/engine-started-${day.slice(0, 7)}.jsonl`);
    renameSync(monthFile, monthFile + '.before-fault'); mkdirSync(monthFile);
    await foregroundRun('failed-month');
    await until(async () => (await raw()).live?.months[day.slice(0, 7)]?.lastSeq === 4, 'failed review attempts did not settle');
    const failed = await raw();
    assert.equal(reviews, 2); assert.equal(failed.live.months[day.slice(0, 7)].failed, 2); assert.equal(failed.complete, false);
    rmSync(monthFile, { recursive: true }); renameSync(monthFile + '.before-fault', monthFile);
    await foregroundRun('good-after-fault');
    await until(async () => (await raw()).live?.months[day.slice(0, 7)]?.lastSeq === 6, 'later good review did not settle');
    const good = await raw();
    assert.equal(reviews, 3); assert.equal(good.live.months[day.slice(0, 7)].failed, 2);
    assert.deepEqual(good.facts.map((f: any) => f.seq), [1, 2, 5, 6]); assert.equal(good.complete, false);
    receipts.failedWrite = { failed, good };
    await kit.stop();
    const stopped = readFileSync(join(stateDir, 'openclaw/usage/boots.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const stop = stopped.find(row => row.bootId === identity.bootId && row.stoppedAt !== undefined);
    assert.deepEqual(stop.months[day.slice(0, 7)], { lastSeq: 6, failed: 2 });
    await kit.start();
    const afterCleanRestart = await raw(); assert.equal(afterCleanRestart.complete, false);
    receipts.failedWrite = { ...receipts.failedWrite as object, stop, afterCleanRestart };
    // The same charge is pending in its live boot and interrupted only after an actual SIGKILL/restart.
    holdReviews = true;
    await foregroundRun('interrupted-review');
    await until(async () => reviews === 4 && (await raw()).facts.some((f: any) => f.phase === 'started' && f.seq === 1 && f.bootId !== identity.bootId), 'held review did not start');
    const pending = await readAgentDayUsage(kit, 'm1', window);
    const pendingCharge = pending.engineStarted.charges.find(c => c.state === 'pending'); assert.ok(pendingCharge);
    assert.equal(pending.complete, false);
    const crashIdentity = JSON.parse(readFileSync(join(stateDir, 'openclaw/gateway.identity'), 'utf8'));
    assert.equal(processStartTime(crashIdentity.pid), crashIdentity.startTime); assert.equal(pendingCharge.bootId, crashIdentity.bootId);
    process.kill(crashIdentity.pid, 'SIGKILL');
    await kit.stop(); releaseReview?.(); holdReviews = false;
    await kit.start();
    const interrupted = await readAgentDayUsage(kit, 'm1', window);
    assert.equal(interrupted.engineStarted.charges.find(c => c.chargeId === pendingCharge.chargeId)?.state, 'interrupted');
    assert.equal(interrupted.complete, false);
    receipts.interruption = { pending, interrupted, crashIdentity };
    // This real plugin reads a requested bad month, but never opens it for today's bounded request.
    const unreadMonth = join(stateDir, 'openclaw/usage/engine-started-2025-01.jsonl'); mkdirSync(unreadMonth);
    const bounded = await raw(); assert.equal(bounded.unreadableLines, 0);
    const badMonth = await kit.callDynamic('byokit.usage.engineStarted', { agentId: 'm1', startMs: Date.parse('2025-01-01'), endMs: Date.parse('2025-01-31T23:59:59.999Z') }) as any;
    assert.equal(badMonth.unreadableLines, 1); assert.equal(badMonth.complete, false);
    receipts.boundedMonths = { bounded, badMonth };
  } finally {
    releaseReview?.(); await kit.stop(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (process.env.BYOKIT_O16_EVIDENCE_DIR) {
      mkdirSync(process.env.BYOKIT_O16_EVIDENCE_DIR, { recursive: true });
      writeFileSync(join(process.env.BYOKIT_O16_EVIDENCE_DIR, 'workshop.json'), JSON.stringify({ stateDir, source: 'real kit; immutable patched openclaw 2026.8.1',
        foreground, reviews, cold, first, second, receipts, boots: existsSync(join(stateDir, 'openclaw/usage/boots.jsonl')) ? readFileSync(join(stateDir, 'openclaw/usage/boots.jsonl'), 'utf8') : undefined }, null, 2) + '\n');
    }
  }
});

test('O16 threshold memory flush is counted through transcripts only', { timeout: 150_000 }, async () => {
  const calls: { flush: boolean; total: number }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const flush = body.messages.some((m: any) => (typeof m.content === 'string' ? m.content :
      Array.isArray(m.content) ? m.content.map((p: any) => p.text ?? '').join('\n') : '').includes('Pre-compaction memory flush'));
    const usage = flush ? STUB_USAGE : { prompt_tokens: 7000, completion_tokens: 7, total_tokens: 7007 };
    calls.push({ flush, total: usage.total_tokens });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [delta, finish] of [[{ role: 'assistant', content: flush ? 'NO_REPLY' : 'Done.' }, null], [{}, 'stop']])
      res.write(`data: ${JSON.stringify({ id: 'memory', object: 'chat.completion.chunk', model: body.model,
        choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: 'usage', object: 'chat.completion.chunk', model: body.model, choices: [], usage })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const stub = { port: address.port, url: `http://127.0.0.1:${address.port}/v1`, calls: [], close: async () => new Promise<void>(resolve => server.close(() => resolve())) };
  const stateDir = process.env.BYOKIT_O16_STATE_DIR ? process.env.BYOKIT_O16_STATE_DIR + '-memory' : scratchDir('o16-memory');
  const kit = new OpenClawKit({ stateDir, engineDir: process.env.BYOKIT_O16_ENGINE_DIR,
    config: { plugins: { allow: ['memory-core'], slots: { memory: 'memory-core' } }, agents: { defaults: { heartbeat: { every: '0m' },
      compaction: { reserveTokens: 0, memoryFlush: { enabled: true, softThresholdTokens: 6000 } } } } } });
  const startMs = Date.parse(new Date().toISOString().slice(0, 10)), endMs = startMs + 86_400_000 - 1;
  const window = { startMs, endMs, mode: 'utc' as const };
  let reading;
  try {
    await kit.start(); await useModelStub(kit, stub); await kit.ensureMember('m1');
    const sessionKey = 'agent:m1:o16:memory';
    assert.equal((await kit.run({ member: 'm1', sessionKey, message: 'Cross the soft memory-flush threshold.' }, () => {})).ok, true);
    assert.equal(calls.filter(c => c.flush).length, 1, 'soft threshold did not schedule the memory flush');
    assert.equal(calls.length, 2, 'unexpected engine-started provider call; reassess accounting');
    const db = new DatabaseSync(join(stateDir, 'openclaw/state/agents/m1/agent/openclaw-agent.sqlite'), { readOnly: true });
    try {
      const row = db.prepare('SELECT entry_json FROM session_nodes WHERE session_key=?').get(sessionKey) as { entry_json: string };
      assert.equal(JSON.parse(row.entry_json).memoryFlush?.kind, 'succeeded', 'engine did not persist successful memory-flush metadata');
    } finally { db.close(); }
    const deadline = Date.now() + 70_000;
    do { reading = await readAgentDayUsage(kit, 'm1', window); if (reading.transcripts.state === 'available') break; await delay(1500); }
    while (Date.now() < deadline);
    assert.equal(reading.transcripts.state, 'available'); assert.equal(reading.transcripts.totals?.totalTokens, 7025);
    assert.deepEqual(reading.engineStarted.charges, []); assert.equal(reading.knownTotalTokens, 7025);
  } finally {
    await kit.stop(); await stub.close();
    if (process.env.BYOKIT_O16_EVIDENCE_DIR) writeFileSync(join(process.env.BYOKIT_O16_EVIDENCE_DIR, 'memory.json'),
      JSON.stringify({ stateDir, providerCalls: calls, reading }, null, 2) + '\n');
  }
});

test('O16 real crash recovery resumes are counted through retained transcripts only', { timeout: 180_000 }, async () => {
  const calls: { recovery: boolean; held: boolean; reported?: number }[] = [];
  let release: (() => void) | undefined;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const texts = body.messages.map((m: any) => typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((p: any) => p.text ?? '').join('\n') : '');
    const recovery = texts.some((text: string) => text.includes('previous turn was interrupted by a gateway restart'));
    const held = !recovery && body.messages.some((m: any) => m.role === 'tool');
    const call: { recovery: boolean; held: boolean; reported?: number } = { recovery, held }; calls.push(call);
    if (held) { await new Promise<void>(resolve => { release = resolve; res.once('close', resolve); }); return; }
    const tool = !recovery;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'recovery-tool', type: 'function', function: { name: 'report', arguments: '{}' } }] } : { role: 'assistant', content: 'Recovered.' };
    for (const [part, finish] of [[delta, null], [{}, tool ? 'tool_calls' : 'stop']]) res.write(`data: ${JSON.stringify({ id: 'recovery', object: 'chat.completion.chunk',
      model: body.model, choices: [{ index: 0, delta: part, finish_reason: finish }] })}\n\n`);
    call.reported = 18;
    res.write(`data: ${JSON.stringify({ id: 'usage', object: 'chat.completion.chunk', model: body.model, choices: [], usage: STUB_USAGE })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const stateDir = process.env.BYOKIT_O16_STATE_DIR ? process.env.BYOKIT_O16_STATE_DIR + '-recovery' : scratchDir('o16-recovery');
  const kit = new OpenClawKit({ stateDir, engineDir: process.env.BYOKIT_O16_ENGINE_DIR, tools: [{ name: 'report', description: 'Progress', parameters: { type: 'object' } }],
    config: { agents: { defaults: { heartbeat: { every: '0m' }, compaction: { memoryFlush: { enabled: false } } } } },
    host: { gate: async () => ({ allow: true }), call: async () => 'Recorded.' } });
  const startMs = Date.parse(new Date().toISOString().slice(0, 10)), endMs = startMs + 86_400_000 - 1;
  const window = { startMs, endMs, mode: 'utc' as const };
  let reading, originalIdentity, originalRun;
  try {
    await kit.start(); await useModelStub(kit, { port: address.port, url: `http://127.0.0.1:${address.port}/v1`, calls: [], close: async () => {} }); await kit.ensureMember('m1');
    const running = kit.run({ member: 'm1', sessionKey: 'agent:m1:o16:recovery', message: 'Report once, then finish.' }, () => {});
    const heldBy = Date.now() + 30_000;
    while (!calls.some(c => c.held) && Date.now() < heldBy) await delay(100);
    assert.equal(calls.filter(c => c.held).length, 1, 'foreground model work was not held');
    originalIdentity = JSON.parse(readFileSync(join(stateDir, 'openclaw/gateway.identity'), 'utf8'));
    assert.equal(processStartTime(originalIdentity.pid), originalIdentity.startTime);
    process.kill(originalIdentity.pid, 'SIGKILL'); await kit.stop(); release?.(); originalRun = await running;
    await kit.start();
    const deadline = Date.now() + 90_000;
    do { reading = await readAgentDayUsage(kit, 'm1', window); if (reading.transcripts.totals?.totalTokens === 36) break; await delay(1500); }
    while (Date.now() < deadline);
    assert.equal(calls.filter(c => c.recovery && c.reported === 18).length, 1, 'real engine recovery provider request was not confirmed');
    assert.equal(reading.transcripts.state, 'available'); assert.equal(reading.transcripts.totals?.totalTokens, 36);
    assert.equal(calls.reduce((sum, c) => sum + (c.reported ?? 0), 0), 36);
    assert.deepEqual(reading.engineStarted.charges, []); assert.equal(reading.knownTotalTokens, 36);
    assert.equal(reading.complete, false, 'overlapping crash boot can never become complete');
  } finally {
    release?.(); await kit.stop(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (process.env.BYOKIT_O16_EVIDENCE_DIR) writeFileSync(join(process.env.BYOKIT_O16_EVIDENCE_DIR, 'recovery.json'),
      JSON.stringify({ stateDir, calls, originalIdentity, originalRun, reading, boots: existsSync(join(stateDir, 'openclaw/usage/boots.jsonl')) ? readFileSync(join(stateDir, 'openclaw/usage/boots.jsonl'), 'utf8') : undefined }, null, 2) + '\n');
  }
});
