// An OpenCode Go plan key through the built @byokit/openclaw. Offline by default (fakeGateway); `--live` drives the
// real pinned engine with the key in env BYOKIT_GO_KEY (read once, printed only as a mask, scrubbed from every line).
// With BYOKIT_GO_ORG set, the live leg proves the workspace lane instead: addKey stores the org id and the probe and
// first chat carry x-opencode-org-id (the wizard path is skipped: it probes headerless and a multi-workspace login
// is refused there). The org id is read once, never printed, and scrubbed like the key.
// With BYOKIT_GO_PICK (a workspace name) set instead, the live leg proves addKey's own listing: an add with no orgId
// lists the key's workspaces (one is used unasked, several come back as needs_workspace), the named one is picked
// and added, and the first chat runs. Workspace names print; their ids are scrubbed like the key. Offline, the same
// legs (one, several, refused, unread) run against a console listing answered in this process.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenClawKit } from '@byokit/openclaw';
import { fakeGateway } from '@byokit/openclaw/testing';

const live = process.argv.includes('--live');
const key = live ? process.env.BYOKIT_GO_KEY ?? '' : 'byokit-go-stand-in-key-5571';
const org = live ? process.env.BYOKIT_GO_ORG ?? '' : '';
const pick = live ? process.env.BYOKIT_GO_PICK ?? '' : '';
delete process.env.BYOKIT_GO_KEY;
delete process.env.BYOKIT_GO_ORG;
delete process.env.BYOKIT_GO_PICK;
if (!key) { console.error('no value read'); process.exit(1); }
const ids = org ? [org] : [];
const scrub = (text) => ids.reduce((t, id) => t.split(id).join('[org]'), text).split(key).join('[key]');
const say = (...parts) => console.log(scrub(parts.join(' ')));
if (org) say('org: present, not printed');
say('key:', key.length < 16 ? `(${key.length} chars, too short to mask)` : `${key.slice(0, 4)}...${key.slice(-4)} (${key.length} chars)`);

// Offline, the console's org listing is answered in this process (the stand-in key is no login: 401), so the drive
// never leaves the machine; every other address passes through.
let answer = () => new Response('', { status: 401 });
if (!live) {
  const real = globalThis.fetch;
  globalThis.fetch = (input, init) => String(input instanceof Request ? input.url : input) === 'https://opencode.ai/console/api/orgs'
    ? Promise.resolve().then(answer) : real(input, init);
}

// The live engine home holds the sealed key: it lives in the OS temp dir, never in evidence, and is removed.
const stateDir = mkdtempSync(join(live ? tmpdir() : '.verify-artifacts', 'go-plan-key-'));
const kit = live
  ? new OpenClawKit({ stateDir, callbackPort: 0, ...(process.env.BYOKIT_TEST_ENGINE_DIR ? { engineDir: process.env.BYOKIT_TEST_ENGINE_DIR } : {}) })
  : new OpenClawKit({ stateDir, transport: fakeGateway().factory, spawnEngine: false, callbackPort: 0 });
