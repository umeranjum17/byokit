import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OpenClawKit } from '@byokit/openclaw';
import { fakeGateway } from '@byokit/openclaw/testing';

const stateDir = mkdtempSync('.verify-artifacts/in-place-');
const index = () => JSON.parse(readFileSync(join(stateDir, 'openclaw', 'accounts', 'm1.json'), 'utf8')).accounts;
const fake = fakeGateway();
const requested = [];
const recording = (ctx) => {
  const transport = fake.factory(ctx);
  return { ...transport, request: (method, params, o) => { if (method === 'byokit.accounts') requested.push(params.action); return transport.request(method, params, o); } };
};
const kit = new OpenClawKit({ stateDir, transport: recording, spawnEngine: false, callbackPort: 0 });
try {
  await kit.start();
  const store = async (id) => (await kit.callDynamic('byokit.accounts', { action: 'list', agentId: index()[id].agent })).profiles;
  const rows = async () => (await kit.accounts('m1')).map((a) => [a.id, a.state, a.unavailable ?? null, a.origin]);
  const add = async (label, again) => {
    const handle = await kit.addAccount('m1', { authChoice: 'openai', via: 'browser', credentialPolicy: 'in-place', ...(again ? { again } : {}) }, () => {});
    return { handle, done: handle.done.then((d) => { console.log(`${label}: ${JSON.stringify(d)}`); return d; }) };
  };

  fake.signInAs({ accountId: 'verify-acct-umer' });
  const a = (await (await add('Umer signs in')).done).id;
  fake.signInAs({ accountId: 'verify-acct-other' });
  const b = (await (await add('another login signs in')).done).id;
  console.log('accounts:', JSON.stringify(await rows()));
  const aStore = JSON.stringify(await store(a));
  const bStore = JSON.stringify(await store(b));
  const entries = JSON.stringify(index());

  fake.signInAs({ accountId: 'verify-acct-umer' });
  const dup = await (await add('Umer signs in again as a new account')).done;
  assert.deepEqual([dup.view.why, dup.view.existing], ['duplicate', a]);
  assert.equal(JSON.stringify(await store(a)), aStore, 'A unchanged');
  assert.equal(JSON.stringify(index()), entries, 'no entry added or rebound');

  const first = await add('first of two overlapping');
  const second = await add('second of two overlapping');
  assert.equal((await second.done).view.why, 'busy');
  await first.done.catch(() => {});
  if (Object.keys(index()).length > 2) await kit.removeAccount('m1', Object.keys(index()).find((id) => id !== a && id !== b));

  fake.signInAs({ accountId: 'verify-acct-wrong' });
  const wrong = await (await add(`re-auth ${a} as the wrong login`, a)).done;
  assert.equal(wrong.view.why, 'identity_mismatch');
  assert.deepEqual((await rows()).find((r) => r[0] === a).slice(1, 3), ['needs_again', 'identity_mismatch']);
  assert.equal(JSON.stringify(await store(b)), bStore, 'B unchanged');
  const context = await kit.accountContext('m1', b);
  console.log('accountContext:', JSON.stringify({ keys: Object.keys(context), agentId: context.agentId, origin: context.account.origin, capabilities: context.account.capabilities }));
  await assert.rejects(kit.accountContext('m1', 'openai.000000'), (error) => { console.log('refused:', `${error.constructor.name}: ${error.message}`); return /unknown account/.test(error.message); });
  assert.ok(!requested.includes('adopt'), 'no credential was moved');
  console.log('requested actions:', [...new Set(requested)].join(','));
  console.log('IN-PLACE OK');
  if (process.env.DONE_DONE_EVIDENCE_ROOT) writeFileSync(join(process.env.DONE_DONE_EVIDENCE_ROOT, 'steps.json'), JSON.stringify({
    target: { version: JSON.parse(readFileSync('packages/openclaw/package.json', 'utf8')).version },
    start: 'a fresh kit on the fake gateway with no account',
    steps: ['sign in two different logins in place', 'sign in as the first login again', 'start a second sign-in while one runs',
      'sign in again on the first account as another login', 'read an account context and an unknown one'],
    result: 'two accounts on their own stores; the repeat answers duplicate, the overlap busy, the wrong re-sign-in identity_mismatch; nothing was moved',
  }, null, 2));
} finally {
  await kit.stop();
  rmSync(stateDir, { recursive: true, force: true });
}
