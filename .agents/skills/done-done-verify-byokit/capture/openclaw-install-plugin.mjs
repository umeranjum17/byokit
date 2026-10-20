// Installing a route's external provider plugin through the built @byokit/openclaw, live: the real pinned engine and
// npm registry, no real key (an invalid stand-in the Z.AI key test refuses). `routes()` shows the Z.AI rows
// `needs_plugin`, `installPlugin('zai')` makes them ready, and `addKey` reaches the engine's key test. The tamper legs make
// the kit's shipped pin file (engine/plugins.json) read differently in this process only; no file changes.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs, { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenClawKit, PluginInstallError } from '@byokit/openclaw';

const stateDir = mkdtempSync(join(process.env.BYOKIT_PROOF_ROOT ?? tmpdir(), 'oc-install-plugin-'));
const kit = new OpenClawKit({ stateDir, callbackPort: 0, npmPath: process.env.BYOKIT_NPM ?? 'npm',
  ...(process.env.BYOKIT_TEST_ENGINE_DIR ? { engineDir: process.env.BYOKIT_TEST_ENGINE_DIR } : {}) });
const config = () => JSON.parse(readFileSync(join(stateDir, 'openclaw', 'openclaw.json'), 'utf8'));
const rows = () => kit.routes().filter((r) => r.needs?.plugin === 'zai').map((r) => `${r.choice} readiness=${r.readiness} offer=${r.offer}`);
const listed = async () => {
  const zai = (await kit.call('plugins.list', {})).plugins.find((p) => p.id === 'zai');
  return `zai installed=${zai?.installed} enabled=${zai?.enabled} version=${zai?.version}`;
};
const ready = async () => { while (kit.state.phase !== 'ready') { if (kit.state.phase === 'failed') throw new Error(kit.state.why); await delay(250); } };
const refused = async (code) => {
  const before = { listed: await listed(), allow: config().plugins.allow };
  const error = await kit.installPlugin('zai').then(() => undefined, (e) => e);
  console.log(`  rejected: ${error?.name} code=${error?.code} message="${error?.message}"`);
  assert.ok(error instanceof PluginInstallError && error.code === code);
  assert.deepEqual({ listed: await listed(), allow: config().plugins.allow }, before);
  assert.equal(existsSync(join(stateDir, 'openclaw', 'installed-plugins.json')), false);
  console.log('  plugins.list and plugins.allow unchanged:', before.listed);
};

// The person's own engine home is watched, never read: a recursive inotify watch counts any access during the drive.
const own = join(homedir(), '.openclaw');
const watch = existsSync(own) ? spawn('inotifywait', ['-m', '-r', '-q', '--format', '%e %w%f', own], { stdio: ['ignore', 'pipe', 'ignore'] }) : undefined;
let touched = 0;
watch?.stdout.on('data', (chunk) => { touched += String(chunk).split('\n').filter(Boolean).length; });
watch?.on('error', () => {});

const realRead = fs.readFileSync;
let tamper;
fs.readFileSync = (path, ...rest) => {
  const out = realRead(path, ...rest);
  if (!tamper || typeof path !== 'string' || !path.endsWith('/openclaw/engine/plugins.json')) return out;
  const pins = JSON.parse(String(out)); tamper(pins); return JSON.stringify(pins);
};
syncBuiltinESMExports();
const restart = async (edit) => { tamper = edit; await kit.stop(); await kit.start(); await ready(); };

try {
  await kit.start(); await ready();
  console.log('routes before:\n ', rows().join('\n  '));
  assert.ok(kit.routes().filter((r) => r.needs?.plugin === 'zai').every((r) => r.readiness === 'needs_plugin'));
  console.log('addKey before:', JSON.stringify(await kit.addKey('umer', { authChoice: 'zai-coding-global', apiKey: 'invalid-umer-test' })));

  console.log('tamper: the shipped pin names another version than the engine pin');
  await restart((pins) => { pins.zai.spec = '@openclaw/zai-provider@2026.8.34'; });
  await refused('version');
  console.log('tamper: the shipped pin carries another integrity than the registry serves');
  await restart((pins) => { pins.zai.integrity = `sha512-${Buffer.alloc(64, 7).toString('base64')}`; });
  await refused('integrity');

  await restart(undefined);
  const started = Date.now();
  await kit.installPlugin('zai');
  console.log(`installPlugin('zai') resolved in ${Date.now() - started} ms;`, await listed(), '| allow:', config().plugins.allow.join(','));
  console.log('routes after:\n ', rows().join('\n  '));
  assert.equal(kit.routes().find((r) => r.choice === 'zai-coding-global')?.offer, true);
  const added = await kit.addKey('umer', { authChoice: 'zai-coding-global', apiKey: 'invalid-umer-test' });
  console.log('addKey after:', JSON.stringify(added));
  assert.deepEqual(added, { status: 'invalid', reason: 'auth' });
  await restart(undefined);
  console.log('after a restart:', rows().find((r) => r.startsWith('zai-coding-global ')), '|', await listed());
} finally {
  await kit.stop();
  await delay(500); watch?.kill();
  console.log(watch ? `${own}: ${touched} inotify events during the drive` : `${own}: absent`);
  // The prepared engine set is sealed read-only: open its directories before removing it.
  const open = (dir) => { if (lstatSync(dir).isDirectory()) { chmodSync(dir, 0o700); for (const name of readdirSync(dir)) open(join(dir, name)); } };
  open(stateDir); rmSync(stateDir, { recursive: true, force: true });
}
