import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenClawKit, ENGINE_VERSION } from '@byokit/openclaw';
import { startModelStub, releaseStub, stubHolding } from '@byokit/openclaw/testing';
const scratch = process.env.ABORT_SCRATCH;
assert.ok(scratch);
const stub = await startModelStub();
const unhandled = [];
const onUnhandled = error => unhandled.push(String(error));
process.on('unhandledRejection', onUnhandled);
const stateDir = join(scratch, 'state');
const kit = new OpenClawKit({ stateDir, engineDir: join(scratch, 'engine'),
  config: {
    models: { providers: { 'byokit-stub': { baseUrl: stub.url, apiKey: 'byokit-stub', api: 'openai-completions', models: [
      { id: 'test', name: 'Test', input: ['text'], contextWindow: 32000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    ] } } },
    agents: { defaults: { model: { primary: 'byokit-stub/test' }, heartbeat: { every: '0m' } } },
  },
});
async function until(fn) {
  const end = Date.now() + 120000;
  while (!fn()) { assert.ok(Date.now() < end, 'condition timeout'); await delay(20); }
}
async function cancel(label, key, options) {
  let sync;
  let rejection;
  try { await kit.abort(key, options).catch(error => { rejection = error.message; }); }
  catch (error) { sync = { message: error.message, stack: error.stack }; }
  const result = { label, sync: sync ?? null, rejection: rejection ?? null };
  console.log(JSON.stringify(result));
  return result;
}
try {
  await kit.start();
  assert.equal(kit.state.phase, 'ready');
  console.log(JSON.stringify({ engine: ENGINE_VERSION, entry: import.meta.resolve('@byokit/openclaw'), phase: kit.state.phase }));
  const healthyKey = 'agent:m1:abort:healthy';
  const healthy = kit.run({ member: 'm1', sessionKey: healthyKey, message: 'ask permission to continue' });
  await until(() => stubHolding());
  const normal = await cancel('healthy-control', healthyKey);
  releaseStub();
  const healthyEnd = await healthy;
  console.log(JSON.stringify({ label: 'healthy-end', result: healthyEnd }));
  assert.deepEqual(healthyEnd, { ok: false, aborted: true });
  assert.equal(normal.sync, null);
  assert.equal(normal.rejection, null);
  const key = 'agent:m1:abort:drop';
  const pending = kit.run({ member: 'm1', sessionKey: key, message: 'ask permission to continue' });
  await until(() => stubHolding());
  const root = join(stateDir, 'openclaw');
  const pid = Number(readFileSync(join(root, 'gateway.pid'), 'utf8'));
  const identity = JSON.parse(readFileSync(join(root, 'gateway.identity'), 'utf8'));
  assert.equal(identity.pid, pid);
  assert.equal(identity.startTime, readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1).split(' ')[19]);
  assert.ok(readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(`OPENCLAW_STATE_DIR=${join(root, 'state')}`));
  process.kill(pid, 'SIGKILL');
  await until(() => kit.state.phase !== 'ready');
  const drop = await cancel('drop-mid-task', key);
  const lostEnd = await pending;
  console.log(JSON.stringify({ label: 'lost-end', phase: kit.state.phase, result: lostEnd }));
  assert.equal(lostEnd.ok, false);
  assert.equal('aborted' in lostEnd, false, 'loss is not a successful cancellation');
  await kit.stop(); // stop automatic recovery so the already-gone control cannot address a new engine
  const gone = await cancel('already-gone', key);
  const invalid = await cancel('invalid-key', 'invalid', { auth: 'apiKey' });
  await delay(30);
  console.log(JSON.stringify({ unhandled }));
  assert.deepEqual(unhandled, []);
  assert.equal(drop.sync, null);
  assert.match(drop.rejection, /gateway not ready/);
  assert.equal(gone.sync, null);
  assert.match(gone.rejection, /gateway not ready/);
  assert.equal(invalid.sync, null);
  assert.match(invalid.rejection, /Choose your own conversation/);
} finally {
  releaseStub();
  await kit.stop();
  await stub.close();
  process.removeListener('unhandledRejection', onUnhandled);
}
