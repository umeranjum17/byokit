// WP8-S15 / O14o: the built host kit feeds the built UI rows through a one-line-per-member adapter.
// No cast or restated OpenClaw account: its published return types must fit AccountsSource at check time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OpenClawKit } from '@byokit/openclaw';
import { fakeGateway } from '@byokit/openclaw/testing';
import { accountRows, rowsOf } from '@byokit/ui/accounts';
import type { AccountsSource } from '../src/accounts.ts';
import { scratchDir } from '../../test-support.ts';

test('OpenClaw accounts fit UI rows without inventing an age, including bound and paid picks', async () => {
  const stateDir = scratchDir('accounts-fits');
  const fake = fakeGateway();
  const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0 });
  const source: AccountsSource = {
    accounts: () => kit.accounts('umer'),
    room: (a) => kit.room('umer', a.id),
  };
  // Picks are not a member of AccountsSource: keep the kit's wider refusal union, never UI's narrower Pick.
  const pick: typeof kit.pick = (...args) => kit.pick(...args);
  type Refusal = Extract<Awaited<ReturnType<typeof pick>>, { ok: false }>['code'];
  const refusalCodes = ['bound', 'paid'] as const satisfies readonly Refusal[];
  try {
    await kit.start();
    assert.deepEqual(await kit.signIn('umer', { authChoice: 'openai' }, () => {}).done, { state: 'done', via: 'browser' });
    await kit.renameAccount('umer', 'openai', 'Umer');
    const work = await kit.addAccount('umer', { authChoice: 'openai', name: 'Work' }, () => {});
    assert.equal((await work.done).view.state, 'done');
    const now = Date.now();
    const resetAt = now + 3_600_000;
    fake.setUsage('umer', 'openai', [{ label: 'weekly', usedPercent: 80, resetAt }]);
    // The gateway's first usage read is cold; it is not a fabricated zero-percent reading.
    const cold = await rowsOf(source, now);
    assert.deepEqual(cold.map((r) => r.detail), ['Room left unknown', 'Room left unknown']);
    const accounts = await source.accounts();
    const rooms = new Map(await Promise.all(accounts.map(async (a) => [a.id, await source.room(a)] as const)));
    assert.deepEqual(rooms.get('openai'), { left: 20, span: 'week', resetsAt: resetAt });
    assert.ok([...rooms.values()].every((r) => !('at' in r)), 'OpenClaw gives no reading time');
    const expected = [
      { id: 'openai', title: 'ChatGPT Login · Umer', detail: '20% left this week', state: 'ready', billing: 'subscription', low: true },
      { id: work.id, title: 'ChatGPT Login · Work', detail: 'Room left unknown', state: 'ready', billing: 'subscription', low: false },
    ];
    const rows = accountRows(accounts, (a) => rooms.get(a.id)!, now);
    assert.deepEqual(rows, expected);
    assert.deepEqual(await rowsOf(source, now), expected);
    assert.ok(rows.every((r) => !('asOf' in r)), 'no made-up age reaches a row');

    assert.equal((await kit.run({ member: 'umer', sessionKey: 'agent:umer:chat:work', account: work.id, message: 'hello' }, () => {})).ok, true);
    const bound = await pick('umer', { account: 'openai' }, { sessionKey: 'agent:umer:chat:work' });
    assert.ok(!bound.ok && bound.code === refusalCodes[0], JSON.stringify(bound));

    // A sealed API-key account on its own agent, using the gateway's public fixture controls.
    const keyAgent = 'umer--a0a0a0';
    await kit.call('agents.create', { name: keyAgent, workspace: join(stateDir, 'openclaw', 'workspaces', 'umer') });
    assert.equal((await kit.call('openclaw.setup.activate', { kind: 'api-key', agentId: keyAgent, authChoice: 'apiKey', apiKey: 'sk-accounts-fits' })).ok, true);
    const file = join(stateDir, 'openclaw', 'accounts', 'umer.json');
    const index = JSON.parse(readFileSync(file, 'utf8'));
    index.accounts['anthropic.a0a0a0'] = { agent: keyAgent, name: 'Key', route: 'apiKey', addedAt: now };
    writeFileSync(file, JSON.stringify(index)); chmodSync(file, 0o600);
    assert.equal((await kit.run({ member: 'umer', sessionKey: 'agent:umer:chat:key', account: 'anthropic.a0a0a0', message: 'hello' }, () => {})).ok, true);
    const paid = await pick('umer', { account: 'auto' }, { sessionKey: 'agent:umer:chat:key' });
    assert.ok(!paid.ok && paid.code === refusalCodes[1], JSON.stringify(paid));
    await kit.signOut('umer', 'openai');
    const signedOut = (await rowsOf(source, now)).find((r) => r.id === 'openai')!;
    assert.deepEqual(signedOut, { id: 'openai', title: 'ChatGPT Login · Umer', detail: 'Not signed in', state: 'signed_out', billing: 'subscription', low: false, action: 'sign_in' });
  } finally {
    await kit.stop();
  }
});
