#!/usr/bin/env node
// Public-entry proof: run({ thinking }) clamps unsupported levels from the registered catalog.
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenClawKit, words } from '@byokit/openclaw';
import { fakeGateway } from '@byokit/openclaw/testing';

const require = createRequire(import.meta.url);
const resolved = require.resolve('@byokit/openclaw');
if (!resolved.includes(`${join('packages', 'openclaw', 'dist')}`)) {
  throw new Error(`expected built package, got ${resolved}`);
}

const evidenceDir = process.argv[2];
if (!evidenceDir) throw new Error('usage: openclaw-thinking-clamp.mjs <evidence-dir>');
mkdirSync(evidenceDir, { recursive: true });

const stateDir = mkdtempSync(join(tmpdir(), 'byk-thinking-clamp-'));
const fake = fakeGateway();
const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false });
const results = [];

try {
  await kit.start();
  fake.refresh('m1', 'opencode-go');
  const muse = {
    id: 'muse-spark-1.3-contributor',
    name: 'Muse Spark',
    compat: { supportedReasoningEfforts: ['high', 'max'] },
  };
  const { hash } = await kit.call('config.get', {});
  await kit.call('config.patch', {
    baseHash: hash,
    raw: JSON.stringify({ models: { providers: { 'opencode-go': { models: [muse] } } } }),
  });

  const run = async (thinking, expectUsed, label) => {
    const before = fake.calls.length;
    const end = await kit.run({
      member: 'm1',
      sessionKey: `agent:m1:${label}`,
      message: 'hi',
      model: 'opencode-go/muse-spark-1.3-contributor',
      thinking,
    });
    if (!end.ok) throw new Error(`${label}: ${JSON.stringify(end)}`);
    if (JSON.stringify(end.thinking) !== JSON.stringify({ asked: thinking, used: expectUsed })) {
      throw new Error(`${label}: thinking ${JSON.stringify(end.thinking)}`);
    }
    const agent = fake.calls.slice(before).find((c) => c.method === 'agent');
    if (agent?.params?.thinking !== expectUsed) {
      throw new Error(`${label}: agent thinking ${JSON.stringify(agent?.params?.thinking)}`);
    }
    results.push({ label, thinking: end.thinking, agentThinking: agent.params.thinking });
  };

  await run('low', 'high', 'clamp-low');
  await run('high', 'high', 'supported');
  await run('off', 'off', 'off-stays');

  // No catalog levels: clear the provider list and ask low → pass through.
  const after = await kit.call('config.get', {});
  await kit.call('config.patch', {
    baseHash: after.hash,
    raw: JSON.stringify({ models: { providers: { 'opencode-go': { models: [{ id: 'muse-spark-1.3-contributor', name: 'Muse' }] } } } }),
  });
  await run('low', 'low', 'passthrough');

  const notice = words('run.thinkingClamped', { asked: 'low', used: 'high' });
  if (!notice.includes('high') || !notice.includes('low')) throw new Error(`notice: ${notice}`);
  results.push({ notice });

  writeFileSync(join(evidenceDir, 'result.json'), JSON.stringify({ resolved, results }, null, 2));
  console.log('resolved ->', resolved);
  console.log(JSON.stringify(results, null, 2));
  console.log('DRIVE OK');
} finally {
  await kit.stop();
  rmSync(stateDir, { recursive: true, force: true });
}
