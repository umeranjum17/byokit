import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { removeScratch, scratchDir } from '../../test-support.ts';
import { connect } from 'node:net';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Engine } from '../src/engine.ts';

const listening = (port: number) => new Promise<boolean>(resolve => {
  const socket = connect({ host: '127.0.0.1', port });
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
});

// Every local address listening on `port`: Linux reads /proc/net/tcp and tcp6; macOS has no /proc, so lsof answers.
function listenAddresses(port: number): string[] {
  if (process.platform !== 'linux')
    return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8' }).split('\n')
      .filter(line => line.startsWith('n')).map(line => line.slice(1, line.lastIndexOf(':')).replace(/^\[|\]$/g, ''));
  const hex = `:${port.toString(16).toUpperCase().padStart(4, '0')}`;
  return ['tcp', 'tcp6'].flatMap(table => readFileSync(`/proc/net/${table}`, 'utf8').split('\n').slice(1)
    .map(line => line.trim().split(/\s+/)).filter(([, local, , state]) => local?.endsWith(hex) && state === '0A')
    .map(([, local]) => local.slice(0, -hex.length)))
    .map(address => address === '0100007F' ? '127.0.0.1' : address === '00000000000000000000000001000000' ? '::1' : address);
}

// Shared by npm test's offline child and test:engine's pinned engine.
export async function isolationContract(install?: (dir: string) => string | Promise<string>): Promise<void> {
  const dir = scratchDir('engine-isolation');
  const decoy = join(dir, 'decoy');
  for (const name of ['.pi', '.openclaw', '.codex', '.claude', '.config/herdr']) {
    const path = join(decoy, name);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'canary'), name);
  }
  const original = process.env.HOME;
  process.env.HOME = decoy;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'should-not-be-inherited';
  const states: string[] = [];
  // Node rejects npm's ci arguments if an offline fixture ever needs repair; never invoke real npm.
  const engine = new Engine({ stateDir: join(dir, 'own'), ...(install ? { engineDir: await install(dir), npmPath: process.execPath } : {}), pluginId: 'byokit', tools: [], spawnEngine: true,
    onState: s => states.push(`${s.phase}/${s.why ?? ''}`), onExit() {} });
  try {
    const ctx = await engine.start();
    assert.ok(ctx);
    const { port, token, identityPath } = ctx;
    assert.notEqual(port, 18789);
    assert.equal(token.length, 64);
    for (const file of [identityPath, join(engine.root, 'token')])
      assert.equal(statSync(file).mode & 0o777, 0o600);
    for (const folder of [engine.root, join(engine.root, 'home'), join(engine.root, 'state')])
      assert.equal(statSync(folder).mode & 0o777, 0o700);
    const env = engine.doctorContext().env;
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.OPENCLAW_SKIP_CHANNELS, '1');
    assert.ok(!JSON.stringify(env).includes('.pi'));
    assert.ok(!JSON.stringify(env).includes(decoy));
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.OPENCLAW_LOAD_SHELL_ENV, '0');
    assert.equal(env.OPENCLAW_EXEC_SHELL_SNAPSHOT, '0');
    let ready = false;
    for (let i = 0; i < 300; i++) {
      if (await listening(port)) { ready = true; break; }
      if (states.some(s => s.startsWith('failed/'))) break;
      await delay(200);
    }
    assert.ok(ready, `gateway did not listen: ${states.join(', ')}; ${readFileSync(join(dir, 'own/logs/openclaw.log'), 'utf8').slice(-2500)}`);
    const c = JSON.parse(readFileSync(join(dir, 'own/openclaw/openclaw.json'), 'utf8'));
    assert.equal(c.gateway.bind, 'loopback');
    assert.equal(c.memory.search.provider, 'none');
    assert.equal(c.memory.search.fallback, 'none');
    assert.equal(c.plugins.allow.includes('byokit'), true);
    assert.equal(JSON.parse(readFileSync(join(dir, 'own/openclaw/plugin/package.json'), 'utf8')).name, 'byokit-openclaw-bridge');
    const listeners = listenAddresses(port);
    assert.ok(listeners.length && listeners.every(address => address === '127.0.0.1' || address === '::1'), `gateway listeners must be loopback only: ${listeners.join(', ')}`);
    const log = readFileSync(join(dir, 'own/logs/openclaw.log'), 'utf8');
    assert.ok(!log.includes(token));
    assert.ok(!log.includes('PRIVATE KEY'));
    assert.ok(!log.includes('should-not-be-inherited'));
    if (install) {
      const child = JSON.parse(readFileSync(join(engine.root, 'home', 'child.json'), 'utf8'));
      // The supervisor records the boot in usage/boots.jsonl everywhere; gateway.identity backs Linux-only orphan recovery.
      const boots = join(engine.root, 'usage', 'boots.jsonl');
      const bootId: string | undefined = existsSync(boots) ? JSON.parse(readFileSync(boots, 'utf8').trim().split('\n').at(-1)!).bootId : undefined;
      if (process.platform === 'linux') assert.equal(JSON.parse(readFileSync(join(engine.root, 'gateway.identity'), 'utf8')).bootId, bootId);
      const expected: Record<string, string | undefined> = { ...env, ...(bootId ? { BYOKIT_ENGINE_BOOT: bootId,
        BYOKIT_ENGINE_USAGE_LEDGER: join(engine.root, 'usage') } : {}) };
      if (bootId) assert.match(bootId, /^[0-9a-f-]{36}$/);
      assert.equal(child.env.OPENCLAW_GATEWAY_TOKEN === expected.OPENCLAW_GATEWAY_TOKEN, true, 'token matches without entering failure traces');
      // macOS itself adds __CF_USER_TEXT_ENCODING to every process at launch; the spawn env above never carries it.
      if (process.platform === 'darwin') delete child.env.__CF_USER_TEXT_ENCODING;
      assert.deepEqual({ ...child.env, OPENCLAW_GATEWAY_TOKEN: '<redacted>' }, { ...expected, OPENCLAW_GATEWAY_TOKEN: '<redacted>' },
        'the child actually received only the isolated environment and accounting identity');
      assert.equal(child.cwd, env.HOME);
    }
    for (const name of ['.pi', '.openclaw', '.codex', '.claude', '.config/herdr']) assert.equal(readFileSync(join(decoy, name, 'canary'), 'utf8'), name);
  } finally {
    await engine.stop();
    if (original === undefined) delete process.env.HOME; else process.env.HOME = original;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey;
    removeScratch(dir);
  }
}
