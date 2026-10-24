#!/usr/bin/env node
// Public-entry proof (K4): two accounts of one member, Claude Code (A) and ChatGPT (B), read through accountStatus. A slow
// probe on A reads unknown (A and B both stay not signed out), a real revocation of A signs out A only, an unknown answer
// is not kept, and a run on an account that could not be checked ends retryable without trying any other account.
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenClawKit } from '@byokit/openclaw';
import { fakeGateway } from '@byokit/openclaw/testing';

const require = createRequire(import.meta.url);
const resolved = require.resolve('@byokit/openclaw');
if (!resolved.includes(`${join('packages', 'openclaw', 'dist')}`)) throw new Error(`expected built package, got ${resolved}`);

const evidenceDir = process.argv[2];
if (!evidenceDir) throw new Error('usage: openclaw-account-status.mjs <evidence-dir>');
mkdirSync(evidenceDir, { recursive: true });

// The kit binds a Unix socket under its state dir, whose path limit a long run scratch path exceeds: keep it short.
const stateDir = mkdtempSync(join(tmpdir().length > 32 ? '/tmp' : tmpdir(), 'bas-'));
const fake = fakeGateway();
const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false });
const claude = (credentials) => fake.handle('openclaw.setup.detect', () => ({ candidates: [{ kind: 'claude-cli', ...(credentials === undefined ? {} : { credentials }) }] }));
const expect = (what, actual, wanted) => {
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`${what}: ${JSON.stringify(actual)}, wanted ${JSON.stringify(wanted)}`);
};
const steps = [];
const note = (name, value) => { steps.push({ name, value }); console.log(name, JSON.stringify(value)); };
try {
  await kit.start();
  await kit.signIn('m1', { authChoice: 'openai' }, () => {}).done;
  claude(true);
  const rows = async () => Object.fromEntries((await kit.accounts('m1')).map((a) => [a.id, a.state]));
  expect('both signed in', await rows(), { 'claude-cli': 'ready', openai: 'ready' });

  fake.handle('openclaw.setup.detect', () => { throw new Error('claude auth status timed out'); });
  const slow = await kit.accountStatus('m1', 'claude-cli', { fresh: true });
  note('slow probe on A', { a: { state: slow.state, reason: slow.reason, retryAfterMs: slow.retryAfterMs }, b: (await kit.accountStatus('m1', 'openai')).state, rows: await rows() });
  expect('slow probe', [slow.state, slow.reason, await rows()], ['unknown', 'timeout', { 'claude-cli': 'unknown', openai: 'ready' }]);

  claude(undefined);
  const unreadable = await kit.accountStatus('m1', 'claude-cli', { fresh: true });
  claude(true);
  const back = await kit.accountStatus('m1', 'claude-cli');
  note('unreadable answer, then a real one', { unreadable: unreadable.reason, next: back.state });
  expect('not sticky', [unreadable.state, unreadable.reason, back.state], ['unknown', 'unreadable', 'ready']);

  claude(false);
  const revoked = await kit.accountStatus('m1', 'claude-cli', { fresh: true });
  note('A revoked', { a: revoked.state, rows: await rows() });
  expect('revocation', [revoked.state, await rows()], ['signed_out', { 'claude-cli': 'signed_out', openai: 'ready' }]);

  claude(true);
  fake.handle('byokit.accounts', (p) => { if (p.action === 'list') throw new Error('gateway reply lost'); return { ok: false }; });
  const before = fake.calls.filter((c) => c.method === 'agent').length;
  const end = await kit.run({ member: 'm1', sessionKey: 'agent:m1:chat', message: 'Hello', account: 'openai' });
  const agentRequests = fake.calls.filter((c) => c.method === 'agent').length - before;
  note('run on an account that could not be checked', { end, agentRequests });
  if (end.ok || end.kind !== 'network' || !/^I couldn't check .* yet$/.test(end.message) || agentRequests !== 0) throw new Error(`run read ${JSON.stringify(end)}`);

  writeFileSync(join(evidenceDir, 'result.json'), JSON.stringify({ resolved, steps }, null, 2));
  writeFileSync(join(evidenceDir, 'steps.json'), JSON.stringify({
    target: { version: '@byokit/openclaw' },
    start: 'The app has one member with two accounts: Claude Code (A) and ChatGPT (B).',
    steps: [
      'The app reads A while its probe times out',
      'The app reads A while the probe answers with nothing readable, then with a real answer',
      'The app reads A after Claude Code reports it is not logged in',
      'The app starts a run on B while B\'s profile read fails',
    ],
    result: 'A reads unknown (timeout) while B stays ready; the unreadable answer is not kept; the revoked A reads signed out while B stays ready; the run ends network with "I couldn\'t check ... yet" and no run was admitted.',
  }, null, 2));
  console.log('resolved ->', resolved);
  console.log('DRIVE OK');
} finally {
  await kit.stop();
  rmSync(stateDir, { recursive: true, force: true });
}
