// Every runnable BYOKit surface says which version it runs. The built CLIs are run as a person runs them
// (`--version`, `--help`, and a usage error), each checked against its own package.json; then the herdr-kit example
// journey (its e2e test, offline) pairs a phone page with the computer and keeps two screenshots: the page beside
// a matching host, and the same page after the host came back updated, with the mismatch hint.
//   node .agents/skills/done-done-verify-byokit/capture/show-versions.mjs   (after npm run build; writes into
//   $DONE_DONE_EVIDENCE_ROOT, else .verify-artifacts/show-versions)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const out = process.env.DONE_DONE_EVIDENCE_ROOT ?? '.verify-artifacts/show-versions';
mkdirSync(out, { recursive: true });
const CLIS = [['accounts', 'byokit-accounts'], ['decide', 'byokit-eval'], ['dictation', 'byokit-dictation-wer'], ['write', 'write']];
const run = (bin, args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });

for (const [kit, name] of CLIS) {
  const manifest = JSON.parse(readFileSync(`packages/${kit}/package.json`, 'utf8'));
  const bin = join('packages', kit, manifest.bin[name]);
  // A workspace build with pending change fragments is a dev build; decide reads its version inline and shows it plain.
  const pending = existsSync(`packages/${kit}/changes`) && readdirSync(`packages/${kit}/changes`).some((f) => f.endsWith('.md'));
  const want = `${name} ${manifest.version}${pending && kit !== 'decide' ? '+dev (dev build)' : ''}`;
  const version = run(bin, ['--version']);
  console.log(`$ ${name} --version\n${version.stdout}${version.stderr}exit ${version.status}`);
  assert.equal(version.status, 0);
  assert.equal(version.stdout, `${want}\n`);
  const help = run(bin, ['--help']);
  console.log(`$ ${name} --help\n${help.stdout}${help.stderr}exit ${help.status}`);
  assert.equal(help.status, 0);
  assert.equal(help.stdout.split('\n')[0], want, 'the help header names the version');
}
// The error case: a usage error still says which version answered it.
const usage = run('packages/decide/dist/cli.js', []);
console.log(`$ byokit-eval (no files)\n${usage.stdout}${usage.stderr}exit ${usage.status}`);
assert.equal(usage.status, 2);
assert.match(usage.stderr, /^byokit-eval \d+\.\d+\.\d+\nusage: byokit-eval /);
console.log('cli-versions: every CLI prints its package.json version for --version and in its help header');

const herdr = join(out, 'herdr-kit');
const journey = spawnSync('sh', ['scripts/test.sh', 'examples/herdr-kit/e2e.test.ts'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, BYOKIT_EXAMPLE_RESTART_PROOF: resolve(herdr) } });
console.log(`$ sh scripts/test.sh examples/herdr-kit/e2e.test.ts\n${journey.stdout.split('\n').filter((l) => /^[✔✖ℹ]/.test(l)).join('\n')}\nexit ${journey.status}`);
assert.equal(journey.status, 0, journey.stderr);
for (const shot of ['versions-match.png', 'restart-connected.png']) assert.ok(existsSync(join(herdr, shot)), `${shot} written`);
console.log(`herdr-kit-versions: ${herdr}/versions-match.png (App · Host match), ${herdr}/restart-connected.png (host updated: the mismatch hint)`);
