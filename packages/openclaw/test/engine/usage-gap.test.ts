// R4 foundation probe, not acceptance: stock 2026.8.1's detached Workshop review is absent from sessions.usage.
// Real scheduler, real provider requests, no direct review dispatch or accounts. Engine job only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenClawKit } from '../../src/kit.ts';
import { scratchDir } from '../../../test-support.ts';
import { useModelStub, STUB_USAGE } from '../../src/testing/model-stub.ts';
import { readAgentUsage } from '../../src/usage.ts';

test('R4 stock engine starts Workshop review but its day ledger omits that usage', { timeout: 600_000 }, async () => {
  const calls: { review: boolean; body: any }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const review = body.messages.some((m: any) => m.role === 'user' && String(m.content).includes('Skill review. The turn above has ended'));
    calls.push({ review, body });
    const toolResults = body.messages.filter((m: any) => m.role === 'tool').length;
    const tool = !review && toolResults < 9;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta: object, finish: string | null = null) => res.write(`data: ${JSON.stringify({
      id: `probe-${calls.length}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`);
    send(tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `call_${calls.length}`, type: 'function',
      function: { name: 'report', arguments: '{}' } }] } : { role: 'assistant', content: review ? 'No reusable skill.' : 'Done.' });
    send({}, tool ? 'tool_calls' : 'stop');
    if (body.stream_options?.include_usage) res.write(`data: ${JSON.stringify({ id: `probe-${calls.length}`,
      object: 'chat.completion.chunk', model: body.model, choices: [], usage: STUB_USAGE })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const stub = { port: address.port, url: `http://127.0.0.1:${address.port}/v1`, calls: [], close: async () => {} };
  const stateDir = scratchDir('r4');
  const logs: string[] = [];
  const kit = new OpenClawKit({ stateDir, engineDir: process.env.BYOKIT_R4_ENGINE_DIR ?? join(scratchDir('r4-install'), 'engine'), tools: [{ name: 'report', description: 'Progress', parameters: { type: 'object' } }],
    config: { skills: { workshop: { autonomous: { mode: 'auto' } } }, agents: { defaults: { heartbeat: { every: '0m' }, compaction: { memoryFlush: { enabled: false } } } } },
    log: line => logs.push(line), host: { gate: async () => ({ allow: true }), call: async () => 'Progress recorded.' } });
  try {
    await kit.start();
    await useModelStub(kit, stub);
    await kit.ensureMember('m1');
    const result = await kit.run({ member: 'm1', sessionKey: 'agent:m1:r4:workshop', message: 'Record nine progress steps, then finish.' }, () => {});
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(calls.filter(c => !c.review).length, 10);
    const day = new Date().toISOString().slice(0, 10);
    const query = { agentId: 'm1', startDate: day, endDate: day, mode: 'utc' as const, limit: 100 };
    const before = await kit.call('sessions.usage', query);
    // Native engine scheduler owns the 30s idle trigger; this test never dispatches the review.
    const deadline = Date.now() + 100_000;
    while (!calls.some(c => c.review) && Date.now() < deadline) await delay(500);
    assert.equal(calls.filter(c => c.review).length, 1, 'engine did not start the Workshop review');
    // Wait beyond the response cache TTL as well as the review completion: not a stale-cache undercount.
    await delay(35_000);
    const after = await kit.call('sessions.usage', query) as any;
    const status = await kit.call('skills.curator.status', {}) as any;
    const reading = await readAgentUsage(kit, 'm1', { startDate: day, endDate: day });
    assert.equal(reading.state, 'available');
    assert.equal(reading.coverage, 'retained-transcripts-only');
    assert.equal(reading.totals?.totalTokens, 180);
    const reviews = Object.values(status.experienceReview) as { outcome: string; usage: { inputTokens: number; outputTokens: number } }[];
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].outcome, 'nothing');
    const reviewTokens = reviews[0].usage.inputTokens + reviews[0].usage.outputTokens;
    assert.equal(reviewTokens, 18); // confirmed outcome, not HTTP count treated as committed ledger usage
    const exceedsShare = (tokens: number) => tokens > 1000 * 0.19; // test caller owns policy
    assert.equal(exceedsShare(reading.totals!.totalTokens), false);
    assert.equal(exceedsShare(reading.totals!.totalTokens + reviewTokens), true); // proves the supported ledger alone misses the cap
    // No production reconciliation sums this last-outcome record: it overwrites history and has no charge identity.
    if (process.env.BYOKIT_R4_EVIDENCE_DIR) {
      mkdirSync(process.env.BYOKIT_R4_EVIDENCE_DIR, { recursive: true });
      writeFileSync(join(process.env.BYOKIT_R4_EVIDENCE_DIR, 'workshop.json'), JSON.stringify({ source: 'stock openclaw 2026.8.1', stateDir,
        query, result, before, after, status, reading, providerCalls: calls, logs }, null, 2) + '\n');
    }
    assert.equal(after.cacheStatus.status, 'fresh');
    assert.equal(after.totals.totalTokens, 10 * STUB_USAGE.total_tokens, 'stock day ledger behavior changed; reassess gap');
    assert.equal(calls.length * STUB_USAGE.total_tokens, 11 * STUB_USAGE.total_tokens);
  } finally {
    await kit.stop();
    await new Promise<void>(yes => server.close(() => yes()));
  }
});
