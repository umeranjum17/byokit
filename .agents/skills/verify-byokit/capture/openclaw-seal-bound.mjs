import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { AuthStoreSealSizeError, OpenClawKit, stateWords } from '@byokit/openclaw';
const SEAL_CAP_BYTES = 128 * 1024 * 1024;
import { fakeGateway } from '@byokit/openclaw/testing';
import { hostKeySeal } from '@byokit/secrets';

const evidence = resolve(process.argv[2]);
// Sparse caches and the killed host's state are bulky in name only, but they still belong under the
// caller's absolute task-private scratch root (short Unix socket paths), never inside the worktree.
const scratch = process.argv[3];
if (!scratch || !scratch.startsWith('/') || scratch === '/') throw new Error('Pass an absolute task-private scratch root');
mkdirSync(evidence, { recursive: true, mode: 0o700 });
mkdirSync(scratch, { recursive: true, mode: 0o700 });
const stateDir = mkdtempSync(join(scratch, 'seal-'));
const key = new Uint8Array(randomBytes(32));
const seal = hostKeySeal({ key, service: 'seal-bound-proof' });
const root = join(stateDir, 'openclaw');
const file = join(root, 'auth-store.sealed');
const kits = [];
const kit = () => {
  const instance = new OpenClawKit({ stateDir, authSeal: seal, spawnEngine: false, transport: fakeGateway().factory });
  kits.push(instance);
  return instance;
};
const caches = [
  ['home/.cache/pnpm/store/v10/blob-0.bin', 150 * 1024 * 1024],
  ['home/.cache/pnpm/store/v10/blob-1.bin', 150 * 1024 * 1024],
  ['home/.npm/_cacache/index-v5/entry', 60 * 1024 * 1024],
  ['home/.codex/sessions/2026/10/04/transcript.jsonl', 40 * 1024 * 1024],
];
try {
  // Credential state: a synthetic Umer sign-in plus a ledger larger than the sealer's 1 MiB envelope chunk.
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, 'state', 'auth.json'), 'Umer task-private sign-in');
  const ledger = randomBytes(1536 * 1024);
  writeFileSync(join(root, 'state', 'ledger.sqlite'), ledger);
  mkdirSync(join(root, 'home', '.claude'), { recursive: true });
  writeFileSync(join(root, 'home', '.claude', 'settings.json'), '{"model":"opus"}');
  let cacheBytes = 0;
  for (const [name, size] of caches) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    const fd = openSync(path, 'w');
    ftruncateSync(fd, size);
    closeSync(fd);
    cacheBytes += size;
  }
  // The killed host: a real child process holding the store is SIGKILLed without stop(), leaving live
  // plaintext trees and a stale lock. Written into the evidence dir so bare @byokit/* imports resolve.
  const ready = join(stateDir, 'host-ready');
  const hostFile = join(evidence, 'seal-bound-host.mjs');
  writeFileSync(hostFile, `
import { writeFileSync } from 'node:fs';
import { OpenClawKit } from '@byokit/openclaw';
import { fakeGateway } from '@byokit/openclaw/testing';
import { hostKeySeal } from '@byokit/secrets';
const kit = new OpenClawKit({ stateDir: ${JSON.stringify(stateDir)}, spawnEngine: false, transport: fakeGateway().factory,
  authSeal: hostKeySeal({ key: new Uint8Array(${JSON.stringify([...key])}), service: 'seal-bound-proof' }) });
await kit.start();
writeFileSync(${JSON.stringify(ready)}, '1');
setInterval(() => {}, 1000);
`);
  const host = spawn(process.execPath, [hostFile], { stdio: ['ignore', 'ignore', 'pipe'] });
  let hostError = '';
  host.stderr.on('data', chunk => { hostError += chunk; });
  for (let i = 0; i < 200 && !existsSync(ready) && host.exitCode === null; i++) await new Promise(r => setTimeout(r, 50));
  assert.ok(existsSync(ready), `killed-host child reached ready: ${hostError}`);
  assert.equal(existsSync(join(root, 'state', 'auth.json')), true, 'host held the store live');
  const exited = once(host, 'exit');
  host.kill('SIGKILL');
  await exited;
  // Recovery: the next start() reseals the killed home. Only credential files may reach the sealer.
  const recovering = kit();
  await recovering.start();
  assert.equal(recovering.state.phase, 'ready');
  assert.equal(readFileSync(join(root, 'state', 'auth.json'), 'utf8'), 'Umer task-private sign-in');
  assert.ok(readFileSync(join(root, 'state', 'ledger.sqlite')).equals(ledger), 'the >1 MiB ledger crossed the envelope chunk boundary and restored byte-identical');
  assert.equal(readFileSync(join(root, 'home', '.claude', 'settings.json'), 'utf8'), '{"model":"opus"}');
  const snapshot = JSON.parse(seal.decryptString(readFileSync(file)));
  const sealedPaths = snapshot.files.map(([path]) => path);
  assert.equal(sealedPaths.some(path => /(^|\/)\.cache(\/|$)/.test(path) || /(^|\/)\.npm(\/|$)/.test(path) || /(^|\/)sessions(\/|$)/.test(path)), false, `a cache reached the sealer: ${sealedPaths.join(',')}`);
  const credentialBytes = snapshot.files.reduce((sum, [, data]) => sum + Buffer.from(data, 'base64').length, 0);
  assert.ok(credentialBytes < 4 * 1024 * 1024, `only credential state sealed: ${credentialBytes}`);
  console.log(JSON.stringify({ leg: 'killed host without stop()', cacheBytesOnDisk: cacheBytes, credentialBytesSealed: credentialBytes, sealedFiles: sealedPaths.length, payloadChars: seal.decryptString(readFileSync(file)).length }));
  await recovering.stop();
  for (const [name, size] of caches) assert.equal(statSync(join(root, name)).size, size, `cache left at rest untouched: ${name}`);
  // Over-cap: a credential file past SEAL_CAP_BYTES refuses with the typed error before it is read.
  const before = readFileSync(file);
  mkdirSync(join(root, 'state'), { recursive: true });
  const huge = join(root, 'state', 'huge.sqlite');
  const fd = openSync(huge, 'w');
  ftruncateSync(fd, SEAL_CAP_BYTES + 1024 * 1024);
  closeSync(fd);
  const over = kit();
  let failure;
  try { await over.start(); } catch (error) { failure = error; }
  assert.ok(failure instanceof AuthStoreSealSizeError, `expected AuthStoreSealSizeError, got ${failure?.name}`);
  assert.equal(failure.code, 'auth-store-seal-size');
  assert.equal(failure.cap, SEAL_CAP_BYTES);
  assert.ok(failure.size > failure.cap);
  assert.ok(failure.message.includes(String(failure.size)) && failure.message.includes(String(failure.cap)), 'the error names the size and the cap');
  assert.deepEqual(readFileSync(file), before, 'the refused store is unchanged');
  assert.equal(existsSync(huge), true, 'the over-cap live file is unchanged');
  console.log(JSON.stringify({ leg: 'over-cap store', error: failure.name, code: failure.code, size: failure.size, cap: failure.cap, state: over.state, words: stateWords(over.state), sealedFileUnchanged: true, processContinued: true }));
  await over.stop();
  assert.deepEqual(readFileSync(file), before);
  console.log('PASS: large caches never sealed across a host kill; over-cap store refused with the typed error; process continued');
  rmSync(join(evidence, 'seal-bound-host.mjs'), { force: true });
} finally {
  for (const instance of kits.reverse()) await instance.stop();
  rmSync(stateDir, { recursive: true, force: true });
}
