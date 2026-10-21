// The core user journey, end to end on the shipped package: a fresh consumer app
// outside the monorepo installs the packed @byokit/accounts tarball (the artifact
// npm users receive), links a ChatGPT account by device code against the loopback
// stand-in provider, reads the status and asks a question that streams back.
//
// Captures into $DONE_DONE_EVIDENCE_ROOT: core-journey.txt (the consumer app's own
// transcript) and steps.json (the step record done-done reads).
//
// Usage: node capture/core-journey.mjs [evidence folder]
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..', '..', '..');
export const PACKAGE = '@byokit/accounts';
export const PACKAGE_DIR = join(repo, 'packages', 'accounts');
export const CONSUMER = join(here, 'core-journey-consumer.mjs');

/** The evidence folder: the run's own folder, or the one the caller names. */
export function evidenceDir(argv) {
  const dir = process.env.DONE_DONE_EVIDENCE_ROOT || argv[2];
  if (!dir) throw new Error('no evidence folder: run this as a done-done journey (DONE_DONE_EVIDENCE_ROOT) or pass one as the first argument');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** The package as npm ships it: `npm pack` runs its prepack, so the tarball holds the build of the current source. */
export function packPackage(destDir) {
  mkdirSync(destDir, { recursive: true });
  const out = execFileSync('npm', ['pack', '--pack-destination', destDir, '--json', PACKAGE_DIR], { cwd: repo, encoding: 'utf8' });
  const parsed = JSON.parse(out);
  const entry = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  if (!entry?.filename) throw new Error(`npm pack returned no tarball: ${out}`);
  return { file: join(destDir, entry.filename), name: entry.name, version: entry.version, shasum: entry.shasum };
}

/** A consumer app outside the monorepo, with a package installed into it. */
export function createApp(appDir, spec) {
  mkdirSync(appDir, { recursive: true });
  if (!existsSync(join(appDir, 'package.json'))) {
    writeFileSync(join(appDir, 'package.json'), `${JSON.stringify({ name: 'byokit-consumer', private: true, version: '1.0.0', type: 'module' }, null, 2)}\n`);
  }
  const installed = spawnSync('npm', ['install', '--no-audit', '--no-fund', spec], { cwd: appDir, encoding: 'utf8', timeout: 15 * 60_000 });
  if (installed.error) throw installed.error;
  if (installed.status !== 0) throw new Error(`npm install ${spec} failed:\n${installed.stderr}${installed.stdout}`);
  const manifest = JSON.parse(readFileSync(join(appDir, 'node_modules', ...PACKAGE.split('/'), 'package.json'), 'utf8'));
  return { appDir, version: manifest.version };
}

/** The app the consumer runs in: the consumer file copied next to the installed package. */
export function writeConsumer(appDir) {
  const file = join(appDir, 'consumer.mjs');
  copyFileSync(CONSUMER, file);
  return file;
}

/** Run the consumer app; its transcript is the capture. */
export function runConsumer(appDir) {
  const run = spawnSync(process.execPath, [join(appDir, 'consumer.mjs')], { cwd: appDir, encoding: 'utf8', timeout: 5 * 60_000 });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`the consumer app exited ${run.status}:\n${run.stderr}${run.stdout}`);
  return run.stderr ? `${run.stdout.trimEnd()}\n\nthe app also wrote to stderr:\n${run.stderr.trimEnd()}\n` : run.stdout;
}

/** The lines a user sees when the journey worked; each one must be in the transcript. */
export const EXPECTED = [
  'sign-in: waiting code MOCK-',
  'status: ChatGPT is connected.',
  'answer: You said: Plan my day',
  'not offered: Error: AI account not offered here',
  "no account: ResponseError: ChatGPT isn't signed in yet.",
];

/** The step record done-done reads: what a user did, and what they can see at the end. */
export function stepRecord(version) {
  return {
    target: { version },
    start: 'a fresh consumer app with no package installed and no account linked',
    steps: [
      'install the shipped @byokit/accounts package into the app',
      'the app links a ChatGPT account by device code: it shows a code and the person approves it',
      'the app reads the account status',
      'the app asks a question and prints the answer it gets back',
    ],
    result: 'the installed package answers: "ChatGPT is connected." and the answer "You said: Plan my day"',
  };
}

/** Write the capture and the step record into the evidence folder. */
export function writeEvidence(evidence, name, transcript, record) {
  writeFileSync(join(evidence, name), transcript);
  writeFileSync(join(evidence, 'steps.json'), `${JSON.stringify(record, null, 2)}\n`);
}

function main() {
  const evidence = evidenceDir(process.argv);
  const scratch = mkdtempSync(join(tmpdir(), 'byokit-core-'));
  try {
    const packed = packPackage(join(scratch, 'tgz'));
    const appDir = join(scratch, 'app');
    const { version } = createApp(appDir, packed.file);
    writeConsumer(appDir);
    const transcript = runConsumer(appDir);
    for (const line of EXPECTED) assert.ok(transcript.includes(line), `the consumer app did not show "${line}":\n${transcript}`);
    const report = [
      'byokit core journey: a consumer app links an account and gets an answer through the shipped package',
      `package under test: ${packed.name}@${version}`,
      `installed from: ${packed.file} (npm pack of packages/accounts)`,
      `app: ${appDir}`,
      'run: node consumer.mjs (exit 0)',
      '',
      transcript.trimEnd(),
      '',
    ].join('\n');
    writeEvidence(evidence, 'core-journey.txt', report, stepRecord(version));
    console.log(report);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
