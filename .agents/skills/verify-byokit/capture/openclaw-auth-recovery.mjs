import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { OpenClawKit, stateWords } from '@byokit/openclaw';
import { fakeGateway } from '@byokit/openclaw/testing';
import { hostKeySeal } from '@byokit/secrets';

const evidence = resolve(process.argv[2]);
mkdirSync(evidence, { recursive: true, mode: 0o700 });
// Keep Unix socket paths below the host limit; only retained evidence uses the long home path.
mkdirSync('.verify-artifacts', { recursive: true, mode: 0o700 });
const stateDir = mkdtempSync('.verify-artifacts/auth-');
const seal = hostKeySeal({ key: randomBytes(32), service: 'auth-recovery-proof' });
const root = join(stateDir, 'openclaw');
const file = join(root, 'auth-store.sealed');
const auth = join(root, 'state', 'auth.json');
const kits = [];
function kit(authSeal) {
  const instance = new OpenClawKit({ stateDir, authSeal, spawnEngine: false, transport: fakeGateway().factory });
  kits.push(instance);
  return instance;
}
try {
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(auth, 'Umer task-private sign-in');
  await kit(seal).prepare();
  const original = readFileSync(file);
  const healthy = kit(seal);
  await healthy.start();
  assert.equal(readFileSync(auth, 'utf8'), 'Umer task-private sign-in');
  await healthy.stop();
  const before = readFileSync(file);
  console.log('healthy restart: restored task-private sign-in; sealed on stop');
  const wrong = kit(hostKeySeal({ key: randomBytes(32), service: 'auth-recovery-proof' }));
  let failure;
  try { await wrong.start(); } catch (error) { failure = error; }
  console.log('wrong seal:', JSON.stringify({ error: failure?.name, code: failure?.code, message: failure?.message, state: wrong.state, words: stateWords(wrong.state), originalPresent: existsSync(file), asideCount: readdirSync(root).filter(n => n.includes('.unreadable-')).length }));
  if (process.argv.includes('--baseline')) {
    assert.equal(wrong.state.phase, 'ready');
    assert.equal(existsSync(file), true, 'baseline prepare replaces original with an empty sealed snapshot');
    assert.notDeepEqual(readFileSync(file), before);
    console.log('REPRODUCED: original renamed; empty replacement created; signed-out kit is ready');
    await wrong.stop();
  } else {
    assert.equal(failure?.code, 'auth-store-unreadable');
    assert.deepEqual(wrong.state, { phase: 'failed', why: 'auth-store-unreadable' });
    assert.deepEqual(readFileSync(file), before);
    assert.equal(existsSync(auth), false);
    await wrong.stop();
    assert.deepEqual(readFileSync(file), before);
    const retry = kit(seal);
    await retry.start();
    assert.equal(retry.state.phase, 'ready');
    assert.equal(readFileSync(auth, 'utf8'), 'Umer task-private sign-in');
    await retry.stop();
    console.log('PASS: wrong seal and stop retain identical original; correct-seal retry restores sign-in');
  }
  assert.ok(original.length > 0);
} finally {
  for (const instance of kits.reverse()) await instance.stop();
  rmSync(stateDir, { recursive: true, force: true });
}
