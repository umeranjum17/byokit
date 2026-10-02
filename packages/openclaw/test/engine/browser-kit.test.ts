// W3/W7: shipped kit/plugin on published stock 2026.8.1, never a patched engine or real account.
// Protected handoff is deliberately NOT enabled by this proof. See the scoped qualification receipt.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, closeSync, openSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { chromium } from 'playwright';
import { OpenClawKit } from '../../src/kit.ts';
import { gatewayTransport } from '../../src/transport.ts';
import { startModelStub } from '../../src/testing/model-stub.ts';
import { scratchDir, trackChild } from '../../../test-support.ts';

const entry = process.env.BYOKIT_BROWSER_STOCK_ENTRY;
const executable = process.env.BYOKIT_TEST_CHROMIUM ?? chromium.executablePath();
const required = process.env.BYOKIT_BROWSER_REQUIRED === '1';
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const until = async (condition: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!condition()) { assert.ok(Date.now() < end, 'fixture condition timed out'); await new Promise(resolve => setTimeout(resolve, 20)); }
};

test('W3/W7 stock engine: shipped plugin pins two member browsers, rejects unsafe actions, live view is model-free and handoff stays unprotected', {
  skip: (!entry || !existsSync(executable)) && !required ? 'requires explicit published stock entry and fixture Chromium' : false,
  timeout: 180_000,
}, async t => {
  assert.ok(entry && existsSync(entry), 'explicit stock entry required; no install or discovery in the test');
  const stock = dirname(entry);
  assert.equal(JSON.parse(readFileSync(join(stock, 'package.json'), 'utf8')).version, '2026.8.1');
  assert.equal(JSON.parse(readFileSync(join(stock, 'dist/build-info.json'), 'utf8')).commit, 'ea806575e6450e4d1efdfc72c19f04be982a1b9b');
  const before = hash(entry);
  const stateDir = scratchDir('k');
  const wrapper = join(stateDir, 'chromium-fixture');
  writeFileSync(wrapper, `#!/bin/sh\nexec '${executable.replaceAll("'", "'\\''")}' '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost' "$@" 2>>'${join(stateDir, 'chromium.stderr')}'\n`, { mode: 0o700 });
  const model = await startModelStub();
  let child: ChildProcess | undefined;
  const requests: unknown[] = [], outputs: unknown[] = [], toolEvents: unknown[] = [];
  const site = createServer((req, res) => {
    res.setHeader('cache-control', 'no-store'); res.setHeader('content-type', 'text/html');
    res.end(req.url === '/login' ? '<form><input type="password"><button>Sign in</button></form>'
      : `<title>Fixture ${req.url}</title><h1>Fixture ${req.url}</h1>`);
  });
  await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
  const kit = new OpenClawKit({ stateDir, spawnEngine: false, browser: { executablePath: wrapper, members: ['ada', 'bea'] },
    config: {
      tools: { allow: ['browser', 'request_sign_in'] },
      agents: { entries: { ada: {}, bea: {} }, defaults: { model: { primary: 'byokit-stub/test' } } },
      models: { providers: { 'byokit-stub': { baseUrl: model.url, apiKey: 'synthetic-stub', api: 'openai-completions',
        models: [{ id: 'test', name: 'Synthetic fixture', input: ['text'], contextWindow: 32000, maxTokens: 2048,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } },
    },
    host: { gate: async () => ({ allow: true }), call: async () => 'unused' },
    transport: ctx => {
      const fd = openSync(join(stateDir, 'stock-engine.log'), 'a', 0o600);
      try {
        child = trackChild(spawn(process.execPath, [entry!, 'gateway', '--port', String(ctx.port)], {
          cwd: kit.doctorContext().env.HOME, env: kit.doctorContext().env, stdio: ['ignore', fd, fd],
        }));
      } finally { closeSync(fd); }
      child.on('error', () => {});
      const transport = gatewayTransport(ctx);
      return { ...transport, request: async (method, params, options) => {
        if (method === 'agent') requests.push(params);
        return transport.request(method, params, options);
      } };
    },
  });
  try {
    await kit.start();
    assert.equal(kit.hello?.server.version, '2026.8.1');
    const run = async (member: string, input: object, session = member) => {
      const end = await kit.run({ member, sessionKey: `agent:${member}:fixture:${session}`, idempotencyKey: `fixture:${member}:${session}:${requests.length}`,
        message: `[tool browser ${JSON.stringify(input)}]` }, e => { if (e.type === 'tool') toolEvents.push(e); });
      outputs.push(end); assert.ok(end.ok, JSON.stringify(end)); return end;
    };
    for (const member of ['ada', 'bea']) {
      assert.equal(kit.browser?.state(member).why, 'handoff-unprotected');
      await run(member, { action: 'open', targetUrl: `${origin}/${member}`, profile: 'user', target: 'node', node: 'foreign' });
      const profile = `byokit-${member}`;
      const tabs = await kit.callDynamic('browser.request', { method: 'GET', path: '/tabs', query: { profile } }) as any;
      assert.ok(JSON.stringify(tabs).includes(`/${member}`), JSON.stringify(tabs));
    }
    const config = JSON.parse(readFileSync(join(stateDir, 'openclaw/openclaw.json'), 'utf8'));
    assert.notEqual(config.browser.profiles['byokit-ada'].cdpUrl, config.browser.profiles['byokit-bea'].cdpUrl);
    for (const member of ['ada', 'bea']) {
      const page = await chromium.connectOverCDP(config.browser.profiles[`byokit-${member}`].cdpUrl);
      try { assert.ok(page.contexts()[0]!.pages().some(p => p.url().endsWith(`/${member}`))); }
      finally { await page.close(); }
    }
    for (const input of [{ action: 'profiles' }, { action: 'act', request: { kind: 'evaluate', fn: 'document.cookie' } }]) {
      const end = await run('ada', input, `denied${requests.length}`);
      assert.ok(JSON.stringify(end).includes('browser action refused'), JSON.stringify(end));
    }
    const handoff = await kit.run({ member: 'ada', sessionKey: 'agent:ada:fixture:signin', message: '[tool request_sign_in {"note":"fixture"}]' });
    outputs.push(handoff); assert.ok(JSON.stringify(handoff).includes('browser sign-in handoff unavailable'), JSON.stringify(handoff));
    assert.equal(kit.browser!.signIns().length, 0, 'no production request or parked session without protection');
    const count = model.calls.length;
    let frames = 0;
    const live = kit.browser!.live({ kind: 'browser', member: 'ada' }, { grant: 'fixture-view' }, {
      state: () => {}, frame: frame => { assert.ok(frame.jpeg.byteLength); frames++; },
    });
    await until(() => frames > 0); live.close();
    assert.equal(model.calls.length, count, 'viewing makes no model/tool submission');
    await assert.rejects(kit.patchConfig({ agents: { entries: { bea: { tools: { allow: ['exec'] } } } } }), /browser tool policy refused/);
    t.diagnostic(`stock=${before}; fixture positive model requests=${count}; live frames=${frames}; handoff-unprotected; distinct pinned profiles=2`);
  } finally {
    await kit.stop();
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGTERM');
      const timer = setTimeout(() => child!.kill('SIGKILL'), 5000);
      await exited; clearTimeout(timer);
    }
    site.closeAllConnections(); await new Promise<void>(resolve => site.close(() => resolve())); await model.close();
    assert.equal(hash(entry), before, 'stock executable untouched');
    const receipt = { engine: '2026.8.1', upstreamCommit: 'ea806575e6450e4d1efdfc72c19f04be982a1b9b', stockEntry: before,
      shippedPlugin: hash(new URL('../../plugin/index.js', import.meta.url).pathname), requests, outputs, toolEvents,
      providerRequests: model.calls.length, protectedHandoffQualified: false,
      limits: ['no protected production handoff', 'no recovery-turn refusal qualification', 'no private secret/profile scan in this kit test; broker test owns that matrix'] };
    if (process.env.BYOKIT_BROWSER_RECEIPT) writeFileSync(process.env.BYOKIT_BROWSER_RECEIPT, JSON.stringify(receipt, null, 2));
    const logs = process.env.BYOKIT_BROWSER_RECEIPT ? `${process.env.BYOKIT_BROWSER_RECEIPT}.stock.log` : undefined;
    if (logs && existsSync(join(stateDir, 'stock-engine.log'))) writeFileSync(logs, readFileSync(join(stateDir, 'stock-engine.log')));
    if (logs && existsSync(join(stateDir, 'chromium.stderr'))) writeFileSync(`${logs}.chromium`, readFileSync(join(stateDir, 'chromium.stderr')));
    rmSync(stateDir, { recursive: true, force: true });
  }
});
