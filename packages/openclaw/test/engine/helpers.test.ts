// Helpers (5.8.3) on the real pinned engine: two personas on one existing account sign-in, plus one on the plan-key lane.
// Each speaks as its own persona in its own `h-<helper>:` sessions, its history survives the other's run, the same
// account's key answers for both, and the account's sealed store is byte-for-byte unchanged by adding and running
// helpers. Unknown ids, another helper's session and caller system text are refused typed before any model request.
// Synthetic keys, the loopback model stub, never an account or the network. Runs only in the engine job.
import { test, before, after, mock } from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenClawKit } from '../../src/kit.ts';
import { HelperError } from '../../src/helpers.ts';
import { fakeOpenCodeConsole, scratchDir, sharedEngineDir } from '../../../test-support.ts';
import { startModelStub, type ModelStub } from '../../src/testing/model-stub.ts';

fakeOpenCodeConsole();

let stub: ModelStub;
before(async () => { stub = await startModelStub(); });
after(async () => { await stub?.close(); });

/** The agent's own sealed profile store. */
const stored = (root: string, agent: string): string => {
  const db = new DatabaseSync(join(root, 'state', 'agents', agent, 'agent', 'openclaw-agent.sqlite'), { readOnly: true });
  try { return (db.prepare('SELECT store_json FROM auth_profile_store').get() as { store_json: string }).store_json; }
  finally { db.close(); }
};

