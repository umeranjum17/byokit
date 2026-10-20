import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, ftruncateSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { AuthStoreSealSizeError, OpenClawKit, stateWords } from '@byokit/openclaw';
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
const objects = join(root, 'auth-store.objects');
const objectFor = (name) => join(objects, `${createHash('sha256').update(name).digest('hex')}.sealed`);
const kits = [];
const kit = () => {
  const instance = new OpenClawKit({ stateDir, authSeal: seal, spawnEngine: false, transport: fakeGateway().factory });
  kits.push(instance);
  return instance;
};
// Regenerable `home` caches stay on disk unsealed: they are never credential state and never bounded.
const caches = [
  ['home/.cache/pnpm/store/v10/blob-0.bin', 150 * 1024 * 1024],
  ['home/.cache/pnpm/store/v10/blob-1.bin', 150 * 1024 * 1024],
  ['home/.npm/_cacache/index-v5/entry', 60 * 1024 * 1024],
  ['home/.codex/sessions/2026/10/04/transcript.jsonl', 40 * 1024 * 1024],
];
// Engine `state` stores: exported transcripts, legacy session logs, undelivered media and the shared SQLite
// database. Each is sealed as its own encrypted object under auth-store.objects/, outside the 128 MiB blob,
// so a long-used host never refuses with the size error, and after a stop none is left in plaintext.
const stores = [
  ['state/transcripts/2026/10/04/standup/transcript.jsonl', 90 * 1024 * 1024],
  ['state/transcripts/2026/10/04/standup/summary.md', 2 * 1024 * 1024],
  ['state/agents/main/sessions/legacy-session.jsonl', 70 * 1024 * 1024],
  ['state/sessions/legacy-usage-cost.jsonl', 5 * 1024 * 1024],
  ['state/media/attachments/recording.bin', 30 * 1024 * 1024],
  ['state/delivery-queue-media/undelivered-attachment.bin', 30 * 1024 * 1024],
  ['state/state/openclaw.sqlite', 4 * 1024 * 1024],
];
const canary = Buffer.from('byokit-seal-bound-transcript-canary');
// Every file under `root`, sealed or not, read in full: true when any holds `needle` as plaintext.
const holdsPlaintext = (dir, needle) => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (lstatSync(path).isDirectory()) { if (holdsPlaintext(path, needle)) return true; continue; }
    if (lstatSync(path).isFile() && readFileSync(path).includes(needle)) return true;
  }
  return false;
};
const digestOf = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
try {
  // Credential state: a synthetic Umer sign-in plus a token cache larger than the sealer's 1 MiB envelope chunk.
  mkdirSync(join(root, 'state', 'credentials'), { recursive: true });
  writeFileSync(join(root, 'state', 'auth.json'), 'Umer task-private sign-in');
  const tokenCache = randomBytes(1536 * 1024);
  writeFileSync(join(root, 'state', 'credentials', 'oauth-token-cache.json'), tokenCache);
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
  let storeBytes = 0;
  const digests = new Map();
  for (const [name, size] of stores) {
    const bytes = randomBytes(size);
    if (name.endsWith('.sqlite')) Buffer.from('SQLite format 3\0').copy(bytes, 0);
    canary.copy(bytes, 4096);
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    digests.set(name, createHash('sha256').update(bytes).digest('hex'));
    storeBytes += size;
  }
  assert.ok(storeBytes > 128 * 1024 * 1024, 'the engine stores alone pass the seal cap');
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
  const host = spawn(process.execPath, [hostFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  let hostOutput = '';
  host.stdout.on('data', chunk => { hostOutput += chunk; });
  host.stderr.on('data', chunk => { hostOutput += chunk; });
  for (let i = 0; i < 600 && !existsSync(ready) && host.exitCode === null; i++) await new Promise(r => setTimeout(r, 50));
  assert.ok(existsSync(ready), `killed-host child reached ready: ${hostOutput}`);
  assert.equal(existsSync(join(root, 'state', 'auth.json')), true, 'host held the store live');
  const exited = once(host, 'exit');
  host.kill('SIGKILL');
  await exited;
  // Recovery: the next start() restores the killed home. Engine stores reopen byte for byte and, though the
  // state stores together pass the cap, the credential seal never refuses.
  const recovering = kit();
  await recovering.start();
  assert.equal(recovering.state.phase, 'ready');
  assert.equal(readFileSync(join(root, 'state', 'auth.json'), 'utf8'), 'Umer task-private sign-in');
  assert.ok(readFileSync(join(root, 'state', 'credentials', 'oauth-token-cache.json')).equals(tokenCache), 'the >1 MiB credential token cache restored byte-identical');
  assert.equal(readFileSync(join(root, 'home', '.claude', 'settings.json'), 'utf8'), '{"model":"opus"}');
  for (const [name, digest] of digests) assert.equal(digestOf(join(root, name)), digest, `engine store restored from its own object: ${name}`);
  // The credential blob holds credentials only; every engine store is its own encrypted object beside it.
  const blob = JSON.parse(seal.decryptString(readFileSync(file)));
  const blobPaths = blob.files.map(([path]) => path).sort();
  assert.deepEqual(blobPaths, ['home/.claude/settings.json', 'state/auth.json', 'state/credentials/oauth-token-cache.json'], `the credential blob holds credentials only: ${blobPaths.join(',')}`);
  assert.ok(existsSync(objects), 'engine stores are sealed as separate objects');
  assert.equal(readdirSync(objects).length, stores.length, 'one object per engine store, nothing more');
  for (const [name] of stores) {
    const object = objectFor(name);
    assert.equal(existsSync(object), true, `sealed as its own object: ${name}`);
    assert.deepEqual(JSON.parse(seal.decryptString(readFileSync(object))).path, name, `object carries its own store path: ${name}`);
  }
  console.log(JSON.stringify({ leg: 'killed host without stop()', cacheBytesOnDisk: cacheBytes, storeBytesOnDisk: storeBytes, credentialBlobFiles: blobPaths, objectFiles: readdirSync(objects).length, credentialBytesSealed: blob.files.reduce((sum, [, data]) => sum + Buffer.from(data, 'base64').length, 0) }));
  await recovering.stop();
  for (const [name] of stores) assert.equal(existsSync(join(root, name)), false, `engine store sealed off the disk after stop: ${name}`);
  assert.equal(holdsPlaintext(root, canary), false, 'no plaintext engine store survives a stop');
  for (const [name, size] of caches) assert.equal(statSync(join(root, name)).size, size, `regenerable home cache left at rest untouched: ${name}`);
  // Over-cap: a 1 GiB sparse credential file (not a store) is past any cap, so it refuses with the typed error before it is read.
  const before = readFileSync(file);
  mkdirSync(join(root, 'state'), { recursive: true });
  const huge = join(root, 'state', 'huge-credential.json');
  const fd = openSync(huge, 'w');
  ftruncateSync(fd, 1024 * 1024 * 1024);
  closeSync(fd);
  const over = kit();
  let failure;
  try { await over.start(); } catch (error) { failure = error; }
  assert.ok(failure instanceof AuthStoreSealSizeError, `expected AuthStoreSealSizeError, got ${failure?.name}`);
  assert.equal(failure.code, 'auth-store-seal-size');
  assert.ok(failure.cap > 0 && failure.size > failure.cap);
  assert.ok(failure.message.includes(`more than ${Math.floor(failure.size / 1024 / 1024)} MB`) && failure.message.includes(`the limit is ${failure.cap / 1024 / 1024} MB`), 'the error names the size and the cap in MB');
  assert.deepEqual(readFileSync(file), before, 'the refused store is unchanged');
  assert.equal(existsSync(huge), true, 'the over-cap live file is unchanged');
  console.log(JSON.stringify({ leg: 'over-cap store', error: failure.name, code: failure.code, size: failure.size, cap: failure.cap, state: over.state, words: stateWords(over.state), sealedFileUnchanged: true, processContinued: true }));
  await over.stop();
  assert.deepEqual(readFileSync(file), before);
  console.log('PASS: engine stores over the cap seal per store outside the blob and reopen byte for byte; no plaintext survives a stop; home caches stay; over-cap credential refused with the typed error');
  rmSync(join(evidence, 'seal-bound-host.mjs'), { force: true });
} finally {
  for (const instance of kits.reverse()) await instance.stop();
  rmSync(stateDir, { recursive: true, force: true });
}
