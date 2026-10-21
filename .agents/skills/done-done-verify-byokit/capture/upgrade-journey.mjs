// The upgrade journey: the release path a user takes. A fresh consumer app installs
// the previous shipped @byokit/accounts version from the npm registry, then upgrades
// the package in place over that same install, then drives the core journey again on
// the upgraded package.
//
// Captures into $DONE_DONE_EVIDENCE_ROOT: upgrade-journey.txt (the consumer app's own
// transcript, before and after the upgrade) and steps.json (the step record done-done
// reads).
//
// Usage: node capture/upgrade-journey.mjs [evidence folder]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EXPECTED, PACKAGE, createApp, evidenceDir, packPackage, runConsumer, stepRecord, writeConsumer, writeEvidence } from './core-journey.mjs';

/** The version of a plain x.y.z release, as a comparable tuple. */
const parts = (version) => version.split('.').map((n) => Number(n));

/** The shipped version before this build: the greatest published version under the one being built. */
export function previousShipped(current) {
  const out = execFileSync('npm', ['view', PACKAGE, 'versions', '--json'], { encoding: 'utf8' });
  const published = JSON.parse(out);
  const under = published.filter((v) => /^\d+\.\d+\.\d+$/.test(v) && compare(v, current) < 0);
  if (!under.length) throw new Error(`the npm registry lists no published ${PACKAGE} version below ${current}`);
  return under.reduce((newest, v) => (compare(v, newest) > 0 ? v : newest));
}

/** -1, 0 or 1, as a is below, the same as or above b. */
function compare(a, b) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

/** Where the registry keeps a published version, named in the capture. */
function registryTarball(version) {
  const out = execFileSync('npm', ['view', `${PACKAGE}@${version}`, 'dist.tarball'], { encoding: 'utf8' });
  return out.trim();
}

/** The step record done-done reads: what a user did, and what they can see at the end. */
function upgradeRecord(version) {
  return {
    target: { version },
    start: 'an app with the previous released @byokit/accounts version installed from the npm registry',
    steps: [
      'the person links a ChatGPT account by device code and gets an answer back',
      'the app upgrades the installed package in place, over the version it had',
      'the person links a ChatGPT account again and gets an answer back through the upgraded package',
    ],
    result: 'the upgraded package answers: "ChatGPT is connected." and the answer "You said: Plan my day"',
  };
}

function main() {
  const evidence = evidenceDir(process.argv);
  const scratch = mkdtempSync(join(tmpdir(), 'byokit-upgrade-'));
  try {
    const packed = packPackage(join(scratch, 'tgz'));
    const previous = previousShipped(packed.version);
    const appDir = join(scratch, 'app');
    const before = createApp(appDir, `${PACKAGE}@${previous}`);
    assert.equal(before.version, previous, `the registry installed ${before.version}, not ${previous}`);
    writeConsumer(appDir);
    const beforeTranscript = runConsumer(appDir);
    for (const line of EXPECTED) assert.ok(beforeTranscript.includes(line), `the previous version did not show "${line}":\n${beforeTranscript}`);

    // The upgrade, in place: the same app directory, the same install, the new package over the old one.
    const upgraded = createApp(appDir, packed.file);
    assert.equal(upgraded.version, packed.version, `the upgrade installed ${upgraded.version}, not ${packed.version}`);
    const afterTranscript = runConsumer(upgraded.appDir);
    for (const line of EXPECTED) assert.ok(afterTranscript.includes(line), `the upgraded package did not show "${line}":\n${afterTranscript}`);

    const report = [
      'byokit upgrade journey: a consumer app upgrades the shipped package in place and keeps working',
      `previous shipped version: ${PACKAGE}@${previous} (${registryTarball(previous)})`,
      `package under test: ${PACKAGE}@${packed.version}`,
      `upgraded from: ${packed.file} (npm pack of packages/accounts)`,
      `app: ${appDir} (the same app directory before and after the upgrade)`,
      '',
      `1. the previous shipped version, installed from the npm registry`,
      beforeTranscript.trimEnd(),
      '',
      `2. upgraded in place, over that same install: ${PACKAGE}@${previous} -> ${PACKAGE}@${upgraded.version}`,
      '',
      `3. the core journey on the upgraded package`,
      afterTranscript.trimEnd(),
      '',
    ].join('\n');
    writeEvidence(evidence, 'upgrade-journey.txt', report, upgradeRecord(upgraded.version));
    console.log(report);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
