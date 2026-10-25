// K2 (docs/runtime-kits.md 5.15, design report 4 K2): on the pinned engine every piece of a native account's work runs
// in that account's own folder. The two accounts are added the way an app adds them (a kit whose gateway is the offline
// test double, so no engine or network is needed to sign in); the same state dir then boots the real pinned engine, and
// each launch, resumed session and detection probe must use that account's folder — never its sibling's, never the
// person's installed login — with another provider's key kept out of the child. Runs only in the engine job
// (npm run test:engine), never in npm test.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OpenClawKit } from '../../src/kit.ts';
import { Engine } from '../../src/engine.ts';
import { fakeGateway } from '../../src/testing/fake-gateway.ts';
import { scratchDir, sharedEngineDir } from '../../../test-support.ts';
import { NATIVE_ENV_VAR, nativeEnvPath } from '../../src/native-env.ts';
import type { SignInView } from '../../src/types.ts';

const POLICY = { authChoice: 'anthropic-cli', credentialPolicy: 'in-place' } as const;
const install = realpathSync(scratchDir('k2-engine-native'));
const engineDir = sharedEngineDir() ?? join(install, 'engine');

before(async () => {
  // Install the pin once; the case reuses it with a fresh state dir (the O11 run.test.ts pattern).
  const bootstrap = new Engine({ stateDir: join(install, 'bootstrap'), engineDir, pluginId: 'byokit',
    tools: [], spawnEngine: true, onState: () => {}, onExit: () => {} });
  await bootstrap.prepare();
}, { timeout: 600_000 });

