// K4 structured readiness: a sign-in check that gives no answer is unknown, never signed out, and it never leaks to a
// sibling account. Pass: a slow Claude Code probe leaves it unknown and ChatGPT ready; a real revocation signs out that
// account only; an unreadable answer is not kept; a run on an unchecked account ends retryable with no agent request and
// tries no other account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { scratchDir } from '../../test-support.ts';
import { OpenClawKit } from '../src/kit.ts';
import { fakeGateway } from '../src/testing/fake-gateway.ts';

test('an unchecked account is unknown, a revoked one signed out, each alone, and neither authorises a stale run', async () => {
  const stateDir = scratchDir('k4');
  const fake = fakeGateway();
  const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false });
  const claude = (credentials?: boolean) => fake.handle('openclaw.setup.detect', () => ({ candidates: [{ kind: 'claude-cli', ...(credentials === undefined ? {} : { credentials }) }] }));
  const agentRequests = () => fake.calls.filter((c) => c.method === 'agent').length;
  try {
    await kit.start();
    assert.deepEqual(await (kit.signIn('m1', { authChoice: 'openai' }, () => {})).done, { state: 'done', via: 'browser' });
    claude(true);
    const states = async () => Object.fromEntries((await kit.accounts('m1')).map((a) => [a.id, a.state]));
    assert.deepEqual(await states(), { 'claude-cli': 'ready', openai: 'ready' });

    // A slow probe on A: A is unknown with a safe reason and a retry delay, B is still ready, and neither is signed out.
    fake.handle('openclaw.setup.detect', () => { throw new Error('claude auth status timed out'); });
    const slow = await kit.accountStatus('m1', 'claude-cli', { fresh: true });
    assert.deepEqual([slow.state, slow.reason, typeof slow.retryAfterMs, typeof slow.checkedAt], ['unknown', 'timeout', 'number', 'number']);
    assert.equal((await kit.accountStatus('m1', 'openai')).state, 'ready');
    assert.deepEqual(await states(), { 'claude-cli': 'unknown', openai: 'ready' });

    // Not sticky: the answer comes back and the very next read sees it. An answer that says nothing is unreadable, and
    // is not kept either.
    claude(undefined);
    const unreadable = await kit.accountStatus('m1', 'claude-cli', { fresh: true });
    assert.deepEqual([unreadable.state, unreadable.reason], ['unknown', 'unreadable']);
    claude(true);
    assert.equal((await kit.accountStatus('m1', 'claude-cli')).state, 'ready');

    // Real revocation: A is signed out, B is untouched.
    claude(false);
    assert.equal((await kit.accountStatus('m1', 'claude-cli', { fresh: true })).state, 'signed_out');
    assert.deepEqual(await states(), { 'claude-cli': 'signed_out', openai: 'ready' });

    // A profile read that fails says nothing about the sign-in: the account is unknown, and a run on it is a retryable
    // probe failure with no agent request and no other account tried.
    claude(true);
    fake.handle('byokit.accounts', (p) => { if (p.action === 'list') throw new Error('gateway reply lost'); return { ok: false }; });
    const before = agentRequests();
    const end = await kit.run({ member: 'm1', sessionKey: 'agent:m1:chat:k4', message: 'Hello', account: 'openai' });
    assert.deepEqual(end, { ok: false, kind: 'network', message: `I couldn't check ${(await kit.accounts('m1')).find((a) => a.id === 'openai')!.name} yet`, retryAfterMs: 5_000 });
    assert.equal(agentRequests(), before, 'no run was admitted');
  } finally { await kit.stop(); rmSync(stateDir, { recursive: true, force: true }); }
});
