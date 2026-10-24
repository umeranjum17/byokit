#!/usr/bin/env node
// Public-entry proof: a Claude Code sign-in check that is slower than the engine's 3 s limit reads unknown (never signed
// out) after a retry past the engine's 10 s window, a probe that recovers reads signed in, and a probe that answers
// signed out still reads signed out.
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenClawKit } from '@byokit/openclaw';
import { fakeGateway } from '@byokit/openclaw/testing';

const require = createRequire(import.meta.url);
const resolved = require.resolve('@byokit/openclaw');
if (!resolved.includes(`${join('packages', 'openclaw', 'dist')}`)) {
  throw new Error(`expected built package, got ${resolved}`);
}

const evidenceDir = process.argv[2];
if (!evidenceDir) throw new Error('usage: openclaw-slow-probe-unknown.mjs <evidence-dir>');
mkdirSync(evidenceDir, { recursive: true });

// The kit binds a Unix socket under its state dir, whose path limit a long run scratch path exceeds: keep it short.
const base = tmpdir().length > 32 ? '/tmp' : tmpdir();
const results = [];
const drive = async (name, probe) => {
  const stateDir = mkdtempSync(join(base, 'bsp-'));
  const fake = fakeGateway();
  let probes = 0;
  fake.handle('openclaw.setup.detect', async () => {
    if (probe === 'out') return { candidates: [{ kind: 'claude-cli', credentials: false }] };
    probes++;
    if (probe === 'recovers' && probes > 2) return { candidates: [{ kind: 'claude-cli', credentials: true }] };
    await delay(3_500); // past the engine's hard 3 s limit: the engine answers with an error
    throw new Error('claude auth status timed out');
  });
  const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false });
  try {
    await kit.start();
    const started = Date.now();
    const state = await kit.signInState('umer', 'claude-cli');
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    const run = await kit.run({ member: 'umer', sessionKey: 'agent:umer:chat', message: 'Hello', model: 'claude-cli/claude-sonnet-5' });
    const end = run.ok ? 'ok' : 'kind' in run ? run.kind : 'aborted';
    results.push({ name, state, run: end, probes, seconds, providerStatus: await kit.providerStatus('umer') ?? null });
    return { state, end, seconds, probes };
  } finally {
    await kit.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
};

const slow = await drive('slow probe', 'slow');
if (slow.state !== 'unknown' || slow.end === 'signed-out') throw new Error(`a slow probe read ${JSON.stringify(slow)}`);
if (slow.seconds < 10) throw new Error(`the probe was retried for only ${slow.seconds} s, inside the engine's 10 s window`);
const recovers = await drive('slow twice, then signed in', 'recovers');
if (recovers.state !== 'signed-in' || recovers.end !== 'ok') throw new Error(`a recovering probe read ${JSON.stringify(recovers)}`);
const out = await drive('signed out', 'out');
if (out.state !== 'signed-out' || out.end !== 'signed-out') throw new Error(`a signed-out probe read ${JSON.stringify(out)}`);

writeFileSync(join(evidenceDir, 'result.json'), JSON.stringify({ resolved, results }, null, 2));
writeFileSync(join(evidenceDir, 'steps.json'), JSON.stringify({
  target: { version: '@byokit/openclaw' },
  start: 'The app has a member whose Claude Code login is checked by the engine\'s probe, with a 3 s limit.',
  steps: [
    'The app asks signInState while the probe takes 3.5 s and errors every time',
    'The app asks signInState while the probe errors twice and then answers signed in',
    'The app asks signInState while the probe answers signed out',
    'Each time the app starts a Claude Code run for the member',
  ],
  result: 'The always-slow probe reads unknown after a retry past 10 s and the run ends network; the recovering probe reads signed-in and the run is ok; the signed-out probe reads signed-out and the run ends signed-out.',
}, null, 2));
console.log('resolved ->', resolved);
console.log(JSON.stringify(results, null, 2));
console.log('DRIVE OK');
