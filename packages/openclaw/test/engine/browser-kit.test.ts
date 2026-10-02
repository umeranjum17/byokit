// W3/W7: shipped kit/plugin on published stock 2026.8.1, never a patched engine or real account.
// Protected handoff is deliberately NOT enabled by this proof. See the scoped qualification receipt.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync, closeSync, openSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { OpenClawKit } from '../../src/kit.ts';
import type { BrowserHostController } from '../../src/browser/host.ts';
import { gatewayTransport } from '../../src/transport.ts';
import { startModelStub } from '../../src/testing/model-stub.ts';
import { trackChild } from '../../../test-support.ts';
import { scanCapabilities, emitEvidence, boundedAwait, sqliteTranscripts } from './privacy-evidence.ts';
import { protectionMatrix, type MatrixReceipt } from './protection-matrix.ts';

const entry = process.env.BYOKIT_BROWSER_STOCK_ENTRY;
const executable = process.env.BYOKIT_TEST_CHROMIUM ?? chromium.executablePath();
const required = process.env.BYOKIT_BROWSER_REQUIRED === '1';
const matrixEnabled = process.env.BYOKIT_BROWSER_PROTECTION_MATRIX === '1';
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const until = async (condition: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!condition()) { assert.ok(Date.now() < end, 'fixture condition timed out'); await new Promise(resolve => setTimeout(resolve, 20)); }
};

