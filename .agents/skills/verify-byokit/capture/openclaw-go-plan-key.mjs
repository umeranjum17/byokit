// An OpenCode Go plan key through the built @byokit/openclaw. Offline by default (fakeGateway); `--live` drives the
// real pinned engine with the key in env BYOKIT_GO_KEY (read once, printed only as a mask, scrubbed from every line).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenClawKit } from '@byokit/openclaw';
import { fakeGateway } from '@byokit/openclaw/testing';

const live = process.argv.includes('--live');
const key = live ? process.env.BYOKIT_GO_KEY ?? '' : 'byokit-go-stand-in-key-5571';
delete process.env.BYOKIT_GO_KEY;
if (!key) { console.error('no value read'); process.exit(1); }
const say = (...parts) => console.log(parts.join(' ').split(key).join('[key]'));
say('key:', key.length < 16 ? `(${key.length} chars, too short to mask)` : `${key.slice(0, 4)}...${key.slice(-4)} (${key.length} chars)`);

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
  const added = await kit.addAccount('m1', { authChoice: 'opencode-go' }, (v) => { views.push(v); say('view:', JSON.stringify(v)); });
  added.paste(key);
  const done = await added.done;
  say('done:', JSON.stringify(done));
  assert.equal(done.view.state, 'done');
  say('accounts:', JSON.stringify((await kit.accounts('m1')).map((a) => [a.id, a.provider, a.billing, a.state])));

  // Straight after done, no model named: the member's new plan answers on its saved model.
  const turn = async (label, spec) => {
    let chunks = 0;
    say(`run (${label}):`, JSON.stringify(spec));
    const end = await kit.run({ sessionKey: `agent:${spec.member}:verify-go-${label}`, message: 'In one short sentence, what is the capital of France?', ...spec },
      (e) => { if (e.type === 'text') { chunks++; say('stream:', JSON.stringify(e.text)); } });
    say('end:', JSON.stringify(end));
    assert.ok(end.ok && chunks > 0 && end.usage?.total, 'a streamed answer with usage');
    assert.ok(!JSON.stringify([views, done, end]).includes(key), 'the key is never in a view or result');
  };
  await turn('saved', { member: 'm1', ...(live ? {} : { model: 'opencode-go/fake-key-model' }) });

  // Error case (before addKey, whose activation restarts the gateway): a choice the engine cannot set up is refused with the engine's words.
  const refused = await kit.signIn('m1', { authChoice: 'fal-api-key' }, () => {});
  refused.paste('byokit-probe-not-a-key');
  const failed = await refused.done;
  say('refused:', JSON.stringify(failed));
  assert.match(failed.error ?? '', /not available on this Gateway/);

  // The key path: addKey sets the plan key up on another member's key agent; `auth: 'apiKey'` runs on its saved model.
  const keyed = await kit.addKey('m2', { authChoice: 'opencode-go', apiKey: key });
  say('addKey:', keyed);
  assert.equal(keyed, 'ok');
  await turn('key', { member: 'm2', auth: 'apiKey' });

  say('GO-PLAN-KEY OK');
} finally {
  await kit.stop();
  rmSync(stateDir, { recursive: true, force: true });
}
