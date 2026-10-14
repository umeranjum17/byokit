import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OpenClawKit, words } from '@byokit/openclaw';
import { fakeGateway } from '@byokit/openclaw/testing';
import { hostKeySeal } from '@byokit/secrets';

const stateDir = mkdtempSync('.verify-artifacts/index-recovery-');
const root = join(stateDir, 'openclaw');
const indexOf = (member) => join(root, 'accounts', `${member}.json`);
const fake = fakeGateway();
const authSeal = hostKeySeal({ key: new Uint8Array(32).fill(21) });
const lines = [];
const kit = new OpenClawKit({
  stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0, authSeal,
  log: (line) => lines.push(line),
});
try {
  await kit.start();
  assert.equal((await kit.signIn('m1', { authChoice: 'openai' }, () => {}).done).state, 'done');
  const second = await kit.addAccount('m1', { authChoice: 'openai', via: 'browser' }, () => {});
  assert.equal((await second.done).view.state, 'done');
  const held = `m1--${second.id.slice('openai.'.length)}`;
  assert.equal((await kit.signIn('m2', { authChoice: 'openai' }, () => {}).done).state, 'done');
  mkdirSync(join(root, 'state', 'agents', held, 'agent'), { recursive: true });
  writeFileSync(join(root, 'state', 'agents', held, 'agent', 'auth.json'), 'held-back-marker');
  mkdirSync(join(root, 'state', 'agents', 'm2', 'agent'), { recursive: true });
  writeFileSync(join(root, 'state', 'agents', 'm2', 'agent', 'auth.json'), 'm2-marker');
  await kit.stop();

  writeFileSync(indexOf('m1'), '{');
  const kit2 = new OpenClawKit({
    stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0, authSeal,
    log: (line) => lines.push(line),
  });
  try {
    await kit2.start();
    assert.deepEqual((await kit2.accounts('m2')).map((a) => a.id), ['openai']);
    const damaged = words('account.indexDamaged', { member: 'm1' });
    await assert.rejects(kit2.accounts('m1'), (error) => error.message === damaged);
    assert.ok(lines.some((line) => line.includes(damaged)), 'the kit reports the damaged index');
    assert.equal(readFileSync(indexOf('m1'), 'utf8'), '{', 'the damaged index is kept');
    assert.ok(!existsSync(join(root, 'state', 'agents', held)), 'the quarantined agent is not restored');
    assert.equal(readFileSync(join(root, 'state', 'agents', 'm2', 'agent', 'auth.json'), 'utf8'), 'm2-marker');
    console.log('quarantine: m2 usable, m1 paused, held agent not restored');

    const readded = await kit2.addAccount('m1', { authChoice: 'openai', via: 'browser' }, () => {});
    assert.equal((await readded.done).view.state, 'done');
    assert.doesNotThrow(() => JSON.parse(readFileSync(indexOf('m1'), 'utf8')), 're-add rewrites a good index');
    assert.ok((await kit2.accounts('m1')).some((a) => a.id === readded.id));
    console.log('repair: re-add rewrote the index; m1 accounts list again');
    console.log('INDEX-RECOVERY OK');
  } finally {
    await kit2.stop();
  }
} finally {
  await kit.stop();
  rmSync(stateDir, { recursive: true, force: true });
}
