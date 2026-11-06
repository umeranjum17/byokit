// The real pinned OpenClaw engine, started by the kit, on the journeys the 2026.11.1 pin changed: Claude Code model lists
// and runs (with tool-input progress), the memory tools, retired learning and lease contention. Deterministic stand-ins
// for the CLI and model; no real account, provider or credential.
import assert from 'node:assert/strict';
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const evidence = process.env.DONE_DONE_EVIDENCE_ROOT;
assert.ok(evidence, 'run through done-done');
const env = { ...process.env, PATH: `/usr/bin:${process.env.PATH}` };
const gates = process.argv.includes('--gates');
const run = (log, command) => {
  const fd = openSync(join(evidence, log), 'wx');
  try {
    const result = spawnSync('bash', ['-c', command], { stdio: ['ignore', fd, fd], env });
    assert.equal(result.status, 0, `${command} failed: ${result.error?.message ?? result.signal ?? result.status}; see ${log}`);
  } finally { closeSync(fd); }
};
const checks = "npm run build && npm run check && node scripts/readme-check.ts && npm run release -- lint --base origin/main && sh scripts/test.sh 'packages/openclaw/test/*.test.ts' packages/accounts/test/egress-guard.test.ts";
if (gates) run('checks.log', checks);
else run('build.log', 'npm run build');
const journeys = ['native-binding', 'models-list', 'run', 'learning', 'sqlite-contention'];
run('engine-journeys.log', `sh scripts/test.sh ${journeys.map(name => `packages/openclaw/test/engine/${name}.test.ts`).join(' ')}`);
const log = readFileSync(join(evidence, 'engine-journeys.log'), 'utf8');
assert.match(log, /^ℹ fail 0$/m);
assert.match(log, /✔ native accounts: each launch, reuse and probe uses its own folder/);
assert.match(log, /✔ a signed-in Claude Code login is a kit account, and its Claude CLI models are listed/);
const version = JSON.parse(readFileSync('packages/openclaw/engine/package.json', 'utf8')).dependencies.openclaw;
const lines = [
  `Command: node .agents/skills/done-done-verify-byokit/capture/openclaw-engine-pin.mjs${gates ? ' --gates' : ''}`,
  ...(gates ? [`PASS: ${checks}`] : []),
  `PASS: the kit started the real pinned engine ${version} and ran ${journeys.join(', ')}`,
  'PASS: a Claude Code account lists claude-cli models, runs in its own folder, and a file-writing tool call streamed input_delta progress',
];
writeFileSync(join(evidence, 'summary.txt'), lines.join('\n') + '\n');
writeFileSync(join(evidence, 'steps.json'), JSON.stringify({ target: { engine: version }, journeys }, null, 2) + '\n');
for (const line of lines) console.log(line);
