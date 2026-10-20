import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OpenClawKit } from '@byokit/openclaw';
import { fakeGateway } from '@byokit/openclaw/testing';

const stateDir = mkdtempSync('.verify-artifacts/remove-account-');
const root = join(stateDir, 'openclaw');
const index = () => JSON.parse(readFileSync(join(root, 'accounts', 'm1.json'), 'utf8')).accounts;
const fake = fakeGateway();
const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0 });
try {
  await kit.start();
  await kit.signIn('m1', { authChoice: 'openai' }, () => {}).done;
  const second = await kit.addAccount('m1', { authChoice: 'openai', via: 'browser' }, () => {});
  const done = await second.done;
  assert.equal(done.view.state, 'done');
  const agent = `m1--${second.id.slice('openai.'.length)}`;
  console.log('accounts:', JSON.stringify((await kit.accounts('m1')).map((a) => [a.id, a.state])));

  // Busy leg: a live run holds the agent, so removal is refused and the member stays ready.
  fake.setUsage('m1', 'openai', [{ label: 'session', usedPercent: 80 }]);
  fake.setUsage(agent, 'openai', [{ label: 'session', usedPercent: 10 }]);
  for (const id of ['openai', second.id]) await kit.room('m1', id);
  const pending = kit.run({ member: 'm1', sessionKey: 'agent:m1:verify-remove', message: 'hello', account: second.id });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await assert.rejects(kit.removeAccount('m1', second.id), /busy/);
  console.log('busy refusal: removeAccount rejects while the run is live');
  assert.ok((await pending).ok, 'the live run finishes');
  assert.equal((await kit.accounts('m1')).find((a) => a.id === 'openai')?.state, 'ready', 'the member stays ready');

  // Removal leg: clear, empty list, delete with deleteFiles:false, state dir gone, entry gone.
  const deletesBefore = fake.calls.filter((c) => c.method === 'agents.delete').length;
  await kit.removeAccount('m1', second.id);
  const deletes = fake.calls.filter((c) => c.method === 'agents.delete').slice(deletesBefore);
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].params.deleteFiles, false);
  assert.ok(!(await kit.call('agents.list', {})).agents.some((a) => a.id === agent), 'the agent is gone');
  assert.ok(!(second.id in index()), 'and its entry');
  assert.ok(!existsSync(join(root, 'state', 'agents', agent)), 'and its state dir');
  console.log('account agent removed: roster, index and state dir agree');

  // Orphan leg: a file landed after removal is swept on the next prepare.
  const late = join(root, 'state', 'agents', agent, 'agent', 'late.json');
  mkdirSync(join(late, '..'), { recursive: true });
  writeFileSync(late, '{}');
  await kit.prepare();
  assert.ok(!existsSync(join(root, 'state', 'agents', agent)), 'the late file is swept on prepare');
  console.log('late file swept on prepare: true');

  // Keep a second member-agent account so prepare can prove it survives a late openai write-back.
  const go = await kit.addAccount('m1', { authChoice: 'opencode-go' }, () => {});
  go.paste('CANARY-GO-MEMBER-LATE-REFRESH');
  assert.equal((await go.done).view.state, 'done');

  // Member leg: authLogout, restore priorModel primary, drop entry.
  const modelOf = async () => {
    const got = await kit.call('config.get', {});
    return got?.config?.agents?.entries?.m1?.model;
  };
  const memberIndex = JSON.parse(readFileSync(join(root, 'accounts', 'm1.json'), 'utf8'));
  memberIndex.accounts.openai.priorModel = 'openai/before-sign-in';
  writeFileSync(join(root, 'accounts', 'm1.json'), JSON.stringify(memberIndex, null, 2) + '\n');
  // Ensure the live pin matches what addAccount would leave, then remove restores priorModel.
  await kit.call('config.patch', {
    raw: JSON.stringify({ agents: { ownership: 'explicit', entries: { m1: { model: 'openai/default@openai:default' } } } }),
    baseHash: (await kit.call('config.get', {})).hash,
  });
  assert.match(String(await modelOf()), /@openai:default/, 'member is still pinned before remove');
  const authBefore = fake.calls.filter((c) => c.method === 'models.authLogout').length;
  await kit.removeAccount('m1', 'openai');
  const auth = fake.calls.filter((c) => c.method === 'models.authLogout').slice(authBefore);
  assert.equal(auth.length, 1);
  assert.equal(auth[0].params.provider, 'openai');
  assert.equal(auth[0].params.agentId, 'm1');
  assert.ok(Array.isArray(auth[0].params.profileIds) && auth[0].params.profileIds.length > 0, 'with its sealed profile');
  assert.ok(!('openai' in index()), 'the member entry is dropped');
  assert.equal(await modelOf(), 'openai/before-sign-in', 'member primary restored from priorModel');
  assert.ok('opencode-go' in index(), 'the other member account stays');
  console.log('member account removed through authLogout with profileIds: true');
  console.log('member primary restored: true');

  // Late member-store refresh: write openai back into the member agent store; prepare must drop it.
  const memberStore = join(root, 'state', 'agents', 'm1', 'agent', 'auth-profiles.json');
  mkdirSync(join(memberStore, '..'), { recursive: true });
  writeFileSync(memberStore, JSON.stringify({
    version: 1,
    profiles: {
      'openai:default': { type: 'oauth', provider: 'openai', access: 'late-access', refresh: 'late-refresh' },
      'opencode-go:default': { type: 'api_key', provider: 'opencode-go', key: 'kept-on-member' },
    },
    order: { openai: ['openai:default'], 'opencode-go': ['opencode-go:default'] },
  }));
  await kit.prepare();
  const swept = JSON.parse(readFileSync(memberStore, 'utf8'));
  assert.equal(swept.profiles['openai:default'], undefined, 'late member refresh gone');
  assert.equal(swept.profiles['opencode-go:default']?.provider, 'opencode-go', 'remaining member profile stays');
  assert.ok(!('openai' in index()), 'removed account stays out of the index');
  assert.ok('opencode-go' in index(), 'remaining account intact');
  console.log('late member-store refresh swept on prepare: true');
  console.log('REMOVE-ACCOUNT OK');
} finally {
  await kit.stop();
  rmSync(stateDir, { recursive: true, force: true });
}
