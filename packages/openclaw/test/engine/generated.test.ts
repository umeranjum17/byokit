// O11 generated-surface proof: the committed tables match a fresh run against the pinned tarball,
// hello covers every generated operator method, every offer:true route starts with only its plugin allowed,
// and native approval requests carry the requesting member. Runs only in the engine job
// (npm run test:engine), never in npm test: generation needs the network and the cases boot gateways.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenClawKit } from '../../src/kit.ts';
import { Engine } from '../../src/engine.ts';
import { gatewayTransport } from '../../src/transport.ts';
import { scratchDir } from '../../../test-support.ts';
import routes from '../../src/routes.json' with { type: 'json' };

const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const repoDir = dirname(dirname(pkgDir));
const install = scratchDir('o11-engine-generated');
const engineDir = join(install, 'engine');

before(async () => {
  // Install the pin once; every case reuses it with a fresh state dir (the O6 signin.test.ts pattern).
  const bootstrap = new Engine({ stateDir: join(install, 'bootstrap'), engineDir, pluginId: 'byokit',
    tools: [], spawnEngine: true, onState: () => {}, onExit: () => {} });
  await bootstrap.prepare();
}, { timeout: 600_000 });

async function until(there: () => boolean, ms = 120_000): Promise<void> {
  for (let waited = 0; waited < ms; waited += 250) {
    if (there()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('the expected state never arrived');
}

/** Every operator method in the committed generated table, by source shape (never hand-edited). */
function generatedOperatorMethods(): string[] {
  const src = readFileSync(join(pkgDir, 'src', 'generated', 'methods.ts'), 'utf8');
  const operator = src.split('export interface GatewayNodeMethods')[0];
  return [...operator.matchAll(/^  '([^']+)':/gm)].map((m) => m[1]);
}

test('generated tables match a fresh run against the pinned tarball', { timeout: 600_000 }, async () => {
  const gen = spawnSync(process.execPath, [join(pkgDir, 'scripts', 'gen-methods.ts')],
    { cwd: repoDir, timeout: 300_000, encoding: 'utf8' });
  assert.equal(gen.status, 0, `gen-methods failed: ${(gen.stderr ?? '').slice(-2000)}`);
  const dirty = spawnSync('git', ['-C', repoDir, 'status', '--porcelain', '--', 'packages/openclaw/src/generated'],
    { encoding: 'utf8' });
  assert.equal(dirty.stdout.trim(), '', `committed tables differ from a fresh run:\n${dirty.stdout}`);
});

// The pinned gateway withholds 25 generated operator methods from an operator hello (O11 probe
// 2026-09-29, engine 2026.8.1). Only one is truly unserved; the rest are served-but-unadvertised,
// handshake-only, or capability/surface-gated. The test pins the exact set: any change in either direction
// fails with the list, forcing ledger review (the spec's "list them and fail"). Probe evidence:
// - served but unadvertised (called with {} and answered past method resolution): poll, sessions.get,
//   sessions.resolve, sessions.usage, sessions.usage.logs, sessions.usage.timeseries, chat.inject,
//   config.openFile, device.pair.setupStatus.
// - sessions.steer answers `session mutation target is unavailable` even mid-run: it needs a
//   channel-bound session target, which bare kit sessions have not got (the kit's steer stays correct).
// - connect is handshake-only (`connect is only valid as the first request`); nativeHook.invoke and
//   web.login.wait report no relay provider / no login provider on this host.
// - genuinely unserved: assistant.media.get (`unknown method`).
// - unprobed (starting the flow has side effects): device.pair.setupCode, web.login.start, push.*,
//   desktop.*, worker.desktop.*.
const EXPECTED_UNADVERTISED = ['assistant.media.get', 'chat.inject', 'config.openFile', 'connect',
  'desktop.launch', 'desktop.observe', 'device.pair.setupCode', 'device.pair.setupStatus', 'nativeHook.invoke',
  'poll', 'push.test', 'push.web.subscribe', 'push.web.test', 'push.web.unsubscribe', 'push.web.vapidPublicKey',
  'sessions.get', 'sessions.resolve', 'sessions.steer', 'sessions.usage', 'sessions.usage.logs',
  'sessions.usage.timeseries', 'web.login.start', 'web.login.wait', 'worker.desktop.launch', 'worker.desktop.observe'];

test('hello coverage of the generated operator methods is exactly the proven set', { timeout: 600_000 }, async () => {
  const stateDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'byokit-o11-hello-'));
  const kit = new OpenClawKit({ stateDir, engineDir, tools: [], approvalTimeoutMs: 10_000 });
  try {
    await kit.start();
    assert.equal(kit.state.phase, 'ready');
    const missing = generatedOperatorMethods().filter((m) => !kit.hello?.methods.includes(m)).sort();
    assert.deepEqual(missing, EXPECTED_UNADVERTISED,
      `hello coverage changed, update the ledger: ${missing.filter((m) => !EXPECTED_UNADVERTISED.includes(m)).join(', ') || '(methods were advertised)'}`);
  } finally {
    await kit.stop().catch(() => {});
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('every offer:true route starts with only its plugin allowed', { timeout: 600_000 }, async () => {
  const offered = (routes as { choice: string; plugin: string; offer: boolean }[]).filter((r) => r.offer);
  assert.ok(offered.length > 0, 'routes.json offers nothing');
  for (const route of offered) {
    const stateDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'byokit-o11-offer-'));
    const kit = new OpenClawKit({ stateDir, engineDir, tools: [], approvalTimeoutMs: 10_000,
      config: { plugins: { allow: [route.plugin] } } });
    try {
      await kit.start();
      assert.equal(kit.state.phase, 'ready', `${route.choice} did not start`);
      const saved = JSON.parse(readFileSync(join(stateDir, 'openclaw', 'openclaw.json'), 'utf8'));
      assert.ok((saved.plugins?.allow ?? []).includes(route.plugin), `${route.choice} lost its plugin: ${JSON.stringify(saved.plugins?.allow)}`);
    } finally {
      await kit.stop().catch(() => {});
      rmSync(stateDir, { recursive: true, force: true });
    }
  }
});

test('plugin approval requests carry the requesting member', { timeout: 600_000 }, async () => {
  const stateDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'byokit-o11-plugappr-'));
  const kit = new OpenClawKit({ stateDir, engineDir, tools: [], approvalTimeoutMs: 30_000 });
  try {
    await kit.start();
    assert.equal(kit.state.phase, 'ready');
    await kit.ensureMember('m1');
    const root = join(stateDir, 'openclaw');
    const peer = gatewayTransport({ port: Number(readFileSync(join(root, 'port'), 'utf8')),
      token: readFileSync(join(root, 'token'), 'utf8').trim(),
      identityPath: join(root, 'device.json'), bridgeSock: join(root, 'bridge.sock') });
    await peer.start();
    try {
      // The engine holds the request open until the approval resolves, so it stays in flight; unlike the
      // fake's old shape the engine requires title+description and mints the id itself.
      const pending = peer.request('plugin.approval.request', { title: 'install x',
        description: 'contract plugin approval', agentId: 'm1', sessionKey: 'agent:m1:o11:plugin:1' });
      // The approval must attribute while the request is still in flight.
      let seen;
      for (let waited = 0; ; waited += 250) {
        seen = kit.approvals('m1').find((a) => a.source === 'plugin');
        if (seen || waited >= 120_000) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      assert.ok(seen, 'no plugin approval arrived');
      assert.equal(seen.member, 'm1');
      assert.match(seen.summary, /install x/);
      await kit.decide(seen.id, { allow: true });
      const requested = await pending as { id?: string };
      assert.equal(requested?.id, seen.id);
      await until(() => kit.approvals().length === 0);
    } finally {
      await peer.stop().catch(() => {});
    }
  } finally {
    await kit.stop().catch(() => {});
    rmSync(stateDir, { recursive: true, force: true });
  }
});
