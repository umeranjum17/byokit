import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenClawKit } from '@byokit/openclaw';
import { fakeGateway } from '@byokit/openclaw/testing';

// A first start that misses its gateway handshake retries inside the kit (5.4 step 2). Legs use the built public
// entry with the supplied fake gateway: no engine install, no network, no account.
const evidence = resolve(process.argv[2]);
const scratch = process.argv[3];
if (!scratch || !scratch.startsWith('/') || scratch === '/') throw new Error('Pass an absolute task-private scratch root');
mkdirSync(evidence, { recursive: true, mode: 0o700 });
mkdirSync(scratch, { recursive: true, mode: 0o700 });
const stateDir = mkdtempSync(join(scratch, 'first-start-'));
const missed = () => new Promise(() => {});
// The handshake deadline is unref'd (a stuck handshake never holds a process open), so a bare script needs its own timer.
const keepAlive = setInterval(() => {}, 60_000);
const kits = [];
function kit(o) {
  const instance = new OpenClawKit({ stateDir: mkdtempSync(join(stateDir, 'k-')), spawnEngine: false, handshakeMs: 200, ...o });
  kits.push(instance);
  return instance;
}

try {
  // Leg 1: the first hello is missed, the second is answered. start() settles at ready; no second start() call.
  {
    const fake = fakeGateway();
    const phases = [];
    let attempts = 0;
    const k = kit({ onState: (s) => phases.push(s.phase === 'restarting' ? `restarting retryAt=${typeof s.retryAt}` : s.phase),
      transport: (ctx) => { const t = fake.factory(ctx); return ++attempts === 1 ? { ...t, start: missed } : t; } });
    await k.start();
    assert.equal(k.state.phase, 'ready');
    assert.equal(attempts, 2);
    console.log(JSON.stringify({ leg: 'missed first handshake retries to ready', gateway: 'supplied fakeGateway', attempts, phases, final: k.state.phase }));
    await k.stop();
  }
  // Leg 2: every hello is missed. Five attempts, then failed/handshake and start() rejects.
  {
    const fake = fakeGateway();
    let attempts = 0;
    const k = kit({ transport: (ctx) => ({ ...fake.factory(ctx), start: () => { attempts++; return missed(); } }) });
    let failure;
    try { await k.start(); } catch (error) { failure = error; }
    assert.equal(attempts, 5);
    assert.deepEqual(k.state, { phase: 'failed', why: 'handshake' });
    console.log(JSON.stringify({ leg: 'attempt cap', gateway: 'supplied fakeGateway', attempts, error: failure?.message, state: k.state }));
    await k.stop();
  }
  // Leg 3: stop() during the backoff cancels the retry: no further attempt, start() rejects.
  {
    const fake = fakeGateway();
    let attempts = 0;
    const k = kit({ transport: (ctx) => ({ ...fake.factory(ctx), start: () => { attempts++; return missed(); } }) });
    const started = k.start();
    for (let i = 0; i < 200 && k.state.phase !== 'restarting'; i++) await delay(20);
    assert.equal(k.state.phase, 'restarting');
    await k.stop();
    await started.catch(() => {});
    await delay(1500);
    assert.equal(attempts, 1);
    assert.notEqual(k.state.phase, 'ready');
    console.log(JSON.stringify({ leg: 'stop cancels the retry', gateway: 'supplied fakeGateway', attempts, state: k.state }));
  }
  console.log('PASS: first-start handshake retry, cap and stop cancel');
}
finally {
  for (const k of kits) await k.stop().catch(() => {});
  clearInterval(keepAlive);
  rmSync(stateDir, { recursive: true, force: true });
}
