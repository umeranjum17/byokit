// BK-P2 (docs/capability-kits.md 8): the kit and the real engine write nothing and dial nothing. A child Node runs
// every verb through inProcessEngine() under the permission model with reads only (a write throws ERR_ACCESS_DENIED);
// the egress guard from scripts/test.sh rides along in NODE_OPTIONS and fails any outbound dial.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { engineDir } from './engine.ts';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const kit = new URL('../../src/index.ts', import.meta.url).href;

const script = `
import { writeFileSync } from 'node:fs';
const { Compose, inProcessEngine } = await import(${JSON.stringify(kit)});
try { writeFileSync(${JSON.stringify(`${repo}compose-isolation-canary`)}, 'x'); throw new Error('a write went through'); }
catch (e) { if (e.code !== 'ERR_ACCESS_DENIED') throw e; }
const c = new Compose({ engine: inProcessEngine() });
const rules = { never: ['delve'], noDashes: true, statementEndings: true, note: 'short' };
await c.hello();
await c.platforms();
await c.voice.parse('## Never say\\n- delve\\n');
await c.voice.guide(rules, { post: true });
for (const kind of ['reply', 'polish', 'post', 'thread']) await c.brief({ kind, platform: 'x', rules });
await c.check({ drafts: ['Meet at 3pm, 50 seats.'], platform: 'x', rules, original: 'Meet at 3pm, 40 seats.' });
await c.split({ text: 'One. Two. Three.', platform: 'x' });
console.log('isolated: every verb answered');
`;

test('every verb runs in process with fs reads only and no egress', () => {
  const run = spawnSync(process.execPath, [
    '--permission', `--allow-fs-read=${repo}`, `--allow-fs-read=${engineDir}`, '--input-type=module', '-e', script,
  ], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /isolated: every verb answered/);
});