try {
  await kit.start();
  const route = (choice) => kit.routes().find((r) => r.choice === choice);
  say('discovery:', JSON.stringify(['opencode-go', 'fal-api-key'].map((c) => [c, route(c)?.readiness, route(c)?.offer])));
  assert.equal(route('opencode-go')?.readiness, 'ready');
  assert.equal(route('fal-api-key')?.readiness, 'no_upstream_flow');

  const views = [];
  const turn = async (label, spec) => {
    let chunks = 0;
    say(`run (${label}):`, JSON.stringify(spec));
    const end = await kit.run({ sessionKey: `agent:${spec.member}:verify-go-${label}`, message: 'In one short sentence, what is the capital of France?', ...spec },
      (e) => { if (e.type === 'text') { chunks++; say('stream:', JSON.stringify(e.text)); } });
    say('end:', JSON.stringify(end));
    assert.ok(end.ok && chunks > 0 && end.usage?.total, 'a streamed answer with usage');
    assert.ok(!JSON.stringify([views, end]).includes(key), 'the key is never in a view or result');
  };
  // An add with no orgId: the kit lists the key's workspaces; several come back for the pick, names only printed.
  const addListed = async (member, choose) => {
    const first = await kit.addKey(member, { authChoice: 'opencode-go', apiKey: key });
    for (const w of first.workspaces ?? []) ids.push(w.id);
    say('addKey (no orgId):', JSON.stringify(first.status === 'needs_workspace'
      ? { status: first.status, workspaces: first.workspaces.map((w) => w.name) } : first));
    if (first.status !== 'needs_workspace') return first;
    const chosen = first.workspaces.find((w) => w.name === choose);
    assert.ok(chosen, `a workspace named ${choose}`);
    const second = await kit.addKey(member, { authChoice: 'opencode-go', apiKey: key, orgId: chosen.id });
    say(`addKey (orgId of ${choose}):`, JSON.stringify(second));
    return second;
  };
  if (pick) {
    assert.deepEqual(await addListed('m2', pick), { status: 'ok' });
    await turn('key', { member: 'm2', auth: 'apiKey' });
    say('GO-PLAN-KEY OK');
  } else if (org) {
    // The workspace lane: the stored org id rides the activation probe and every run. The wizard path is not
    // part of this proof: it probes without the header, so a multi-workspace login is refused there by design.
    const keyed = await kit.addKey('m2', { authChoice: 'opencode-go', apiKey: key, orgId: org });
    say('addKey:', JSON.stringify(keyed));
    assert.deepEqual(keyed, { status: 'ok' });
    await turn('key', { member: 'm2', auth: 'apiKey' });
    say('GO-PLAN-KEY OK');
  } else {
  const added = await kit.addAccount('m1', { authChoice: 'opencode-go' }, (v) => { views.push(v); say('view:', JSON.stringify(v)); });
  added.paste(key);
  const done = await added.done;
  say('done:', JSON.stringify(done));
  assert.equal(done.view.state, 'done');
  say('accounts:', JSON.stringify((await kit.accounts('m1')).map((a) => [a.id, a.provider, a.billing, a.state])));

  // Straight after done, no model named: the member's new plan answers on its saved model.
  await turn('saved', { member: 'm1', ...(live ? {} : { model: 'opencode-go/fake-key-model' }) });

  // Error case (before addKey, whose activation restarts the gateway): a choice the engine cannot set up is refused with the engine's words.
  const refused = await kit.signIn('m1', { authChoice: 'fal-api-key' }, () => {});
  refused.paste('byokit-probe-not-a-key');
  const failed = await refused.done;
  say('refused:', JSON.stringify(failed));
  assert.equal(failed.error, 'This key type is not available on this engine.');

  // The key path: addKey sets the plan key up on another member's key agent; `auth: 'apiKey'` runs on its saved model.
  const keyed = await kit.addKey('m2', { authChoice: 'opencode-go', apiKey: key });
  say('addKey:', JSON.stringify(keyed));
  assert.deepEqual(keyed, { status: 'ok' });
  await turn('key', { member: 'm2', auth: 'apiKey' });

  if (!live) {
    // The listing legs, against the in-drive console listing.
    {
      answer = () => Response.json([{ id: 'org_stand_in_a', name: 'Umer' }, { id: 'org_stand_in_b', name: 'Umer at work' }]);
      assert.deepEqual(await addListed('m3', 'Umer at work'), { status: 'ok' });
      answer = () => Response.json([{ id: 'org_stand_in_c', name: 'Umer' }]);
      assert.deepEqual(await addListed('m3'), { status: 'ok' });
      answer = () => new Response('', { status: 401 });
      assert.deepEqual(await addListed('m3'), { status: 'ok' });
      answer = () => new Response('down', { status: 502 });
      assert.deepEqual(await addListed('m3'), { status: 'retry', reason: 'network' });
    }
  }

  say('GO-PLAN-KEY OK');
  }
} finally {
  await kit.stop();
  // The installed engine tree is read-only (npm), so make it writable before removing the state dir.
  execFileSync('chmod', ['-R', 'u+w', stateDir]);
  rmSync(stateDir, { recursive: true, force: true });
}