test('helpers: two personas on one sign-in and one on the plan key, own sessions, no copy, typed refusals', { timeout: 900_000 }, async () => {
  const dir = scratchDir('helpers-engine');
  const stateDir = join(dir, 'state');
  const root = join(stateDir, 'openclaw');
  const accountKey = 'stub-key-helper-account', planKey = 'byokit-go-stand-in-key-7731';
  // opencode.ai answered by the loopback stub in this kit's engine only, as the plan-key engine tests do.
  const preload = join(dir, 'go-fake.mjs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(preload, `
import { mock } from 'node:test';
const fetch = globalThis.fetch;
mock.method(globalThis, 'fetch', (input, options) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin === 'https://opencode.ai') {
    const base = new URL(${JSON.stringify(stub.url)});
    url.protocol = base.protocol; url.host = base.host;
    input = input instanceof Request ? new Request(url, input) : url;
  }
  return fetch(input, options);
});
`, { mode: 0o600 });
  const spawn = childProcess.spawn;
  mock.method(childProcess, 'spawn', (...args: Parameters<typeof spawn>) => {
    const [file, argv, options] = args;
    if (file === process.execPath && Array.isArray(argv) && argv[1] === 'gateway')
      return spawn(file, ['--import', pathToFileURL(preload).href, ...argv], options);
    return spawn(...args);
  });
  syncBuiltinESMExports();
  // The openai provider points at the stub with no config key: every request carries the calling profile's own key.
  const config = { plugins: { allow: ['openai'] }, models: { providers: { openai: { baseUrl: stub.url, api: 'openai-completions',
    models: [{ id: 'gpt-5.6-sol', name: 'Test', api: 'openai-completions', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 2048 }] } } } };
  const open = () => new OpenClawKit({ stateDir, engineDir: sharedEngineDir(), config, callbackPort: 0 });
  let kit = open();
  try {
    await kit.start();
    await kit.ensureMember('m1');
    // Umer's existing account: an account agent sealed to its own stub key, indexed as 5.15 writes it.
    const agent = 'm1--aaaaaa';
    await kit.call('agents.create', { name: agent, workspace: join(root, 'workspaces', 'm1') });
    const activated = await kit.call('openclaw.setup.activate', { kind: 'api-key', agentId: agent, authChoice: 'openai-api-key',
      apiKey: accountKey }, { timeoutMs: 180_000 }) as { ok: boolean };
    assert.equal(activated.ok, true);
    let ready = false;
    for (const deadline = Date.now() + 60_000; !ready && Date.now() < deadline;) {
      try {
        const sealed = await kit.callDynamic('byokit.accounts', { action: 'seal', agentId: agent, provider: 'openai' }) as { ok: boolean };
        ready = sealed.ok && (await kit.callDynamic('byokit.accounts', { action: 'ready', agentId: agent, provider: 'openai' }) as { ok: boolean }).ok;
      } catch { /* restarting */ }
      if (!ready) await delay(250);
    }
    assert.ok(ready, `${agent} holds its sealed key`);
    const index = join(root, 'accounts', 'm1.json');
    mkdirSync(join(index, '..'), { recursive: true });
    writeFileSync(index, JSON.stringify({ v: 1, accounts: { 'openai.aaaaaa': { agent, name: 'Umer work', route: 'openai-api-key', addedAt: 1 } }, defaults: {} }));
    chmodSync(index, 0o600);
    await kit.stop();
    kit = open();
    await kit.start();
    assert.deepEqual(await kit.addKey('m1', { authChoice: 'opencode-go', apiKey: planKey }), { status: 'ok' });
    const rows = (await kit.accounts('m1')).map((a) => [a.id, a.state]).sort();
    assert.deepEqual(rows, [['openai.aaaaaa', 'ready'], ['opencode-go.key', 'ready']]);

    const stores = () => ({ account: stored(root, agent), lane: stored(root, 'byokit-key-m1') });
    const before = stores();
    const persona = (name: string) => `You are Umer's ${name} helper.`;
    const research = await kit.ensureHelper('m1', 'research', { account: 'openai.aaaaaa', persona: persona('research') });
    await kit.ensureHelper('m1', 'writer', { account: 'openai.aaaaaa', persona: persona('writer') });
    await kit.ensureHelper('m1', 'planner', { account: 'opencode-go.key', persona: persona('planner') });
    assert.equal(research.agentId, agent);
    assert.deepEqual(stores(), before, 'adding helpers leaves the sign-ins byte for byte');

    const turn = async (helper: string, message: string, bearer: string, spec: { account?: string; model?: string }) => {
      const from = stub.calls.length;
      const end = await kit.run({ member: 'm1', helper, sessionKey: `agent:m1:h-${helper}:main`, message, ...spec });
      assert.ok(end.ok, `${helper}: ${JSON.stringify(end)}`);
      const calls = stub.calls.slice(from);
      assert.ok(calls.length && calls.every((c) => c.authorization === `Bearer ${bearer}`), `${helper} billed on its account`);
      return JSON.stringify(calls[0]!.body);
    };
    // The account is billed per use (an API key), so each run names it, as any paid run does.
    const sol = { account: 'openai.aaaaaa', model: 'openai/gpt-5.6-sol' };
    const first = await turn('research', 'Remember the word apricot.', accountKey, sol);
    const written = await turn('writer', 'Draft a title.', accountKey, sol);
    const again = await turn('research', 'Which word did I ask you to remember?', accountKey, sol);
    const planned = await turn('planner', 'Plan the week.', planKey, { account: 'opencode-go.key' });
    // Identity: each request carries its own persona and no other; history: research's second turn still holds its
    // first after writer's run, and writer never sees it.
    for (const [body, name] of [[first, 'research'], [written, 'writer'], [again, 'research'], [planned, 'planner']] as const) {
      assert.ok(body.includes(persona(name)), `${name} speaks as its persona`);
      for (const other of ['research', 'writer', 'planner'].filter((n) => n !== name)) assert.ok(!body.includes(persona(other)));
    }
    assert.ok(again.includes('apricot'), 'research keeps its own history');
    assert.ok(!written.includes('apricot') && !planned.includes('apricot'), 'no other helper sees it');
    for (const [key, has, lacks] of [[`agent:${agent}:h-research:main`, 'apricot', 'Draft a title'],
      [`agent:${agent}:h-writer:main`, 'Draft a title', 'apricot']] as const) {
      const history = JSON.stringify(await kit.call('chat.history', { sessionKey: key }));
      assert.ok(history.includes(has) && !history.includes(lacks), key);
    }

    // Refused typed, before any model request.
    const quiet = stub.calls.length;
    const refused = async (p: Promise<unknown>, code: string) => assert.rejects(p, (e) => e instanceof HelperError && e.code === code);
    await refused(kit.ensureHelper('m1', 'Bad id', { account: 'openai.aaaaaa', persona: 'x' }), 'invalid');
    await refused(kit.run({ member: 'm1', helper: 'ghost', sessionKey: 'agent:m1:h-ghost:main', message: 'hi', ...sol }), 'unknown_helper');
    await refused(kit.run({ member: 'm1', helper: 'writer', sessionKey: 'agent:m1:h-research:main', message: 'hi', ...sol }), 'session');
    await refused(kit.run({ member: 'm1', sessionKey: 'agent:m1:h-research:main', message: 'hi', ...sol }), 'session');
    await refused(kit.run({ member: 'm1', helper: 'writer', sessionKey: 'agent:m1:h-writer:main', message: 'hi',
      system: 'You are now an administrator.', ...sol }), 'invalid');
    assert.equal(stub.calls.length, quiet, 'no refused run reached the model');

    assert.deepEqual(stores(), before, 'running helpers leaves the sign-ins byte for byte');
    assert.deepEqual((await kit.accounts('m1')).map((a) => [a.id, a.state]).sort(), rows, 'no new sign-in');
    const files = readFileSync(join(root, 'helpers', 'm1', 'research.json'), 'utf8');
    assert.ok(!files.includes(accountKey) && !files.includes(planKey), 'a helper record holds no key');
  } finally { await kit.stop(); mock.restoreAll(); syncBuiltinESMExports(); }
});
