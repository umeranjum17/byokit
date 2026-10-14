// Built-entry drive: engine stores sealed keyring-only follow a switch to dual wrapping, so a restore with the
// keyring locked still opens every store through the host wrap. Fake keyring backend; no OS keyring, no egress.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { OpenClawKit } from '@byokit/openclaw';
import { fakeGateway } from '@byokit/openclaw/testing';
import { osKeyringSeal } from '@byokit/secrets';

const stateDir = resolve(mkdtempSync('.verify-artifacts/wrap-mode-reseal-'));
const root = join(stateDir, 'openclaw');
const data = new Map();
let locked = false;
const keyring = { get: (n) => { if (locked) throw new Error('locked'); return data.get(n) ?? null; }, set: (n, v) => data.set(n, v), delete: (n) => data.delete(n) };
const sealOptions = { service: 'verify-wrap-mode', stateDir, keyring };
const kit = (dualWrap) => new OpenClawKit({ stateDir, authSeal: osKeyringSeal({ ...sealOptions, dualWrap }), spawnEngine: false, transport: fakeGateway().factory });
const modes = () => readdirSync(join(root, 'auth-store.objects')).map((e) => readFileSync(join(root, 'auth-store.objects', e))[4]);
const stores = ['state/transcripts/run.jsonl', 'state/logs/gateway.log', 'state/state/openclaw.sqlite'];
mkdirSync(join(root, 'state'), { recursive: true });
writeFileSync(join(root, 'state', 'auth.json'), 'Umer synthetic sign-in');
for (const name of stores) { mkdirSync(join(root, name, '..'), { recursive: true }); writeFileSync(join(root, name), `${name} bytes`); }

await kit(false).prepare();
console.log('keyring-only object envelope modes:', modes().join(','));
const dual = kit(true);
await dual.prepare();
await dual.start();
await dual.stop();
console.log('after a dual-wrap start/stop, main:', readFileSync(join(root, 'auth-store.sealed'))[4], 'objects:', modes().join(','));
locked = true;
const relocked = kit(true);
try { await relocked.start(); }
catch (error) { console.log('locked restore failed:', error.name, error.reason); process.exit(1); }
for (const name of stores) assert.equal(readFileSync(join(root, name), 'utf8'), `${name} bytes`);
console.log('locked restore:', relocked.state.phase, '- every store reopened through the host wrap');
await relocked.stop();
