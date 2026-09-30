import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { Engine } from '../src/engine.ts';

const listening = (port: number) => new Promise<boolean>(resolve => {
  const socket = connect({ host: '127.0.0.1', port });
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
});

// Shared by npm test's offline child and test:engine's pinned engine.
export async function isolationContract(install?: (dir: string) => string): Promise<void> {
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
  const engine = new Engine({ stateDir: join(dir, 'own'), ...(install ? { engineDir: install(dir), npmPath: process.execPath } : {}), pluginId: 'byokit', tools: [], spawnEngine: true,
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
    const listeners = readFileSync('/proc/net/tcp', 'utf8').split('\n').filter(line => line.trim().split(/\s+/)[1]?.endsWith(`:${port.toString(16).toUpperCase().padStart(4, '0')}`));
    assert.ok(listeners.length && listeners.every(line => line.trim().split(/\s+/)[1]?.startsWith('0100007F:')), 'gateway listeners must be loopback only');
    const log = readFileSync(join(dir, 'own/logs/openclaw.log'), 'utf8');
    assert.ok(!log.includes(token));
    assert.ok(!log.includes('PRIVATE KEY'));
    assert.ok(!log.includes('should-not-be-inherited'));
    if (install) {
      const child = JSON.parse(readFileSync(join(engine.root, 'home', 'child.json'), 'utf8'));
      assert.deepEqual(child.env, env, 'the child actually received the isolated environment');
      assert.equal(child.cwd, env.HOME);
    }
    for (const name of ['.pi', '.openclaw', '.codex', '.claude', '.config/herdr']) assert.equal(readFileSync(join(decoy, name, 'canary'), 'utf8'), name);
  } finally {
    await engine.stop();
    if (original === undefined) delete process.env.HOME; else process.env.HOME = original;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey;
    rmSync(dir, { recursive: true, force: true });
  }
}
