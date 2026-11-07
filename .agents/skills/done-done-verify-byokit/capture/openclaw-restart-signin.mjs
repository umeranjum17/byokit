// A preserved sign-in across a real Gateway restart on a busy host, then the same gap held open on demand. Six copies on
// four cores open the gap on some runs; the fake Gateway journey opens it every time. No real account or provider.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const evidence = process.env.DONE_DONE_EVIDENCE_ROOT;
assert.ok(evidence, 'run through done-done');
const env = { ...process.env, PATH: `/usr/bin:${process.env.PATH}` };
const pinned = spawnSync('taskset', ['--version']).status === 0 ? ['taskset', '-c', '0-3'] : [];
const COPIES = 6;
const copy = (n) => new Promise((resolve) => {
  const fd = openSync(join(evidence, `restart-${n}.log`), 'wx');
  const [bin, ...args] = [...pinned, 'sh', 'scripts/test.sh', '--test-name-pattern=sealed preserved', 'packages/openclaw/test/engine/migrate.test.ts'];
  spawn(bin, args, { stdio: ['ignore', fd, fd], env }).once('exit', (code) => { closeSync(fd); resolve(code); });
});
const codes = await Promise.all(Array.from({ length: COPIES }, (_, i) => copy(i + 1)));
assert.deepEqual(codes, codes.map(() => 0), `every restart copy passes: ${codes}`);
for (let n = 1; n <= COPIES; n++)
  assert.match(readFileSync(join(evidence, `restart-${n}.log`), 'utf8'), /✔ a sealed preserved sign-in survives doctor, gateway, stop and restart/);
const gapFd = openSync(join(evidence, 'gap.log'), 'wx');
const gap = spawnSync('sh', ['scripts/test.sh', '--test-name-pattern=engine publishes after boot', 'packages/openclaw/test/kit.test.ts'], { stdio: ['ignore', gapFd, gapFd], env });
closeSync(gapFd);
assert.equal(gap.status, 0, 'see gap.log');
assert.match(readFileSync(join(evidence, 'gap.log'), 'utf8'), /✔ a status read while the engine publishes after boot/);
const version = JSON.parse(readFileSync('packages/openclaw/engine/package.json', 'utf8')).dependencies.openclaw;
const lines = [
  'Command: node .agents/skills/done-done-verify-byokit/capture/openclaw-restart-signin.mjs',
  `PASS: ${COPIES} copies at once on the real pinned engine ${version}: each sealed sign-in was still signed in right after a real Gateway restart`,
  'PASS: with the gap held open, the sign-in read signed in once the engine published, and a publication that never landed read unknown, not signed out',
];
writeFileSync(join(evidence, 'summary.txt'), lines.join('\n') + '\n');
writeFileSync(join(evidence, 'steps.json'), JSON.stringify({
  target: { version },
  start: 'A fresh app home holding a synthetic preserved sign-in, on the pinned engine the kit installs from the patched set',
  steps: [
    'The kit imports the preserved sign-in, starts the real pinned engine and confirms the sign-in',
    'The kit stops the engine, which seals the store, and starts it again on a busy host',
    'The app asks which providers are signed in straight after the restart and sees openai',
    'With the post-boot gap held open, the app reads signed in once the engine publishes and unknown if it never does',
  ],
  result: lines.at(-1),
}, null, 2) + '\n');
for (const line of lines) console.log(line);
