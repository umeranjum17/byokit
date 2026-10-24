#!/usr/bin/env node
// Live Boat proof of K-UNDO (features/update-undo.md, docs/cloud-kit.md 5.17 S4): on ONE real Boat machine with copies on,
// update with a copy first, break the host, undo, and find the old file and a running host on the new machine.
//
//   BOAT_KEY_FILE=<file> EVIDENCE_DIR=<outside the repo> node cloud-update-undo-live.mjs
//
// Plain provider API only: no SSH, no tailnet. Records every machine in EVIDENCE_DIR/owned.json as soon as its id is known
// and ALWAYS deletes the machines and their copies at the end, then shows both gone (machines, status, copies).
// Never prints the Boat key (a leak guard throws if it reaches an output line). Exit 0 = PASS, 1 = FAIL, 2 = bad setup.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boat, machine } from '@byokit/cloud';
import { memoryStore } from '@byokit/cloud/testing';

const { BOAT_KEY_FILE, EVIDENCE_DIR } = process.env;
if (!BOAT_KEY_FILE || !EVIDENCE_DIR) { console.error('BOAT_KEY_FILE and EVIDENCE_DIR are required'); process.exit(2); }
const baseUrl = process.env.BOAT_BASE_URL ?? 'https://boat.dev/api/v1';
const key = readFileSync(BOAT_KEY_FILE, 'utf8').trim();
const guard = (text) => { if (key && String(text).includes(key)) throw new Error('leak guard: the Boat key reached an output line'); return text; };
const log = (label, value) => {
  const line = guard(`${new Date().toISOString()} ${label}: ${JSON.stringify(value)}`);
  console.log(line);
  appendFileSync(join(EVIDENCE_DIR, 'drive.log'), `${line}\n`, { mode: 0o600 });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (bytes) => new TextDecoder().decode(bytes);

const provider = boat({ baseUrl, label: 'Boat', prices: [], key: async () => key });
const m = machine({ provider, store: memoryStore() });
const tag = Math.random().toString(36).slice(2, 8);
const name = `undo${tag}`;
const owned = new Set();
const own = (id) => { owned.add(id); writeFileSync(join(EVIDENCE_DIR, 'owned.json'), JSON.stringify({ name, ids: [...owned] }), { mode: 0o600 }); };

// A tiny host: answers on the machine port and says which version it is. Written by an install step, so it is on the disk the copy holds.
const SERVER = `require('node:http').createServer((q, s) => s.end('byokit undo proof host\\n')).listen(7310, '0.0.0.0');`;
const workDir = `/home/user/${name}`;
const versionFile = `${workDir}/version.txt`;
const good = {
  name, workDir,
  node: { version: '22.22.3', sha256: { 'linux-x64': '2e5d13569282d016861fae7c8f935e741693c269101a5bebcf761a5376d1f99f', 'linux-arm64': '1c4a9933a5e45bc88f54f70b5f91232c127ec49f1a5989d23fb85824c7adf9b7' } },
  install: [['node', '-e', `require('node:fs').writeFileSync('server.cjs', ${JSON.stringify(SERVER)})`]],
  run: { argv: ['node', `${workDir}/server.cjs`], env: {} },
};
// The "new version": its update step rewrites the version file and its run command is missing, so the host crash-loops.
const bad = { ...good,
  update: [['node', '-e', `require('node:fs').writeFileSync('version.txt', 'Umer v2')`]],
  run: { argv: ['node', `${workDir}/missing.cjs`], env: {} } };

const hostIs = async (want, ms) => {
  for (let i = 0; i < ms / 3000; i++) {
    const s = await m.host();
    if (want(s)) return s;
    await sleep(3000);
  }
  return m.host();
};
const answers = async () => (await provider.exec(m.ref, ['sh', '-c', 'curl -s --max-time 5 http://127.0.0.1:7310/ || wget -qO- -T 5 http://127.0.0.1:7310/'], { timeoutMs: 30_000 })).stdout.trim();

let pass = false;
let old = null;
let back = null;
try {
  log('machines-before', (await provider.list()).length);
  old = await m.create({ name, size: 'small', keepCopies: true });
  own(old.id);
  log('created', { id: old.id, name, keepCopies: true });
  for (let i = 0; i < 150 && (await m.state()) !== 'on'; i++) await sleep(2000);
  log('state', await m.state());

  await m.install(good);
  await provider.write(old, versionFile, new TextEncoder().encode('Umer v1'), 0o600);
  log('host-after-install', await hostIs((s) => s === 'running', 60_000));
  log('host-answers', await answers());
  log('undo-point-before', await m.undoPoint());

  // Update with a copy first (the default on a machine with copies).
  const t0 = Date.now();
  const updated = await m.update(bad);
  log('update', { seconds: Math.round((Date.now() - t0) / 1000), undo: updated.undo && { id: updated.undo.id, kind: updated.undo.kind, at: updated.undo.at }, pruneError: updated.pruneError?.code });
  const point = await m.undoPoint();
  log('undo-point', point && { id: point.id, kind: point.kind });
  log('version-after-update', text(await readRemote(old, versionFile)));
  const broken = await hostIs((s) => s === 'failed', 120_000);
  log('host-broken', broken);

  // Undo: a new machine from the copy; the old one goes.
  const t1 = Date.now();
  await m.undoUpdate(good);
  back = m.ref;
  own(back.id);
  log('undo', { seconds: Math.round((Date.now() - t1) / 1000), newId: back.id, differs: back.id !== old.id });
  log('state-after-undo', await m.state());
  log('old-status', await provider.status(old).catch((e) => `error:${e.code}`));
  const version = text(await readRemote(back, versionFile));
  log('version-after-undo', version);
  const host = await hostIs((s) => s === 'running', 120_000);
  log('host-after-undo', host);
  const answer = await answers();
  log('host-answers-after-undo', answer);
  const installed = JSON.parse(text(await readRemote(back, `${workDir}/.byokit/installed.json`)));
  log('installed-id-matches', installed.id === back.id);
  const kept = await m.undoPoint();
  log('undo-point-kept', kept?.id === point?.id);
  pass = updated.undo?.kind === 'before-update' && point?.id === updated.undo.id && broken !== 'running'
    && back.id !== old.id && version === 'Umer v1' && host === 'running' && answer.includes('undo proof host')
    && installed.id === back.id && kept?.id === point.id;
} catch (e) {
  log('error', guard(`${e.code ?? ''} ${e.message} ${JSON.stringify(e.extra ?? {})}`));
  if (m.ref && !owned.has(m.ref.id)) own(m.ref.id);
} finally {
  // Delete every machine this run made, with its copies, and show it.
  for (const id of [...owned].reverse()) {
    await m.remove(id).then(() => log('removed', id), (e) => log('remove-failed', guard(`${id} ${e.code} ${e.message}`)));
  }
  const listed = await provider.list();
  log('still-listed', [...owned].filter((id) => listed.some((r) => r.id === id)));
  for (const id of owned) log('status-after', { id, status: await provider.status({ ...(back ?? old), id }).catch((e) => `error:${e.code}`) });
  const res = await fetch(`${baseUrl}/named-snapshots`, { headers: { Authorization: `Bearer ${key}` } });
  const names = res.ok ? (await res.json()).snapshots.map((s) => s.name) : [`http-${res.status}`];
  log('copies-left', names.filter((n) => n.startsWith(`byokit-${name}-`)));
}
log('result', pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);

async function readRemote(ref, path) {
  const r = await provider.exec(ref, ['cat', path], { timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`cat ${path} exited ${r.code}`);
  return new TextEncoder().encode(r.stdout);
}
