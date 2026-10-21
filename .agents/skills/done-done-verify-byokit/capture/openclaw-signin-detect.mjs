#!/usr/bin/env node
// Public-entry proof: the app's poll after a key sign-in costs one setup detection, and a model the live catalog
// offers (MiniMax Flash) stays listed and pickable on the key lane.
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenClawKit } from '@byokit/openclaw';
import { fakeGateway } from '@byokit/openclaw/testing';

const require = createRequire(import.meta.url);
const resolved = require.resolve('@byokit/openclaw');
if (!resolved.includes(`${join('packages', 'openclaw', 'dist')}`)) {
  throw new Error(`expected built package, got ${resolved}`);
}

const evidenceDir = process.argv[2];
if (!evidenceDir) throw new Error('usage: openclaw-signin-detect.mjs <evidence-dir>');
mkdirSync(evidenceDir, { recursive: true });

const stateDir = mkdtempSync(join(tmpdir(), 'byk-signin-detect-'));
const fake = fakeGateway();
let detects = 0;
fake.handle('openclaw.setup.detect', () => {
  detects++;
  return { candidates: [{ kind: 'claude-cli', credentials: false }] };
});
// The provider's live list: the vendor's own ids, joined to the engine's fixed catalog.
fake.handle('byokit.catalog', (p) => p.provider === 'minimax' && fake.calls.some((c) => c.method === 'openclaw.setup.activate')
  ? { ok: true, models: [
    { id: 'MiniMax-M3', name: 'MiniMax-M3', api: 'anthropic-messages', baseUrl: 'https://api.minimax.io/anthropic', input: ['text', 'image'], contextWindow: 1_000_000 },
    { id: 'MiniMax-M3.1-Flash', name: 'MiniMax-M3.1-Flash', api: 'anthropic-messages', baseUrl: 'https://api.minimax.io/anthropic', input: ['text', 'image'], contextWindow: 1_000_000 }] }
  : { ok: false, reason: 'no-key' });
const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false });
const results = [];

try {
  await kit.start();
  const add = await kit.addKey('m1', { authChoice: 'minimax-global-api', apiKey: 'CANARY-SIGNIN-DETECT-KEY-1' });
  if (add.status !== 'ok') throw new Error(`add: ${JSON.stringify(add)}`);
  const afterSignIn = detects;

  // The app's poll after the sign-in: the providers, the account list and the signed-in check, three rounds over.
  for (let round = 0; round < 3; round++) {
    await kit.providers('m1');
    await kit.accounts('m1');
    await kit.signedIn('m1', 'minimax');
  }
  const pollDetects = detects - afterSignIn;
  if (pollDetects !== 1) throw new Error(`the poll made ${pollDetects} detections, expected one`);
  results.push({ pollRounds: 3, detections: pollDetects });

  // The model the live catalog offers is listed on the key lane and pickable.
  const lane = (await kit.models('m1', 'minimax.key')).map((m) => m.id);
  if (!lane.includes('minimax/MiniMax-M3.1-Flash')) throw new Error(`the lane lists ${JSON.stringify(lane)}`);
  const pick = await kit.pick('m1', { account: 'minimax.key', model: 'minimax/MiniMax-M3.1-Flash' });
  if (!pick.ok) throw new Error(`the pick refused the chosen model: ${JSON.stringify(pick)}`);
  if (pick.model !== 'minimax/MiniMax-M3.1-Flash') throw new Error(`the pick chose ${pick.model}`);
  results.push({ lane, pick: pick.model });

  // A sign-out moves the answer: the next reader asks the engine again.
  await kit.removeKey('m1');
  const moved = detects;
  await kit.providers('m1');
  if (detects - moved !== 1) throw new Error(`an account change made ${detects - moved} detections, expected one`);
  results.push({ detectionsAfterAccountChange: detects - moved });

  writeFileSync(join(evidenceDir, 'result.json'), JSON.stringify({ resolved, results }, null, 2));
  // The step record of the journey: the steps a person (an app) takes and what they can see at the end.
  writeFileSync(join(evidenceDir, 'steps.json'), JSON.stringify({
    target: { version: '@byokit/openclaw 0.26.1' },
    start: 'The app has just signed in with a MiniMax API key: the engine holds the key and the provider\'s live catalog is registered.',
    steps: [
      'The app reads the member\'s providers after the sign-in (readiness)',
      'The app reads the member\'s account list',
      'The app checks whether the member is signed in to the key\'s provider',
      'The app lists the key lane\'s models and picks the model the picker offered',
    ],
    result: 'The reads after the sign-in cost one setup detection between them, and the key lane lists minimax/MiniMax-M3.1-Flash and the pick takes it.',
  }, null, 2));
  console.log('resolved ->', resolved);
  console.log(JSON.stringify(results, null, 2));
  console.log('DRIVE OK');
} finally {
  await kit.stop();
  rmSync(stateDir, { recursive: true, force: true });
}
