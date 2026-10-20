import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { OpenClawKit } from '@byokit/openclaw';
import { fakeGateway } from '@byokit/openclaw/testing';

const stateDir = mkdtempSync('.verify-artifacts/identity-merge-');
const index = () => JSON.parse(readFileSync(join(stateDir, 'openclaw', 'accounts', 'm1.json'), 'utf8')).accounts;
const whoOf = (accountId) => createHash('sha256').update(`openai\n${accountId}`).digest('hex').slice(0, 16);
const fake = fakeGateway();
const lines = [];
const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0, log: (line) => lines.push(line) });
const seen = [];
try {
  await kit.start();
  const rows = async () => { const listed = await kit.accounts('m1'); seen.push(listed); return listed.map((a) => [a.id, a.name, a.state]); };
  const billed = async (id) => (await kit.callDynamic('byokit.accounts', { action: 'ready', agentId: index()[id].agent, provider: 'openai' })).who;
  const add = async (label, again) => {
    const handle = await kit.addAccount('m1', { authChoice: 'openai', via: 'browser', ...(again ? { again } : {}) }, (v) => seen.push(v));
    const done = await handle.done;
    seen.push(done);
    console.log(`${label}: started ${handle.id}, done ${JSON.stringify(done)}`);
    console.log('  accounts:', JSON.stringify(await rows()));
    return done.id;
  };

  fake.signInAs({ accountId: 'verify-acct-umer', email: 'umer@example.com' });
  const x = await add('first sign-in (Umer)');
  fake.signInAs({ accountId: 'verify-acct-umer', email: 'umer.new@example.com' });
  assert.equal(await add('same identity, changed email'), x, 'the same identity refreshes the existing row');
  assert.equal((await rows()).length, 1);

  fake.signInAs({ accountId: 'verify-acct-other' });
  const other = await add(`again=${x}, another identity`, x);
  assert.notEqual(other, x);
  assert.equal(await billed(x), whoOf('verify-acct-umer'), 'X keeps billing X');
  console.log(`  ${x} still billed on its own sign-in: ${await billed(x) === whoOf('verify-acct-umer')}`);

  fake.signInAs({ accountId: undefined, email: 'umer@example.com' });
  const bare = await add('no account id, same email');
  const bare2 = await add(`no account id, same email, again=${bare}`, bare);
  assert.ok(bare !== x && bare2 !== bare, 'no who means no merge');
  assert.equal((await rows()).length, 4);

  // Error case: again naming no account is refused with its cause.
  await assert.rejects(kit.addAccount('m1', { authChoice: 'openai', again: 'openai.000000' }, () => {}), (error) => {
    seen.push(error.message);
    console.log('refused:', `${error.constructor.name}: ${error.message}`);
    return /unknown account/.test(error.message);
  });

  const out = JSON.stringify([seen, lines, kit.state]);
  for (const canary of ['verify-acct-umer', 'verify-acct-other', whoOf('verify-acct-umer'), whoOf('verify-acct-other')])
    assert.ok(!out.includes(canary), `leaks ${canary}`);
  console.log('who/account id canaries absent from rows, views, done, errors, logs, state: true');
  console.log('IDENTITY-MERGE OK');
} finally {
  await kit.stop();
  rmSync(stateDir, { recursive: true, force: true });
}
