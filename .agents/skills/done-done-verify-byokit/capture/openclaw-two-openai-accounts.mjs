import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { OpenClawKit } from '@byokit/openclaw';
import { fakeGateway } from '@byokit/openclaw/testing';

const require = createRequire(import.meta.url);
const resolved = require.resolve('@byokit/openclaw');
if (!resolved.includes(`${join('packages', 'openclaw', 'dist')}`)) throw new Error(`expected built package, got ${resolved}`);
const evidence = process.argv[2];
if (!evidence) throw new Error('usage: openclaw-two-openai-accounts.mjs <evidence-dir>');
const stateDir = mkdtempSync('/tmp/twooa-');
const fake = fakeGateway();
const actions = [];
let blockedProbe;
const transport = (ctx) => {
  const base = fake.factory(ctx);
  return { ...base, request: (method, params, options) => {
    if (method === 'byokit.accounts') actions.push({ action: params.action, agentId: params.agentId });
    if (method === 'byokit.accounts' && params.action === 'list' && blockedProbe && params.agentId === blockedProbe) return Promise.reject(new Error('fixture account probe timed out'));
    return base.request(method, params, options);
  } };
};
const make = () => new OpenClawKit({ stateDir, transport, spawnEngine: false, callbackPort: 0 });
let kit = make();
const indexPath = join(stateDir, 'openclaw', 'accounts', 'm1.json');
const index = () => JSON.parse(readFileSync(indexPath, 'utf8')).accounts;
const profiles = async (id) => (await kit.callDynamic('byokit.accounts', { action: 'list', agentId: index()[id].agent })).profiles;
const rows = async () => Object.fromEntries((await kit.accounts('m1')).map((r) => [r.id, r.state]));
const add = async (fields = {}) => {
  const h = await kit.addAccount('m1', { authChoice: 'openai', via: 'browser', credentialPolicy: 'in-place', ...fields }, () => {});
  return h;
};
const outputs = [];
const note = (label, value) => { outputs.push({ label, value }); console.log(label, JSON.stringify(value)); };
const requests = () => fake.calls.filter((c) => c.method === 'agent');
try {
  await kit.start();
  fake.signInAs({ accountId: 'fixture-chatgpt-A', expires: Date.now() + 86_400_000 });
  const a = await (await add()).done;
  fake.signInAs({ accountId: 'fixture-chatgpt-B', expires: Date.now() + 86_400_000 });
  const b = await (await add()).done;
  assert.notEqual(a.id, b.id);
  const aAgent = index()[a.id].agent, bAgent = index()[b.id].agent;
  assert.notEqual(aAgent, bAgent);
  assert.equal((await profiles(a.id)).length, 1);
  assert.equal((await profiles(b.id)).length, 1);
  note('two final stores', { ids: [a.id, b.id], agents: [aAgent, bAgent], principalsDistinct: (await profiles(a.id))[0].who !== (await profiles(b.id))[0].who });

  // Duplicate B add cannot mutate A or B. Concurrent authorization is busy; cancellation before/after completion is deterministic.
  const beforeA = JSON.stringify(await profiles(a.id)), beforeB = JSON.stringify(await profiles(b.id));
  fake.signInAs({ accountId: 'fixture-chatgpt-A' });
  const duplicate = await (await add()).done;
  assert.deepEqual([duplicate.view.why, duplicate.view.existing], ['duplicate', a.id]);
  assert.equal(JSON.stringify(await profiles(a.id)), beforeA);
  assert.equal(JSON.stringify(await profiles(b.id)), beforeB);
  fake.signInAs({ accountId: 'fixture-chatgpt-C' });
  const first = await add(), overlapping = await add();
  assert.equal((await overlapping.done).view.why, 'busy');
  first.cancel();
  assert.equal((await first.done).view.why, 'declined');
  fake.signInAs({ accountId: 'fixture-chatgpt-D' });
  const cancelled = await add(); cancelled.cancel();
  assert.equal((await cancelled.done).view.why, 'declined');
  const committed = await add(); const committedResult = await committed.done; committed.cancel();
  assert.equal(committedResult.view.state, 'done');
  assert.equal((await kit.accounts('m1')).find((r) => r.id === committed.id)?.state, 'ready');
  await kit.removeAccount('m1', committed.id);

  // Wrong principal re-auth marks A only; expiry is explicit and survives a kit restart.
  fake.signInAs({ accountId: 'fixture-wrong-principal' });
  const wrong = await (await add({ again: a.id })).done;
  assert.equal(wrong.view.why, 'identity_mismatch');
  assert.deepEqual(await rows(), { [a.id]: 'needs_again', [b.id]: 'ready' });
  assert.equal(JSON.stringify(await profiles(b.id)), beforeB);
  fake.signInAs({ accountId: 'fixture-chatgpt-A', expires: Date.now() + 86_400_000 });
  await (await add({ again: a.id })).done;
  fake.signInAs({ accountId: 'fixture-expired', expires: Date.now() + 86_400_000 });
  const expired = await (await add()).done;
  assert.equal(expired.view.state, 'done');
  fake.refresh(index()[expired.id].agent, 'openai', { expires: Date.now() - 1 });
  assert.equal((await kit.accounts('m1')).find((r) => r.id === expired.id)?.state, 'needs_again');
  await kit.stop(); kit = make(); await kit.start();
  assert.equal((await kit.accounts('m1')).find((r) => r.id === expired.id)?.state, 'needs_again');
  note('identity/cancel/expiry/restart', { duplicate: duplicate.view.why, overlap: 'busy', earlyCancel: 'declined', committedCancel: 'still ready', wrongPrincipal: wrong.view.why, expiredAfterRestart: (await kit.accounts('m1')).find((r) => r.id === expired.id)?.state });

  // Restore A as the same principal, then demonstrate that uncertainty is not sign-out and a revocation is scoped.
  fake.signInAs({ accountId: 'fixture-chatgpt-A', expires: Date.now() + 86_400_000 });
  await (await add({ again: a.id })).done;
  blockedProbe = index()[a.id].agent;
  const unknown = await kit.accountStatus('m1', a.id, { fresh: true });
  assert.equal(unknown.state, 'unknown');
  assert.equal((await kit.accountStatus('m1', b.id)).state, 'ready');
  assert.equal((await kit.accounts('m1')).find((r) => r.id === a.id)?.state, 'unknown');
  assert.equal((await kit.accounts('m1')).find((r) => r.id === b.id)?.state, 'ready');
  blockedProbe = undefined;
  // Revoke through the synthetic engine store; only A is targeted.
  const aProfiles = await profiles(a.id);
  await kit.call('models.authLogout', { provider: 'openai', agentId: index()[a.id].agent, profileIds: aProfiles.map((p) => p.profileId) });
  const logout = fake.calls.findLast((c) => c.method === 'models.authLogout');
  assert.equal(logout.params.agentId, index()[a.id].agent);
  assert.deepEqual(logout.params.profileIds, aProfiles.map((p) => p.profileId));
  const aAfter = await kit.accountStatus('m1', a.id, { fresh: true });
  assert.equal(aAfter.state, 'signed_out');
  assert.equal((await kit.accountStatus('m1', b.id, { fresh: true })).state, 'ready');
  note('unknown and revocation isolation', { unknownA: unknown.state, bDuringUnknown: 'ready', revokedA: aAfter.state, bAfterRevocation: 'ready' });

  // Bind explicit runs to each account. An A limit rests A, never switches to B; B remains independently runnable.
  fake.signInAs({ accountId: 'fixture-chatgpt-A', expires: Date.now() + 86_400_000 });
  await (await add({ again: a.id })).done;
  fake.setUsage(index()[a.id].agent, 'openai', [{ label: 'session', usedPercent: 95 }]);
  fake.setUsage(index()[b.id].agent, 'openai', [{ label: 'session', usedPercent: 5 }]);
  for (const id of [a.id, b.id]) await kit.room('m1', id); // warm each fixture's engine auth-status cache
  const roomA = await kit.room('m1', a.id), roomB = await kit.room('m1', b.id);
  assert.equal(roomA.left, 5);
  assert.equal(roomB.left, 95);
  fake.failNext('agent', 'You have hit your ChatGPT usage limit (plus plan). Try again in ~30 min.');
  const eventA = [];
  const aEnd = await kit.run({ member: 'm1', sessionKey: 'agent:m1:exact-A', message: 'fixture A', account: a.id }, (event) => { if (event.type === 'account') eventA.push(event); });
  assert.equal(eventA[0].account, a.id);
  assert.equal(aEnd.kind, 'resting');
  const aRest = (await kit.accounts('m1')).find((r) => r.id === a.id);
  assert.equal(aRest.state, 'resting');
  const bBefore = requests().length, eventB = [];
  const bEnd = await kit.run({ member: 'm1', sessionKey: 'agent:m1:exact-B', message: 'fixture B', account: b.id }, (event) => { if (event.type === 'account') eventB.push(event); });
  assert.equal(eventB[0].account, b.id);
  assert.equal(bEnd.ok, true);
  assert.equal(requests().at(-1).params.agentId, index()[b.id].agent);
  assert.equal(requests().length, bBefore + 1);
  const until = index()[a.id].until;
  await kit.stop(); kit = make(); await kit.start();
  assert.equal(index()[a.id].until, until);
  assert.equal((await kit.accounts('m1')).find((r) => r.id === a.id)?.state, 'resting');
  const relevant = fake.calls.filter((c) => c.method === 'byokit.accounts' && ['ready', 'list'].includes(c.params.action));
  assert.ok(relevant.some((c) => c.params.agentId === index()[a.id].agent));
  assert.ok(relevant.some((c) => c.params.agentId === index()[b.id].agent));
  assert.ok(!fake.calls.some((c) => c.method === 'byokit.accounts' && c.params.action === 'adopt'));
  note('limit isolation and restart', { aEnd: aEnd.kind, aAgent: index()[a.id].agent, aRoomLeft: roomA.left, bEvent: eventB[0].account, bAgent: index()[b.id].agent, bRoomLeft: roomB.left, restUntil: until, restoredState: (await kit.accounts('m1')).find((r) => r.id === a.id)?.state, logoutAgent: logout.params.agentId, requestCount: requests().length });

  writeFileSync(join(evidence, 'result.json'), JSON.stringify({ resolved, outputs }, null, 2));
  writeFileSync(join(evidence, 'steps.json'), JSON.stringify({
    target: { version: JSON.parse(readFileSync('packages/openclaw/package.json', 'utf8')).version },
    start: 'Two synthetic ChatGPT OAuth identities sign in through the loopback fake gateway into independent account agents.',
    steps: ['sign in A and B; inspect their distinct profile stores', 'exercise duplicate, busy, cancellation, wrong-principal re-auth and expired-store restart', 'make A probe unknown, revoke A only', 'hit A rate limit, run B explicitly, restart and inspect A rest'],
    result: 'A and B remain isolated; no account rotation or credential adoption; uncertainty, revocation and rest are scoped to the exact account.',
  }, null, 2));
  console.log('PASS two ChatGPT fixture accounts; no real sign-in, credential file, or provider network');
} finally { await kit.stop(); rmSync(stateDir, { recursive: true, force: true }); }