test('native accounts: each launch, reuse and probe uses its own folder; a limit rests only that account', { timeout: 600_000 }, async () => {
  const dir = realpathSync(scratchDir('k2-native-runs')), home = join(dir, 'home'), bin = join(dir, 'bin');
  const calls = join(dir, 'calls.jsonl'), stateDir = join(dir, 'state'), root = join(stateDir, 'openclaw');
  mkdirSync(home, { recursive: true }); mkdirSync(bin);
  // The stand-in Claude Code: a login per CLAUDE_CONFIG_DIR, a bounded JSON status, and a stream-json turn. It records the
  // folder and any conflicting provider key it was given, so the proof is what the child saw, not what the kit meant.
  writeFileSync(join(bin, 'claude'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const argv = process.argv.slice(2), cwd = process.env.CLAUDE_CONFIG_DIR, granted = path.join(cwd || '/nonexistent', 'granted');
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ argv, configDir: cwd,
  openrouter: Boolean(process.env.OPENROUTER_API_KEY), openaiBase: process.env.OPENAI_BASE_URL }) + '\\n');
if (argv[0] === 'auth' && argv[1] === 'status') {
  // The managed probe is a bare auth status and reads JSON; the seam asks --json; --text is the person's wording.
  const signedIn = fs.existsSync(granted);
  if (argv.includes('--text')) { console.log(signedIn ? 'Login method: Claude Max Account' : 'Not signed in'); if (!signedIn) process.exit(1); }
  else console.log(JSON.stringify({ loggedIn: signedIn, authMethod: 'claude.ai', subscriptionType: 'max' }));
  process.exit(0);
}
if (argv[0] === 'auth' && argv[1] === 'login') {
  console.log('If the browser did not open, visit: https://claude.example.test/authorize');
  process.stdin.setEncoding('utf8');
  process.stdin.once('data', (code) => { fs.writeFileSync(granted, code.trim()); process.exit(0); });
  return;
}
if (argv[0] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }
// A real Claude Code announces its session, then answers each user message. The engine sends one turn either as a
// stream-json line or as plain text on stdin, so answer the first user line, or once a plain prompt falls quiet.
const reply = () => {
  if (fs.existsSync(path.join(cwd, 'limit'))) {
    console.log(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true,
      result: "You've hit your usage limit. Try again in 3h." }));
    process.exit(0);
  }
  console.log(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello Umer' }] } }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Hello Umer' }));
  process.exit(0);
};
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: path.basename(cwd || '/nonexistent'), tools: [] }));
let rest = '', answered = false, quiet;
const answer = () => { if (answered) return; answered = true; clearTimeout(quiet); reply(); };
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  if (!/^\\s*\\{/.test(chunk)) { clearTimeout(quiet); quiet = setTimeout(answer, 300); return; }
  rest += chunk;
  for (let at = rest.indexOf('\\n'); at >= 0; at = rest.indexOf('\\n')) {
    const line = rest.slice(0, at); rest = rest.slice(at + 1);
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    // The stream-json session is initialized by a control request: answer it, then answer the user turn.
    if (message.type === 'control_request') {
      console.log(JSON.stringify({ type: 'control_response', response: { subtype: 'success',
        request_id: message.request_id, response: {} } }));
      continue;
    }
    if (message.type === 'user') answer();
  }
});
process.stdin.on('end', answer);
`, { mode: 0o700 });
  const saved = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY, OPENAI_BASE_URL: process.env.OPENAI_BASE_URL };
  process.env.HOME = home;
  // A conflicting billing key in the kit's own environment must never reach a native child (the K2 env rule).
  process.env.OPENROUTER_API_KEY = 'sk-or-conflict-must-not-reach-the-child';
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1';
  delete process.env.CLAUDE_CONFIG_DIR;
  const table = () => JSON.parse(readFileSync(nativeEnvPath(root), 'utf8')) as { v: number; accounts: Record<string, { cli: string; dir: string }> };
  const log = () => readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as
    { argv: string[]; configDir?: string; openrouter: boolean; openaiBase?: string });
  const index = () => JSON.parse(readFileSync(join(root, 'accounts', 'm1.json'), 'utf8')) as
    { accounts: Record<string, { agent: string; name: string; native?: { cliAccountId: string } }> };
  // The folder of each account, read from the login the fake CLI wrote into it (the row's own directory, not a guess).
  const folders = () => new Map(readdirSync(join(root, 'native', 'claude'))
    .flatMap((id) => { try { return [[readFileSync(join(root, 'native', 'claude', id, 'granted'), 'utf8'), join(root, 'native', 'claude', id)] as [string, string]]; } catch { return []; } }));
  let kit: OpenClawKit | undefined;
  try {
    // 1. Two accounts, added through the kit with the offline gateway: each gets its own row, folder and login (K1).
    const fake = fakeGateway();
    const adding = new OpenClawKit({ stateDir, enginePath: [bin], spawnEngine: false, callbackPort: 0,
      transport: (ctx) => fake.factory(ctx) });
    const signedIn = async (name: string) => {
      const seen: SignInView[] = [];
      const handle = await adding.addAccount('m1', { ...POLICY, name }, (view) => seen.push(view));
      for (let waited = 0; !seen.some((view) => view.url) && waited < 600; waited++) await new Promise((r) => setTimeout(r, 50));
      handle.paste(name);
      const result = await handle.done;
      assert.equal(result.view.state, 'done', `the add of ${name} finished: ${JSON.stringify(result.view)}`);
      return result.id;
    };
    await adding.start();
    const idA = await signedIn('Claude — Work'), idB = await signedIn('Claude — Home');
    await adding.stop();
    const rows = index().accounts;
    const a = { id: idA, agent: rows[idA]!.agent, name: rows[idA]!.name, folder: folders().get('Claude — Work')! };
    const b = { id: idB, agent: rows[idB]!.agent, name: rows[idB]!.name, folder: folders().get('Claude — Home')! };
    assert.ok(a.folder && b.folder && a.folder !== b.folder, 'two accounts, two folders');

    // 2. The same state dir on the real pinned engine: the agents the gateway never got, then the binding table.
    kit = new OpenClawKit({ stateDir, engineDir, enginePath: [bin], callbackPort: 0, tools: [] });
    await kit.start();
    const workspace = (await kit.call('agents.list', {}) as { agents: { id: string; workspace?: string }[] }).agents.find((row) => row.id === 'm1')?.workspace
      ?? join(root, 'state', 'workspace');
    for (const row of [a, b]) {
      const made = await kit.call('agents.create', { name: row.agent, workspace }) as { agentId?: string };
      assert.equal(made.agentId, row.agent);
    }
    // The roster hot-reload applies a beat after the create answer (accounts.ts waits the same way).
    for (let waited = 0; waited < 100; waited++) {
      const roster = ((await kit.call('agents.list', {})) as { agents: { id: string }[] }).agents.map((row) => row.id);
      if ([a.agent, b.agent].every((agent) => roster.includes(agent))) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(kit.doctorContext().env[NATIVE_ENV_VAR], nativeEnvPath(root), 'the gateway is told where the binding table is');
    assert.deepEqual((await kit.accounts('m1')).map((row) => [row.id, row.state, row.native]),
      [[a.id, 'ready', true], [b.id, 'ready', true]], 'both bound rows read ready through their own folders');
    const published = table().accounts;
    assert.equal(table().v, 1);
    assert.deepEqual(Object.keys(published).sort(), [a.agent, b.agent].sort(), 'one row per bound account agent, nothing else');
    assert.equal(published[a.agent]!.cli, 'claude');
    assert.equal(published[a.agent]!.dir, a.folder);
    assert.equal(published[b.agent]!.dir, b.folder, 'each row names that account\'s own folder');

    // 3. Execution: each run launches in its own account's folder with no conflicting billing key.
    const endA = await kit.run({ member: 'm1', sessionKey: 'agent:m1:native:k2-a', account: a.id, message: 'Say hello' });
    assert.ok(endA.ok, JSON.stringify(endA));
    assert.equal(endA.text, 'Hello Umer');
    const endB = await kit.run({ member: 'm1', sessionKey: 'agent:m1:native:k2-b', account: b.id, message: 'Say hello' });
    assert.ok(endB.ok, JSON.stringify(endB));
    const runs = () => log().filter((call) => call.argv[0] !== 'auth' && call.argv[0] !== '--version');
    assert.equal(runs().length, 2, `one launch per run: ${JSON.stringify(log().map((call) => call.argv))}`);
    assert.deepEqual(new Set(runs().map((call) => call.configDir)), new Set([a.folder, b.folder]), 'each launch carried its own folder');
    for (const call of runs()) {
      assert.equal(call.openrouter, false, 'a native child never inherits another provider\'s key');
      assert.notEqual(call.openaiBase, 'https://api.openai.com/v1', 'a native child never inherits another billing endpoint');
    }

    // 4. Reuse: the second turn of a session stays in the same account's folder.
    const again = await kit.run({ member: 'm1', sessionKey: 'agent:m1:native:k2-a', account: a.id, message: 'Once more' });
    assert.ok(again.ok, JSON.stringify(again));
    assert.equal(runs().at(-1)!.configDir, a.folder, 'a reused session keeps its account\'s folder');

    // 5. A limit is that account's: the sibling's folder, state and next turn are untouched.
    writeFileSync(join(a.folder, 'limit'), 'limited');
    const limited = await kit.run({ member: 'm1', sessionKey: 'agent:m1:native:k2-a', account: a.id, message: 'Say hello' });
    assert.ok(!limited.ok && 'kind' in limited && limited.kind === 'resting', JSON.stringify(limited));
    assert.ok(!limited.ok && 'until' in limited && typeof limited.until === 'number', 'the reset time is carried');
    assert.deepEqual((await kit.accounts('m1')).map((row) => [row.id, row.state]), [[a.id, 'resting'], [b.id, 'ready']],
      'only the account that hit the limit rests');
    const stillB = await kit.run({ member: 'm1', sessionKey: 'agent:m1:native:k2-b2', account: b.id, message: 'Say hello' });
    assert.ok(stillB.ok, JSON.stringify(stillB));
    assert.equal(runs().at(-1)!.configDir, b.folder);

    // 6. Detection: the engine's own probe for that account's agent asks that account's folder, never the installed login.
    const detected = await kit.call('openclaw.setup.detect', { agentId: b.agent }, { timeoutMs: 60_000 }) as
      { candidates?: { kind?: string; credentials?: boolean }[] };
    assert.ok(detected.candidates?.some((candidate) => candidate.kind === 'claude-cli' && candidate.credentials === true),
      `detection saw that account's login: ${JSON.stringify(detected.candidates)}`);
    assert.equal(log().filter((call) => call.argv.join(' ') === 'auth status --json').at(-1)!.configDir, b.folder,
      'the probe for an account agent used that account\'s folder');

    // 7. Removal drops that account's row: no later launch or probe may reach its folder.
    await kit.removeAccount('m1', b.id);
    assert.deepEqual(Object.keys(table().accounts), [a.agent], 'the removed account\'s row is gone');
  } finally {
    await kit?.stop().catch(() => {});
    for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});
