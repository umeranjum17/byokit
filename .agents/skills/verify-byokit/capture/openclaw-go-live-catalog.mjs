// The Go plan's live catalog through the built @byokit/openclaw: no model config in the app, yet `models()` lists every
// live Go model and a run answers on Muse (Responses API). Offline by default (fakeGateway); `--live` drives the real
// pinned engine with the key in env BYOKIT_GO_KEY (read once, printed only as a mask, scrubbed from every line).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenClawKit } from '@byokit/openclaw';
import { fakeGateway } from '@byokit/openclaw/testing';

const live = process.argv.includes('--live');
const key = live ? process.env.BYOKIT_GO_KEY ?? '' : 'byokit-go-stand-in-key-5571';
delete process.env.BYOKIT_GO_KEY;
if (!key) { console.error('no value read'); process.exit(1); }
const say = (...parts) => console.log(parts.join(' ').split(key).join('[key]'));
say('key:', key.length < 16 ? `(${key.length} chars, too short to mask)` : `${key.slice(0, 4)}...${key.slice(-4)} (${key.length} chars)`);
// Live: Muse; offline: the fake's live-only stand-in.
const MODEL = live ? 'opencode-go/muse-spark-1.3-contributor' : 'opencode-go/fake-live-model';

// The live engine home holds the sealed key: it lives in the OS temp dir, never in evidence, and is removed.
const stateDir = mkdtempSync(join(live ? tmpdir() : '.verify-artifacts', 'go-live-catalog-'));
const options = { stateDir, callbackPort: 0, ...(live && process.env.BYOKIT_TEST_ENGINE_DIR ? { engineDir: process.env.BYOKIT_TEST_ENGINE_DIR } : {}) };
const fake = live ? undefined : fakeGateway();
const make = () => new OpenClawKit(live ? options : { ...options, transport: fake.factory, spawnEngine: false });
const registered = async (kit) => (await kit.call('config.get', {})).config?.models?.providers?.['opencode-go']?.models ?? [];
let kit = make();
try {
  await kit.start();
  say('app model config: none; registered before a key:', (await registered(kit)).length);
  assert.equal((await registered(kit)).length, 0);

  // Live, the plan account (addAccount); offline, the fake simulates the key path only.
  let account;
  if (live) {
    const added = await kit.addAccount('m1', { authChoice: 'opencode-go' }, () => {});
    added.paste(key);
    const done = await added.done;
    say('addAccount:', done.view.state, done.id);
    assert.equal(done.view.state, 'done');
    account = done.id;
  } else say('addKey:', await kit.addKey('m1', { authChoice: 'opencode-go', apiKey: key }));
  const wanted = MODEL.slice('opencode-go/'.length);
  for (let i = 0; i < 90 && !(await registered(kit)).some((m) => m.id === wanted); i++) await delay(live ? 1000 : 20);
  const list = await registered(kit);
  const muse = list.find((m) => m.id === wanted);
  say('registered:', list.length, 'models;', JSON.stringify({ id: muse?.id, api: muse?.api, baseUrl: muse?.baseUrl }));
  assert.equal(muse?.api, 'openai-responses');
  if (live) {
    const listed = (await kit.models('m1', account)).find((m) => m.id === MODEL);
    say('kit.models:', JSON.stringify(listed));
    assert.equal(listed?.available, true);
  }

  const turn = async (label, spec, member = 'm1') => {
    let chunks = 0;
    const end = await kit.run({ member, sessionKey: `agent:${member}:verify-go-${label}`, message: 'In one short sentence, what is the capital of France?', ...spec },
      (e) => { if (e.type === 'text') chunks++; });
    say(`run (${label}):`, JSON.stringify(spec), `text events: ${chunks}`, 'end:', JSON.stringify(end));
    assert.ok(end.ok && chunks > 0, 'a streamed answer');
    if (live) assert.ok(end.usage?.total, 'with usage');
    return end;
  };
  await turn('model', { model: MODEL, ...(live ? {} : { auth: 'apiKey' }) });
  // The key path: a member with only a Go key reads signedIn and runs Muse on it (live: a second member).
  const keyMember = live ? 'm2' : 'm1';
  if (live) say('addKey:', await kit.addKey(keyMember, { authChoice: 'opencode-go', apiKey: key }));
  const signed = await kit.signedIn(keyMember, 'opencode-go');
  say('signedIn after addKey:', signed);
  assert.equal(signed, true);
  if (live) await turn('key', { model: MODEL, auth: 'apiKey' }, keyMember);
  if (!live) {
    const other = await kit.run({ member: 'm1', sessionKey: 'agent:m1:verify-go-other', auth: 'apiKey', model: 'openai/gpt-5.1', message: 'Hi' });
    say('key run on another provider:', JSON.stringify(other));
    assert.equal(other.ok, false);
  }

  // A fresh start finds the catalog unchanged and writes nothing.
  const patches = () => fake?.calls.filter((c) => c.method === 'config.patch').length;
  const before = live ? JSON.stringify(await registered(kit)) : patches();
  await kit.stop();
  kit = make();
  await kit.start();
  await delay(live ? 20_000 : 200);
  const after = live ? JSON.stringify(await registered(kit)) : patches();
  say('fresh start rewrote the catalog:', before !== after);
  assert.equal(after, before);
  say('GO-LIVE-CATALOG OK');
} finally {
  await kit.stop();
  rmSync(stateDir, { recursive: true, force: true });
}
