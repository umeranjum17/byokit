import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ENGINE_VERSION, OpenClawKit, stateWords } from '@byokit/openclaw';
import { fakeGateway } from '@byokit/openclaw/testing';
import { hostKeySeal } from '@byokit/secrets';

const evidence = resolve(process.argv[2]);
// Phase 2 spawns the real pinned engine: its install and runtime state are bulky, and the bridge socket
// must stay below the Unix path limit, so both live under the caller's absolute scratch root, not here.
const scratch = process.argv[3];
if (!scratch || !scratch.startsWith('/') || scratch === '/') throw new Error('Pass an absolute task-private scratch root');
mkdirSync(evidence, { recursive: true, mode: 0o700 });
mkdirSync(scratch, { recursive: true, mode: 0o700 });
const stateDir = mkdtempSync(join(scratch, 'auth-'));
const seal = hostKeySeal({ key: randomBytes(32), service: 'auth-recovery-proof' });
const root = join(stateDir, 'openclaw');
const file = join(root, 'auth-store.sealed');
const auth = join(root, 'state', 'auth.json');
const credentials = join(root, 'home', '.claude', '.credentials.json');
const kits = [];
function kit(authSeal) {
  const instance = new OpenClawKit({ stateDir, authSeal, spawnEngine: false, transport: fakeGateway().factory });
  kits.push(instance);
  return instance;
}
function engineKit(authSeal, enginePath) {
  const instance = new OpenClawKit({ stateDir, authSeal, engineDir: join(scratch, 'engine'), enginePath,
    config: { agents: { defaults: { modelPolicy: { allow: ['claude-cli/*'] } } } } });
  kits.push(instance);
  return instance;
}
const gatewayLabel = 'supplied fakeGateway';
const engineLabel = 'spawned pinned engine';
try {
  // The sealed snapshot carries both markers: the SDK state marker and the synthetic native CLI sign-in the
  // offline stand-in reads, so pinned-engine readiness proves the recovered sign-in, not just file bytes.
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(auth, 'Umer task-private sign-in');
  mkdirSync(join(root, 'home', '.claude'), { recursive: true });
  writeFileSync(credentials, 'synthetic signed-in');
  await kit(seal).prepare();
  const original = readFileSync(file);
  const healthy = kit(seal);
  await healthy.start();
  assert.equal(readFileSync(auth, 'utf8'), 'Umer task-private sign-in');
  await healthy.stop();
  const before = readFileSync(file);
  console.log(JSON.stringify({ leg: 'healthy restart', gateway: gatewayLabel, restored: 'task-private sign-in', sealedOnStop: true }));
  const wrong = kit(hostKeySeal({ key: randomBytes(32), service: 'auth-recovery-proof' }));
  let failure;
  try { await wrong.start(); } catch (error) { failure = error; }
  console.log('wrong seal:', JSON.stringify({ gateway: gatewayLabel, error: failure?.name, code: failure?.code, message: failure?.message, state: wrong.state, words: stateWords(wrong.state), originalPresent: existsSync(file), asideCount: readdirSync(root).filter(n => n.includes('.unreadable-')).length }));
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
    console.log(JSON.stringify({ leg: 'correct-seal retry', gateway: gatewayLabel, note: 'PASS: wrong seal and stop retain identical original; correct-seal retry restores sign-in' }));

    // Phase 2: the same sealed store driven through a real spawned pinned engine with an offline native CLI
    // stand-in (never a real provider, sign-in or spend). First run installs the pinned engine (npm registry
    // egress only). Every readiness claim below names its gateway: spawned pinned engine or supplied fakeGateway.
    const bin = join(stateDir, 'bin');
    mkdirSync(bin, { mode: 0o700 });
    // Keep the extensionless CLI's require() valid when the scratch root inherits this repo's ESM package.
    writeFileSync(join(bin, 'package.json'), JSON.stringify({ type: 'commonjs' }));
    const probes = join(stateDir, 'auth-probes');
    writeFileSync(probes, '');
    writeFileSync(join(bin, 'claude'), `#!${process.execPath}
const {readFileSync,appendFileSync}=require('node:fs');
const args=process.argv.slice(2).join(' ');
if(args==='--version') console.log('2.1.0 (Claude Code)');
else if(args.startsWith('auth status')) {
 appendFileSync(${JSON.stringify(probes)},'auth\\n');
 const loggedIn=readFileSync(process.env.CLAUDE_CONFIG_DIR+'/.credentials.json','utf8')==='synthetic signed-in';
 console.log(args.endsWith('--json')?JSON.stringify({loggedIn,authMethod:'claude.ai',subscriptionType:'max'}):(loggedIn?'Login method: Claude Max Account':'Not logged in'));
 if(!loggedIn) process.exit(1); // setup.detect interprets the status command's exit, not JSON loggedIn
} else { console.error('401 Unauthorized: your sign-in has expired'); process.exit(1); }
`, { mode: 0o700 });
    const probeCount = () => readFileSync(probes, 'utf8').trim().split('\n').filter(Boolean).length;
    const setsListing = () => existsSync(join(scratch, 'engine.sets')) ? readdirSync(join(scratch, 'engine.sets')).sort().join(',') : '';
    const engineReady = async (instance, leg) => {
      await instance.start();
      assert.equal(instance.state.phase, 'ready');
      assert.equal(instance.hello?.server?.version, ENGINE_VERSION);
      assert.equal(readFileSync(credentials, 'utf8'), 'synthetic signed-in');
      const beforeProbes = probeCount();
      assert.equal(await instance.signedIn('umer', 'claude-cli'), true);
      console.log(JSON.stringify({ leg, gateway: engineLabel, engineVersion: instance.hello.server.version, nativeAuthChecks: probeCount() - beforeProbes, sign_in: 'recovered synthetic sign-in admitted by the offline native CLI stand-in' }));
      await instance.stop();
      assert.equal(existsSync(credentials), false, 'stop must re-seal the recovered sign-in');
    };
    const refuseUnreadable = async (instance, leg, expected) => {
      let failure;
      try { await instance.start(); } catch (error) { failure = error; }
      assert.equal(failure?.code, 'auth-store-unreadable');
      assert.deepEqual(instance.state, { phase: 'failed', why: 'auth-store-unreadable' });
      assert.deepEqual(readFileSync(file), expected);
      assert.equal(existsSync(join(root, 'gateway.pid')), false, 'unreadable seal must not start a gateway');
      assert.equal(instance.hello, undefined);
      const failedState = instance.state;
      const words = stateWords(failedState);
      const beforeProbes = probeCount();
      await instance.stop();
      assert.equal(probeCount(), beforeProbes, 'no native auth probe may run while the seal is unreadable');
      assert.deepEqual(readFileSync(file), expected);
      console.log('wrong seal:', JSON.stringify({ leg, gateway: `${engineLabel} kit; none started`, code: failure.code, state: failedState, words, originalIdentical: true, gatewayPid: false, nativeAuthChecks: 0 }));
    };
    // The seal gates prepare: an unreadable seal refuses before the pinned engine installs. On a root whose
    // engine set is already cached (an earlier drive), the refusal must leave that set untouched instead.
    const beforeSets = setsListing();
    await refuseUnreadable(engineKit(hostKeySeal({ key: randomBytes(32), service: 'auth-recovery-proof' }), [bin]), 'wrong seal before recovery (engine set untouched)', readFileSync(file));
    assert.equal(setsListing(), beforeSets, 'unreadable seal must refuse before engine install');
    // Recovery through the real spawned pinned engine: original-key retry reaches ready.
    await engineReady(engineKit(seal, [bin]), 'original-key retry');
    // A later healthy restart through the same spawned pinned engine stays ready.
    await engineReady(engineKit(seal, [bin]), 'healthy restart');
    // With the engine installed, an unreadable seal still refuses: no spawn, no probe, original bytes intact.
    await refuseUnreadable(engineKit(hostKeySeal({ key: randomBytes(32), service: 'auth-recovery-proof' }), [bin]), 'wrong seal after recovery (engine installed, none started)', readFileSync(file));
    assert.ok(existsSync(join(scratch, 'engine.sets')));
    console.log(JSON.stringify({ proof: 'pinned-engine readiness', spawnedEngineReady: ['original-key retry', 'healthy restart'], suppliedGatewayOnly: ['healthy restart (marker)', 'correct-seal retry (marker)'], providerAuthenticity: 'out of scope; offline stand-in only' }));
  }
  assert.ok(original.length > 0);
} finally {
  for (const instance of kits.reverse()) await instance.stop();
  rmSync(stateDir, { recursive: true, force: true });
}
