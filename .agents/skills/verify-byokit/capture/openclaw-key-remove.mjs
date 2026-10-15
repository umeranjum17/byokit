// Removing a saved key through the built @byokit/openclaw: `removeKey` clears the member's `byokit-key-<member>` lane
// (credential store and ready marker) so it reads signed out and a restart does not revive it; `signOut` removes that
// provider's saved key through the same call, and a provider with no saved key is a no-op. Offline: the fake mirrors the
// shipped `byokit.keys` handler, including its `absent` reply for a lane that was never created.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { OpenClawKit } from '@byokit/openclaw';
import { fakeGateway } from '@byokit/openclaw/testing';

const stateDir = mkdtempSync('.verify-artifacts/key-remove-');
const fake = fakeGateway();
const key = 'byokit-stand-in-key-9931';
const make = () => new OpenClawKit({ stateDir, callbackPort: 0, spawnEngine: false, transport: fake.factory });
const lane = (member) => fake.transport.request('byokit.keys', { member, action: 'ready' });
let kit = make();
try {
  await kit.start();
  assert.deepEqual(await kit.addKey('m1', { authChoice: 'opencode-go', apiKey: key }), { status: 'ok' });
  const added = { lane: await lane('m1'), signedIn: await kit.signedIn('m1', 'opencode-go') };
  console.log('after addKey:', JSON.stringify(added));
  assert.equal(added.signedIn, true);
  assert.deepEqual((await kit.accounts('m1')).map((a) => a.id), ['opencode-go.key']);

  // removeKey: the sealed key and its ready marker go, so the member reads signed out.
  await kit.removeKey('m1');
  const removed = { lane: await lane('m1'), signedIn: await kit.signedIn('m1', 'opencode-go') };
  console.log('after removeKey:', JSON.stringify(removed));
  assert.deepEqual(removed.lane, { ok: false, absent: true });
  assert.equal(removed.signedIn, false);
  assert.deepEqual(await kit.accounts('m1'), []);
  console.log('accounts after removeKey: []');
  const runEnd = await kit.run({ member: 'm1', sessionKey: 'agent:m1:verify-remove', auth: 'apiKey', message: 'Hi' });
  console.log('key run after removeKey:', JSON.stringify(runEnd));
  assert.equal(runEnd.ok, false);

  // A restart does not revive it: a fresh kit on the same state reads the same signed-out lane.
  await kit.stop();
  kit = make();
  await kit.start();
  const restarted = { lane: await lane('m1'), signedIn: await kit.signedIn('m1', 'opencode-go') };
  console.log('after an engine restart:', JSON.stringify(restarted));
  assert.deepEqual(restarted, { lane: { ok: false, absent: true }, signedIn: false });

  // Nothing saved is a no-op, not an error.
  await kit.removeKey('m2');
  console.log('removeKey with no saved key: resolved');

  // signOut removes that provider's saved key and spares another provider's.
  assert.deepEqual(await kit.addKey('m1', { authChoice: 'opencode-go', apiKey: key }), { status: 'ok' });
  await kit.signOut('m1', 'openai');
  const spared = await kit.signedIn('m1', 'opencode-go');
  console.log("after signOut('openai'): signedIn('opencode-go'):", spared);
  assert.equal(spared, true, "another provider's sign-out leaves the saved key alone");
  assert.deepEqual((await kit.accounts('m1')).map((a) => a.id), ['opencode-go.key']);
  await kit.signOut('m1', 'opencode-go');
  const signedOut = { lane: await lane('m1'), signedIn: await kit.signedIn('m1', 'opencode-go') };
  console.log("after signOut('opencode-go'):", JSON.stringify(signedOut));
  assert.deepEqual(signedOut, { lane: { ok: false, absent: true }, signedIn: false });
  assert.deepEqual(await kit.accounts('m1'), []);
  console.log('accounts after signOut: []');

  // A refused control read is a typed refusal, and no key value reaches the calls.
  fake.handle('byokit.keys', () => { throw new Error('gateway restarting ENGINE-ECHO'); });
  await assert.rejects(() => kit.removeKey('m1'), /The key could not be removed\./);
  await assert.rejects(() => kit.signOut('m1', 'opencode-go'), /The key could not be removed\./);
  assert.equal(JSON.stringify(fake.calls).includes(key), false);
  console.log('refused removal: The key could not be removed.');
  console.log('KEY-REMOVE OK');
} finally {
  await kit.stop();
  rmSync(stateDir, { recursive: true, force: true });
}