test('W3/W7 stock engine: shipped plugin pins two member browsers, rejects unsafe actions, live view is model-free and handoff stays unprotected', {
  skip: (!entry || !existsSync(executable)) && !required ? 'requires explicit published stock entry and fixture Chromium' : false,
  timeout: process.env.BYOKIT_BROWSER_PROTECTION_MATRIX === '1' ? 480_000 : 180_000,
}, async t => {
  assert.ok(entry && existsSync(entry), 'explicit stock entry required; no install or discovery in the test');
  assert.ok(existsSync(executable), 'explicit fixture Chromium required; no browser download in the test');
  const stock = dirname(entry);
  assert.equal(JSON.parse(readFileSync(join(stock, 'package.json'), 'utf8')).version, '2026.8.1');
  assert.equal(JSON.parse(readFileSync(join(stock, 'dist/build-info.json'), 'utf8')).commit, 'ea806575e6450e4d1efdfc72c19f04be982a1b9b');
  const before = hash(entry);
  const stateDir = mkdtempSync(join(tmpdir(), 'k-'));
  const wrapper = join(stateDir, 'chromium-fixture');
  writeFileSync(wrapper, `#!/bin/sh\nexec '${executable.replaceAll("'", "'\\''")}' '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost' "$@" 2>>'${join(stateDir, 'chromium.stderr')}'\n`, { mode: 0o700 });
  assert.ok(!matrixEnabled || process.env.BYOKIT_BROWSER_RECEIPT, 'matrix requires an external owned receipt path');
  const journal = `${process.env.BYOKIT_BROWSER_RECEIPT ?? join(stateDir, 'receipt')}.incremental.jsonl`;
  const emit = (event: unknown) => emitEvidence(journal, event);
  const step = <T>(stage: string, work: () => Promise<T>, ms?: number) => boundedAwait(stage, work, emit, ms);
  emit({ kind: 'fixture-start', stockEntry: before, stateDir, protectedHandoffQualified: false });
  const model = await startModelStub([], { onCall: call => {
    const brokerBindings = captureCapabilities();
    emit({ kind: 'provider-call', call, brokerBindings, brokerCapabilityHistory: [...capabilities.values()] });
  } });
  let child: ChildProcess | undefined;
  const requests: unknown[] = [], outputs: unknown[] = [], toolEvents: unknown[] = [], diagnostics: unknown[] = [], thumbnails: unknown[] = [], runtimeRefusals: unknown[] = [];
  const privacyChecks: { scope: string; checked: number; matches: string[] }[] = [];
  const privateCapabilities = new Set<string>();
  const brokerControlCapabilities = new Set<string>();
  const observationOnly = !!process.env.BYOKIT_BROWSER_POLICY_OBSERVE;
  const counterfactual = process.env.BYOKIT_BROWSER_POLICY_OBSERVE === 'counterfactual';
  const matrix: MatrixReceipt = { stages: [], transcripts: [], resumeDispatches: [] };
  const siteRequests: { url: string; cookie: string }[] = [];
  const site = createServer((req, res) => {
    siteRequests.push({ url: req.url ?? '', cookie: req.headers.cookie ?? '' });
    if (req.url === '/private') {
      res.setHeader('set-cookie', 'matrix_private=PRIVATE_MATRIX_COOKIE; HttpOnly; SameSite=Lax; Path=/');
      res.end('<title>PRIVATE_MATRIX_PAGE</title><form><input type="password"></form>'); return;
    }
    res.setHeader('cache-control', 'no-store'); res.setHeader('content-type', 'text/html');
    res.end(req.url === '/login' ? '<form><input type="password"><button>Sign in</button></form>'
      : `<title>Fixture ${req.url}</title><h1>Fixture ${req.url}</h1>`);
  });
  await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
  const kit = new OpenClawKit({ stateDir, spawnEngine: false,
    tools: matrixEnabled ? [{ name: 'matrix_echo', description: 'Owned synthetic capability scrub control.', parameters: { type: 'object' } }] : undefined,
    browser: { executablePath: wrapper, members: ['ada', 'bea'] },
    config: {
      tools: { allow: ['browser', 'request_sign_in', ...(matrixEnabled ? ['matrix_echo'] : [])] },
      agents: { entries: { ada: {}, bea: {} }, defaults: { model: { primary: 'byokit-stub/test' } } },
      models: { providers: { 'byokit-stub': { baseUrl: model.url, apiKey: 'synthetic-stub', api: 'openai-completions',
        models: [{ id: 'test', name: 'Synthetic fixture', input: ['text'], contextWindow: 32000, maxTokens: 2048,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } },
    },
    host: { gate: async () => ({ allow: true }), call: async (_run, tool) => tool === 'matrix_echo'
      ? JSON.stringify({ public: 'PUBLIC_CAPABILITY_CONTROL', nested: [...brokerControlCapabilities] }) : 'unused' },
    transport: ctx => {
      const fd = openSync(join(stateDir, 'stock-engine.log'), 'a', 0o600);
      try {
        child = trackChild(spawn(process.execPath, [entry!, 'gateway', '--port', String(ctx.port)], {
          cwd: kit.doctorContext().env.HOME, env: kit.doctorContext().env, stdio: ['ignore', fd, fd],
        }));
      } finally { closeSync(fd); }
      child.on('error', () => {});
      const transport = gatewayTransport(ctx);
      return { ...transport, start: () => Promise.race([transport.start(), once(child!, 'exit').then(([code]) => {
        throw new Error(`owned stock fixture exited during startup (${code})`);
      })]), request: async (method, params, options) => {
        if (method === 'agent') { captureCapabilities(); requests.push(params); }
        const reply = await transport.request(method, params, options);
        if (method === 'tools.effective') {
          const result = reply as Record<string, any>;
          diagnostics.push({ method, params, keys: Object.keys(result), agentId: result.agentId, profile: result.profile,
            groups: result.groups?.map((group: any) => ({ id: group.id, tools: group.tools?.map((tool: any) => ({
              keys: Object.keys(tool), id: tool.id, source: tool.source, enabled: tool.enabled, disabled: tool.disabled, deniedBySession: tool.deniedBySession,
            })) })) });
        }
        if (method === 'config.get') {
          const result = reply as Record<string, any>, c = result.config;
          const local = JSON.parse(readFileSync(join(stateDir, 'openclaw/openclaw.json'), 'utf8'));
          diagnostics.push({ method, keys: Object.keys(result), appliedRevisionMatches: typeof result.configRevisionHash === 'string'
            && !!result.configRevisionHash && result.configRevisionHash === result.appliedConfigHash,
            tools: c?.tools, defaultsTools: c?.agents?.defaults?.tools,
            agentTools: Object.entries(c?.agents?.entries ?? {}).map(([id, value]: [string, any]) => ({ id, tools: value.tools })),
            profiles: Object.entries(c?.browser?.profiles ?? {}).map(([id, profile]: [string, any]) => ({ id,
              keys: Object.keys(profile), attachOnly: profile.attachOnly,
              matchesOwnedFile: profile.cdpUrl === local.browser?.profiles?.[id]?.cdpUrl,
              endpointDigest: typeof profile.cdpUrl === 'string' ? createHash('sha256').update(profile.cdpUrl).digest('hex') : null,
            })) });
        }
        return reply;
      } };
    },
  });
  const capabilities = new Map<string, { member: string; generation: number; tokenDigest: string; endpointDigest: string }>();
  function captureCapabilities() {
    const current: { member: string; generation: number; tokenDigest: string; endpointDigest: string }[] = [];
    const host = (kit as unknown as { browserHost?: BrowserHostController }).browserHost;
    for (const member of ['ada', 'bea']) {
      const binding = host?.brokerBinding(member);
      if (!binding) continue;
      const token = new URL(binding.endpoint.cdpUrl).searchParams.get('token');
      if (!token) throw new Error('owned broker binding has no token');
      privateCapabilities.add(token); privateCapabilities.add(binding.endpoint.cdpUrl);
      brokerControlCapabilities.add(token); brokerControlCapabilities.add(binding.endpoint.cdpUrl);
      const id = new URL(binding.endpoint.cdpUrl).pathname.split('/').at(-1);
      if (id && /^[a-f0-9]{32}$/i.test(id)) { privateCapabilities.add(id); brokerControlCapabilities.add(id); }
      const tokenDigest = createHash('sha256').update(token).digest('hex');
      const identity = { member, generation: binding.generation, tokenDigest,
        endpointDigest: createHash('sha256').update(binding.endpoint.cdpUrl).digest('hex') };
      capabilities.set(`${member}:${binding.generation}:${tokenDigest}`, identity); current.push(identity);
    }
    return current;
  }
  const offCapabilities = kit.onEvent('byokit.browser', () => captureCapabilities());
  let snapshot = 0;
  const retain = (stage: string) => {
    const brokerBindings = captureCapabilities();
    const captures = sqliteTranscripts(join(stateDir, 'openclaw'), `${journal}.snapshots/${++snapshot}`);
    emit({ kind: 'durable-transcripts', stage, brokerBindings, brokerCapabilityHistory: [...capabilities.values()], captures });
    return captures;
  };
  try {
    await step('launch-kit', () => kit.start(), 90_000); captureCapabilities();
    assert.equal(capabilities.size, 2, 'record both authoritative initial broker capabilities before model submission');
    assert.equal(kit.hello?.server.version, '2026.8.1');
    if (observationOnly) {
      const host = (kit as unknown as { browserHost?: BrowserHostController }).browserHost;
      const local = JSON.parse(readFileSync(join(stateDir, 'openclaw/openclaw.json'), 'utf8'));
      diagnostics.push({ bindingObservation: ['ada', 'bea'].map(member => {
        const binding = host?.brokerBinding(member);
        return { member, state: kit.browser?.state(member), hostState: host?.state(member), generation: binding?.generation,
          endpointMatchesOwnedFile: binding?.endpoint.cdpUrl === local.browser?.profiles?.[`byokit-${member}`]?.cdpUrl };
      }) });
      assert.equal(model.calls.length, 0);
      if (counterfactual) for (const member of ['ada', 'bea']) {
        assert.equal(kit.browser?.state(member).why, 'handoff-unprotected', 'stock masked profile is acknowledged without widening tools');
        assert.equal(host?.brokerBinding(member)?.generation, 1, 'same actual host generation');
      }
      t.diagnostic('CAUSAL OBSERVATION ONLY: zero model submissions; not a positive W7 qualification');
      return;
    }
    const run = async (member: string, input: object, session = member) => {
      const start = toolEvents.length;
      const end = await kit.run({ member, sessionKey: `agent:${member}:fixture:${session}`, idempotencyKey: `fixture:${member}:${session}:${requests.length}`,
        message: `[tool browser ${JSON.stringify(input)}]` }, e => { if (e.type === 'tool') toolEvents.push(e); });
      outputs.push(end); assert.ok(end.ok, JSON.stringify(end));
      if ((input as { action?: string }).action === 'open') {
        const completed = toolEvents.slice(start).filter((event: any) => event.phase === 'end') as { error?: boolean }[];
        assert.ok(completed.length && completed.every(event => !event.error), 'normal model completion does not prove successful browser navigation');
      }
      return end;
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
      const text = JSON.stringify(end);
      if (input.action === 'profiles') {
        assert.ok(text.includes('browser action refused'), text);
        runtimeRefusals.push({ action: 'profiles', actor: 'shipped before-tool-call guard' });
      } else {
        // evaluateEnabled:false removes evaluate from the stock schema before our hook runs.
        assert.ok(text.includes('Validation failed for tool') && text.includes('request.kind: must be equal to one of the allowed values'), text);
        runtimeRefusals.push({ action: 'evaluate', actor: 'stock disabled-evaluation schema' });
      }
    }
    const handoff = await kit.run({ member: 'ada', sessionKey: 'agent:ada:fixture:signin', message: '[tool request_sign_in {"note":"fixture"}]' });
    outputs.push(handoff); assert.ok(JSON.stringify(handoff).includes('browser sign-in handoff unavailable'), JSON.stringify(handoff));
    assert.equal(kit.browser!.signIns().length, 0, 'no production request or parked session without protection');
    const count = model.calls.length;
    let frames = 0;
    emit({ stage: 'live-open', phase: 'start', at: Date.now() });
    const live = kit.browser!.live({ kind: 'browser', member: 'ada' }, { grant: 'fixture-view' }, {
      state: () => {}, frame: frame => { assert.ok(frame.jpeg.byteLength); frames++; },
    });
    emit({ stage: 'live-open', phase: 'end', at: Date.now() });
    await step('live-first-frame', () => until(() => frames > 0));
    retain('post-live-first-frame');
    const thumb = await step('thumbnail', () => kit.browser!.thumbnail({ kind: 'browser', member: 'ada' }, { grant: 'fixture-view' }));
    assert.ok(thumb.state === 'ok', JSON.stringify(thumb));
    const decoder = await step('decoder-connect', () => chromium.connectOverCDP(config.browser.profiles['byokit-ada'].cdpUrl));
    try {
      const page = decoder.contexts()[0]!.pages().find(p => p.url().endsWith('/ada'))!;
      const decoded = await step('thumbnail-decode', () => page.evaluate(async bytes => {
        const image = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }));
        const size = { w: image.width, h: image.height }; image.close(); return size;
      }, Array.from(thumb.frame.jpeg)));
      assert.ok(decoded.w <= 320 && decoded.w > 0, JSON.stringify(decoded));
      assert.equal(decoded.w, thumb.frame.w); assert.equal(decoded.h, thumb.frame.h);
      thumbnails.push({ decoded, reported: { w: thumb.frame.w, h: thumb.frame.h }, concurrentLiveFrames: frames });
    } finally {
      await step('decoder-close', () => decoder.close());
      emit({ stage: 'live-close', phase: 'start', at: Date.now() }); live.close();
      emit({ stage: 'live-close', phase: 'end', at: Date.now() });
    }
    assert.equal(model.calls.length, count, 'concurrent live view and thumbnail make no model/tool submission');
    await assert.rejects(kit.patchConfig({ agents: { entries: { bea: { tools: { allow: ['exec'] } } } } }), /browser tool policy refused/);
    // A positive tool-result control prevents a vacuous pass from missing/empty provider evidence.
    for (const member of ['ada', 'bea']) assert.ok(model.calls.some(call => call.body.messages?.some((message: any) =>
      message.role === 'tool' && JSON.stringify(message.content).includes(`${origin}/${member}`))),
      `full provider body retains ${member}'s public tool-result URL`);
    for (const [scope, value] of [['full-provider-bodies', model.calls], ['display-events-only', toolEvents],
      ['final-output-only', outputs]] as const) {
      const check = { scope, ...scanCapabilities(value, privateCapabilities) };
      privacyChecks.push(check);
      assert.equal(check.matches.length, 0, `${scope}: raw capability digest matches; see private receipt`);
    }
    if (process.env.BYOKIT_BROWSER_PROTECTION_MATRIX === '1') {
      const restart = async (beforeStart?: () => void) => {
        await step('restart-kit-stop', () => kit.stop());
        if (child?.pid && child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit'); child.kill('SIGTERM');
          const timer = setTimeout(() => child!.kill('SIGKILL'), 5000);
          await exited; clearTimeout(timer);
        }
        beforeStart?.(); await step('restart-kit-start', () => kit.start(), 90_000);
      };
      await protectionMatrix({ kit, stateDir, origin, model, capabilities: privateCapabilities, receipt: matrix,
        agentRequests: () => requests.length, restart, captureCapabilities, retain, emit,
        privateVisited: () => siteRequests.some(request => request.url === '/private'),
        cookieObserved: member => siteRequests.some(request => request.url === `/${member}`
          && request.cookie.includes('matrix_private=PRIVATE_MATRIX_COOKIE')) });
    }
    t.diagnostic(`stock=${before}; fixture positive model requests=${count}; live frames=${frames}; handoff-unprotected; distinct pinned profiles=2`);
  } finally {
    // Retain actual loopback provider bodies and authoritative broker-token digests before owned cleanup.
    // Event/output clipping is not evidence that the provider request was safe.
    let brokerTokens: Record<string, string> = {};
    try {
      captureCapabilities();
      const pinned = JSON.parse(readFileSync(join(stateDir, 'openclaw/openclaw.json'), 'utf8'));
      brokerTokens = Object.fromEntries(Object.entries(pinned.browser.profiles).flatMap(([id, profile]: [string, any]) => {
        const token = new URL(profile.cdpUrl).searchParams.get('token');
        return token ? [[id, createHash('sha256').update(token).digest('hex')]] : [];
      }));
    } catch { diagnostics.push({ proofCaptureFailure: 'owned broker-token snapshot unavailable' }); }
    offCapabilities();
    emit({ kind: 'pre-cleanup-receipt', requests, outputs, toolEvents, modelCalls: model.calls,
      matrix, diagnostics, brokerCapabilityHistory: [...capabilities.values()], protectedHandoffQualified: false });
    let cleanupFailure: unknown;
    try { matrix.transcripts.push({ stage: 'pre-cleanup', captures: retain('pre-cleanup') }); }
    catch (error) { emit({ kind: 'capture-failure', error: String(error) }); cleanupFailure = error; }
    try { await step('cleanup-kit-stop', () => kit.stop()); }
    catch (error) { cleanupFailure ??= error; }
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGTERM');
      const timer = setTimeout(() => child!.kill('SIGKILL'), 5000);
      try { await step('cleanup-child-exit', () => exited); } finally { clearTimeout(timer); }
    }
    site.closeAllConnections();
    await step('cleanup-site-close', () => new Promise<void>(resolve => site.close(() => resolve())));
    await step('cleanup-model-close', () => model.close());
    assert.equal(hash(entry), before, 'stock executable untouched');
    const receipt = { engine: '2026.8.1', upstreamCommit: 'ea806575e6450e4d1efdfc72c19f04be982a1b9b', stockEntry: before,
      shippedPlugin: hash(new URL('../../plugin/index.js', import.meta.url).pathname), requests, outputs, toolEvents,
      providerRequests: model.calls.length, modelCalls: model.calls, brokerTokenDigests: brokerTokens,
      brokerCapabilityHistory: [...capabilities.values()], privacyChecks,
      protectedHandoffQualified: false, observationOnly, counterfactual, diagnostics, thumbnails, runtimeRefusals,
      matrix, siteRequests, cleanupFailure: cleanupFailure ? String(cleanupFailure) : undefined,
      candidateSources: Object.fromEntries(['kit.ts', 'config.ts', 'browser/host.ts', 'browser/broker.ts'].map(path =>
        [path, hash(new URL(`../../src/${path}`, import.meta.url).pathname)])),
      limits: ['no protected production handoff', 'no recovery-turn refusal qualification', 'no private secret/profile scan in this kit test; broker test owns that matrix'] };
    if (process.env.BYOKIT_BROWSER_RECEIPT) writeFileSync(process.env.BYOKIT_BROWSER_RECEIPT, JSON.stringify(receipt, null, 2), { mode: 0o600 });
    const logs = process.env.BYOKIT_BROWSER_RECEIPT ? `${process.env.BYOKIT_BROWSER_RECEIPT}.stock.log` : undefined;
    if (logs && existsSync(join(stateDir, 'stock-engine.log'))) writeFileSync(logs, readFileSync(join(stateDir, 'stock-engine.log')));
    if (logs && existsSync(join(stateDir, 'chromium.stderr'))) writeFileSync(`${logs}.chromium`, readFileSync(join(stateDir, 'chromium.stderr')));
    if (cleanupFailure) throw cleanupFailure; // Keep owned state; capture/teardown failure cannot become a pass.
    emit({ stage: 'cleanup-state-remove', phase: 'start', at: Date.now() });
    rmSync(stateDir, { recursive: true, force: true });
    emit({ stage: 'cleanup-state-remove', phase: 'end', at: Date.now() });
  }
});
