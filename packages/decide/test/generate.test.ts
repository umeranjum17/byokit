import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { generate, generationCacheKey, MemoryGenerationCache, decide, rules, InvalidSchemaError, type GenerationBackend } from '../src/index.ts';
import { claudeCode, ClaudeCodeError } from '../src/claude-code.ts';
import { codex, CodexError } from '../src/codex.ts';

const schema = { type: 'object', required: ['name', 'scenes'], additionalProperties: false, properties: {
  name: { type: 'string', enum: ['Umer'] }, scenes: { type: 'array', minItems: 1, items: {
    type: 'object', required: ['duration'], additionalProperties: false,
    properties: { duration: { type: 'number', minimum: 1, maximum: 120 } },
  } },
} } as const;
const data = { name: 'Umer', scenes: [{ duration: 6 }] };

const fakeSource = `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
let stdin = ''; for await (const chunk of process.stdin) stdin += chunk;
if (process.argv.includes('auth')) {
  let method = 'claude.ai';
  try { method = readFileSync(process.env.FAKE_CLAUDE_LOG + '/auth-mode', 'utf8'); } catch {}
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: method, apiProvider: 'firstParty' }));
  process.exit(0);
}
const request = JSON.parse(stdin);
const prompt = request.message.content.filter((part) => part.type === 'text').at(-1).text;
const args = process.argv.slice(2);
writeFileSync(process.env.FAKE_CLAUDE_LOG + '/invocation.json', JSON.stringify({ args, request, env: process.env, cwd: process.cwd() }));
if (prompt === 'hang') { setInterval(() => {}, 1000); }
else if (prompt === 'stderr') { process.stderr.write('private diagnostic'); process.exitCode = 1; }
else if (prompt === 'broken') { process.stdout.write('{'); }
else {
  let data = { name: 'Umer', scenes: [{ duration: 6 }] };
  if (prompt === 'partial') data = { name: 'Umer' };
  if (prompt.startsWith('{')) {
    const input = JSON.parse(prompt);
    if (input.questions) data = Object.fromEntries(Object.entries(input.questions).map(([k, q]) => {
      if (q.kind === 'rank') {
        const ranking = Object.keys(q.candidates).reverse();
        return [k, { ranking, confidence: 0.9, scores: Object.fromEntries(ranking.map((id, i) => [id, 10 - i])),
          ...(q.personReason && { personReason: 'The first candidate adds useful context for Umer.' }) }];
      }
      const keys = q.kind === 'choice' ? Object.keys(q.options) : q.kind === 'yesno' ? ['true', 'false'] : q.levels.map((_, i) => String(i));
      return [k, { probabilities: Object.fromEntries(keys.map((key, i) => [key, i === 0 ? 0.9 : 0.1 / (keys.length - 1)])), pick: keys[0],
        ...(q.personReason && { personReason: 'This is ready for Umer.' }) }];
    }));
  }
  process.stdout.write(JSON.stringify({ type: 'result', subtype: prompt === 'incomplete' ? 'error_max_turns' : 'success',
    is_error: prompt === 'incomplete', structured_output: data, result: 'Complete.', usage: { input_tokens: 17, output_tokens: 29 } }));
}
`;

test('Claude binary seam: the person\'s own sign-in, structured generation, scalar decisions and fixed failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'byokit-decide-generate-'));
  const configDir = join(root, 'host-config');
  const logDir = join(root, 'fake-log');
  const ambient = join(root, 'ambient-config');
  const decoyHome = join(root, 'ambient-home');
  const homeClaude = join(decoyHome, '.claude');
  const previousHome = process.env.HOME;
  const previousConfig = process.env.CLAUDE_CONFIG_DIR;
  const previousKey = process.env.ANTHROPIC_API_KEY;
  const previousOAuth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const previousAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const previousBedrock = process.env.CLAUDE_CODE_USE_BEDROCK;
  try {
    await mkdir(configDir);
    await mkdir(logDir);
    await mkdir(ambient);
    await mkdir(homeClaude, { recursive: true });
    await writeFile(join(homeClaude, 'byokit-test-canary'), 'unchanged');
    await writeFile(join(ambient, 'canary'), 'unchanged');
    await writeFile(join(configDir, '.credentials.json'), 'the fake never opens this');
    const before = await readdir(homeClaude);
    const bin = join(root, 'fake-claude');
    await writeFile(bin, fakeSource, { mode: 0o700 });
    process.env.HOME = decoyHome;
    process.env.CLAUDE_CONFIG_DIR = ambient;
    process.env.ANTHROPIC_API_KEY = 'never-reaches-the-binary';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'subscription-token';
    process.env.ANTHROPIC_AUTH_TOKEN = 'api-token';
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    process.env.FAKE_CLAUDE_LOG = logDir;
    const backend = claudeCode({ bin, model: 'chosen-model', timeoutMs: 5000 });
    assert.equal(backend.billing, 'subscription');
    const result = await backend.generate({ system: 'Make a storyboard.', prompt: 'normal', schema });
    assert.deepEqual(result.data, data);
    assert.deepEqual(result.usage, { input_tokens: 17, output_tokens: 29 });
    const log = JSON.parse(await readFile(join(logDir, 'invocation.json'), 'utf8'));
    const arg = (flag: string) => log.args[log.args.indexOf(flag) + 1];
    assert.equal(log.args[0], '-p');
    assert.equal(arg('--output-format'), 'stream-json');
    assert.equal(arg('--input-format'), 'stream-json');
    assert.ok(log.args.includes('--verbose'));
    assert.equal(arg('--tools'), '');
    assert.equal(arg('--disallowedTools'), 'mcp__*');
    assert.equal(arg('--mcp-config'), '{"mcpServers":{}}');
    assert.equal(arg('--setting-sources'), '');
    assert.ok(log.args.includes('--safe-mode'));
    assert.ok(log.args.includes('--no-session-persistence'));
    assert.equal(JSON.parse(arg('--settings')).forceLoginMethod, 'claudeai');
    assert.deepEqual(JSON.parse(arg('--json-schema')), schema);
    assert.equal(arg('--model'), 'chosen-model');
    assert.equal(log.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '16384');
    // The person's own HOME and PATH, and no kit-owned sign-in folder.
    assert.equal(log.env.HOME, decoyHome);
    assert.equal(log.env.PATH, process.env.PATH);
    assert.equal(log.env.CLAUDE_CONFIG_DIR, ambient);
    assert.notEqual(log.cwd, process.cwd());
    assert.equal(log.env.CLAUDE_CODE_OAUTH_TOKEN, 'subscription-token');
    assert.equal('ANTHROPIC_AUTH_TOKEN' in log.env, false);
    assert.equal('CLAUDE_CODE_USE_BEDROCK' in log.env, false);
    assert.deepEqual(Object.keys(log.env).filter((k: string) => /KEY|TOKEN|SECRET|NODE_OPTIONS/.test(k) && k !== 'CLAUDE_CODE_MAX_OUTPUT_TOKENS' && k !== 'CLAUDE_CODE_OAUTH_TOKEN'), []);
    await assert.rejects(readFile(join(log.cwd, 'any')), { code: 'ENOENT' });
    // A host-passed config directory is set as given, over the ambient one.
    process.env.CLAUDE_CONFIG_DIR = ambient;
    await claudeCode({ bin, configDir, timeoutMs: 5000 }).generate({ prompt: 'normal', schema });
    const configLog = JSON.parse(await readFile(join(logDir, 'invocation.json'), 'utf8'));
    assert.equal(configLog.env.CLAUDE_CONFIG_DIR, configDir);
    assert.equal(configLog.env.HOME, decoyHome);
    assert.deepEqual(await readdir(homeClaude), before);
    assert.equal(await readFile(join(homeClaude, 'byokit-test-canary'), 'utf8'), 'unchanged');
    assert.deepEqual(await readdir(ambient), ['canary']);
    assert.equal(await readFile(join(ambient, 'canary'), 'utf8'), 'unchanged');
    assert.equal(await readFile(join(configDir, '.credentials.json'), 'utf8'), 'the fake never opens this');
    const image = { id: 'Umer-design', mime: 'image/png', bytes: new Uint8Array([137, 80, 78, 71]) };
    await backend.generate({ prompt: 'normal', schema, images: [image] });
    const imageLog = JSON.parse(await readFile(join(logDir, 'invocation.json'), 'utf8'));
    assert.deepEqual(imageLog.request.message.content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw==' } });
    assert.equal(imageLog.request.message.content[0].text, 'Image: Umer-design');
    await backend.generate({ prompt: 'normal', schema, images: [{ id: 'Umer-jpeg', mime: 'image/jpg', dataUrl: 'data:image/jpg;base64,/9j/2Q==' }] });
    const jpegLog = JSON.parse(await readFile(join(logDir, 'invocation.json'), 'utf8'));
    assert.equal(jpegLog.request.message.content[1].source.media_type, 'image/jpeg');
    await assert.rejects(backend.generate({ prompt: 'normal', schema, images: [{ ...image, mime: 'image/webp' }] }), { name: 'InvalidImageError' });
    const answers = await decide({ name: 'Umer' }, {
      choice: { kind: 'choice', images: ['Umer-design'], options: { keep: 'Keep it', drop: 'Drop it' } },
      yesno: { kind: 'yesno', question: 'Keep it?', personReason: true },
      score: { kind: 'score', levels: ['Good', 'Poor'] },
    }, { privacy: 'may-leave', backends: [backend], images: [image] });
    assert.deepEqual(Object.values(answers).map((a) => a.answer), ['keep', true, 0]);
    assert.equal(answers.choice.confidenceSource, 'self-reported');
    assert.equal(answers.choice.personReason, undefined);
    assert.equal(answers.yesno.personReason, 'This is ready for Umer.');
    const privateNote = 'rules-only-note-for-Umer';
    const scoped = await decide({ privateNote }, {
      local: { kind: 'yesno', question: 'Local?', state: privateNote, backends: ['rules'] },
      ordered: { kind: 'rank', candidates: { a: 'Question', b: 'Context' }, state: { name: 'Umer' }, personReason: true },
    }, { privacy: 'may-leave', backends: [backend, rules((state) => state === privateNote)], images: [image] });
    assert.deepEqual(scoped.ordered.answer, ['b', 'a']);
    assert.deepEqual(scoped.ordered.scores, { b: 10, a: 9 });
    assert.equal(scoped.ordered.personReason, 'The first candidate adds useful context for Umer.');
    assert.equal(scoped.local.answer, true);
    const rankLog = JSON.parse(await readFile(join(logDir, 'invocation.json'), 'utf8'));
    assert.equal(JSON.stringify(rankLog.request).includes(privateNote), false);
    const rankSchema = JSON.parse(rankLog.args[rankLog.args.indexOf('--json-schema') + 1]);
    assert.deepEqual(rankSchema.properties.ordered.required, ['ranking', 'confidence', 'personReason']);
    assert.equal(rankLog.request.message.content[1].type, 'image');
    const cache = new MemoryGenerationCache();
    const first = await generate<typeof data>({ state: { name: 'Umer' } }, schema, { backends: [backend], cache });
    const second = await generate<typeof data>({ state: { name: 'Umer' } }, schema, { backends: [backend], cache });
    assert.deepEqual(first.data, data);
    assert.equal(second.source, 'cache');
    assert.equal(cache.size, 1);
    const imageFirst = await generate<typeof data>({ state: { name: 'Umer' }, images: [image] }, schema, { backends: [backend], cache });
    const imageSecond = await generate<typeof data>({ state: { name: 'Umer' }, images: [image] }, schema, { backends: [backend], cache });
    assert.deepEqual(imageFirst.data, data);
    assert.equal(imageSecond.source, 'cache');
    assert.equal(cache.size, 2);
    for (const [prompt, code] of [['broken', 'invalid_json'], ['partial', 'invalid_output'], ['incomplete', 'incomplete'], ['stderr', 'process']] as const) {
      await assert.rejects(backend.generate({ prompt, schema }), (error: unknown) => error instanceof ClaudeCodeError && error.code === code && !error.message.includes('private diagnostic'));
    }
    await writeFile(join(logDir, 'auth-mode'), 'api_key');
    const beforeRefusal = await readFile(join(logDir, 'invocation.json'), 'utf8');
    await assert.rejects(backend.generate({ prompt: 'normal', schema }), (e: unknown) => e instanceof ClaudeCodeError && e.code === 'subscription_required');
    assert.equal(await readFile(join(logDir, 'invocation.json'), 'utf8'), beforeRefusal, 'wrong billing route never reaches generation');
    await rm(join(logDir, 'auth-mode'));
    const short = claudeCode({ bin, timeoutMs: 100 });
    await assert.rejects(short.generate({ prompt: 'hang', schema }), (e: unknown) => e instanceof ClaudeCodeError && e.code === 'timeout');
    const controller = new AbortController();
    const pending = backend.generate({ prompt: 'hang', schema, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(pending, (e: unknown) => e instanceof ClaudeCodeError && e.code === 'aborted');
    const missing = claudeCode({ bin: join(root, 'not-installed'), timeoutMs: 100 });
    await assert.rejects(missing.generate({ prompt: 'normal', schema }), ClaudeCodeError);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfig;
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
    if (previousOAuth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = previousOAuth;
    if (previousAuthToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = previousAuthToken;
    if (previousBedrock === undefined) delete process.env.CLAUDE_CODE_USE_BEDROCK;
    else process.env.CLAUDE_CODE_USE_BEDROCK = previousBedrock;
    delete process.env.FAKE_CLAUDE_LOG;
    await rm(join(homeClaude, 'byokit-test-canary'), { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('the installed Claude from the accounts list decides with the person\'s HOME and no CLAUDE_CONFIG_DIR; a managed account keeps its folder', async () => {
  const { cliAccounts } = await import('@byokit/accounts/cli');
  const root = await mkdtemp(join(tmpdir(), 'byokit-decide-installed-'));
  const logDir = join(root, 'fake-log');
  const home = join(root, 'home');
  const previous = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  try {
    await mkdir(logDir);
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(join(home, '.claude', '.credentials.json'), 'the fake never opens this');
    const bin = join(root, 'fake-claude');
    await writeFile(bin, fakeSource, { mode: 0o700 });
    process.env.HOME = home;
    delete process.env.CLAUDE_CONFIG_DIR;
    process.env.FAKE_CLAUDE_LOG = logDir;
    const kit = cliAccounts({ stateDir: join(root, 'plans'), bins: { claude: bin }, env: { HOME: home, PATH: process.env.PATH ?? '', FAKE_CLAUDE_LOG: logDir }, installed: true });
    const { account: managed } = await kit.add('claude');
    const rows = await kit.list();
    assert.deepEqual(rows.map((r) => [r.id, r.state]), [[managed.id, 'signing'], ['installed-claude', 'ready']]);
    const launch = await kit.launch('installed-claude');
    assert.ok(launch.ok);
    const answers = await decide({ name: 'Umer' }, { keep: { kind: 'yesno', question: 'Keep it?' } },
      { privacy: 'may-leave', backends: [claudeCode({ bin, account: launch, timeoutMs: 5000 })] });
    assert.equal(answers.keep.answer, true);
    const log = JSON.parse(await readFile(join(logDir, 'invocation.json'), 'utf8'));
    assert.equal(log.env.HOME, home);
    assert.equal('CLAUDE_CONFIG_DIR' in log.env, false);
    await claudeCode({ bin, account: kit.launchEnv(managed.id), timeoutMs: 5000 }).generate({ prompt: 'normal', schema });
    const managedLog = JSON.parse(await readFile(join(logDir, 'invocation.json'), 'utf8'));
    assert.equal(managedLog.env.CLAUDE_CONFIG_DIR, kit.folderOf(managed.id));
    assert.throws(() => claudeCode({ bin, account: launch, configDir: root, timeoutMs: 5000 }), /either a Claude account/);
    assert.throws(() => claudeCode({ bin, account: { set: { CODEX_HOME: root }, unset: [] }, timeoutMs: 5000 }), /either a Claude account/);
    assert.equal(await readFile(join(home, '.claude', '.credentials.json'), 'utf8'), 'the fake never opens this');
  } finally {
    for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    delete process.env.FAKE_CLAUDE_LOG;
    await rm(root, { recursive: true, force: true });
  }
});

const fakeCodexSource = `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const log = process.env.FAKE_CODEX_LOG;
const args = process.argv.slice(2);
if (args[0] === 'app-server') {
  let b = ''; process.stdin.on('data', (c) => { b += c; for (;;) { const i = b.indexOf('\\n'); if (i < 0) break; const r = JSON.parse(b.slice(0, i)); b = b.slice(i + 1);
    console.log(JSON.stringify({ id: r.id, result: r.id === 1 ? {} : { account: { email: 'umer@example.test', planType: 'plus' } } })); } });
} else if (args[0] === 'login') {
  appendFileSync(log + '/calls.jsonl', JSON.stringify(args) + '\\n');
  const mode = existsSync(log + '/auth-mode') ? readFileSync(log + '/auth-mode', 'utf8') : 'chatgpt';
  if (mode === 'out') { process.stderr.write('Not logged in\\n'); process.exitCode = 1; }
  else process.stderr.write(mode === 'api' ? 'Logged in using an API key - sk-proj-***private\\n' : 'Logged in using ChatGPT\\n');
} else {
  appendFileSync(log + '/calls.jsonl', JSON.stringify(args) + '\\n');
  let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
  const schemaFile = args[args.indexOf('--output-schema') + 1];
  const images = args.filter((a) => a.startsWith('--image=')).map((a) => [...readFileSync(a.slice(8))]);
  writeFileSync(log + '/invocation.json', JSON.stringify({ args, prompt, env: process.env, cwd: process.cwd(), schema: JSON.parse(readFileSync(schemaFile, 'utf8')), images }));
  const last = prompt.split('\\n').at(-1);
  if (last === 'hang') setInterval(() => {}, 1000);
  else if (last === 'broken') process.stdout.write('{\\n');
  else if (last === 'failed') console.log(JSON.stringify({ type: 'turn.failed', error: { message: 'private diagnostic' } }));
  else {
    let data = last === 'partial' ? { name: 'Umer' } : { name: 'Umer', scenes: [{ duration: 6 }] };
    if (last.startsWith('{')) {
      const { questions } = JSON.parse(last);
      data = Object.fromEntries(Object.entries(questions).map(([k, q]) => {
        const keys = q.kind === 'choice' ? Object.keys(q.options) : q.kind === 'yesno' ? ['true', 'false'] : q.levels.map((_, i) => String(i));
        return [k, { probabilities: Object.fromEntries(keys.map((key, i) => [key, i === 0 ? 0.9 : 0.1 / (keys.length - 1)])), pick: keys[0], rationale: 'Ready for Umer.' }];
      }));
    }
    for (const event of [{ type: 'thread.started', thread_id: 't' }, { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: JSON.stringify(data) } },
      { type: 'turn.completed', usage: { input_tokens: 17, cached_input_tokens: 0, output_tokens: 29 } }]) console.log(JSON.stringify(event));
  }
}
`;

test('the installed Codex from the accounts list decides on the person\'s ChatGPT plan with their HOME and no CODEX_HOME; a managed account keeps its folder', async () => {
  const { cliAccounts } = await import('@byokit/accounts/cli');
  const root = await mkdtemp(join(tmpdir(), 'byokit-decide-codex-'));
  const logDir = join(root, 'fake-log');
  const home = join(root, 'home');
  const bins = join(root, 'bins');
  const keys = ['HOME', 'PATH', 'CODEX_HOME', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'FAKE_CODEX_LOG'] as const;
  const previous = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    await mkdir(logDir);
    await mkdir(bins);
    await mkdir(join(home, '.codex'), { recursive: true });
    await writeFile(join(home, '.codex', 'auth.json'), 'the fake never opens this');
    const bin = join(bins, 'codex');
    await writeFile(bin, fakeCodexSource, { mode: 0o700 });
    process.env.HOME = home;
    process.env.PATH = `${bins}${delimiter}${process.env.PATH ?? ''}`;
    delete process.env.CODEX_HOME;
    process.env.OPENAI_API_KEY = 'never-reaches-the-binary';
    process.env.OPENAI_BASE_URL = 'http://127.0.0.1:9/never';
    process.env.FAKE_CODEX_LOG = logDir;
    const kit = cliAccounts({ stateDir: join(root, 'plans'), bins: { codex: bin }, env: { HOME: home, PATH: process.env.PATH }, installed: true });
    const { account: managed } = await kit.add('codex');
    const rows = await kit.list();
    assert.deepEqual(rows.map((r) => [r.id, r.state]), [[managed.id, 'signing'], ['installed-codex', 'ready']]);
    const launch = await kit.launch('installed-codex');
    assert.ok(launch.ok);
    assert.deepEqual(launch.set, {});
    const backend = codex({ bin, account: launch, model: 'gpt-6-luna', timeoutMs: 5000 });
    assert.equal(backend.billing, 'subscription');
    const answers = await decide({ name: 'Umer' }, { keep: { kind: 'yesno', question: 'Keep it?' } },
      { privacy: 'may-leave', backends: [backend] });
    assert.equal(answers.keep.answer, true);
    assert.equal(answers.keep.rationale, 'Ready for Umer.');
    const log = JSON.parse(await readFile(join(logDir, 'invocation.json'), 'utf8'));
    const arg = (flag: string) => log.args[log.args.indexOf(flag) + 1];
    assert.equal(log.args[0], 'exec');
    assert.equal(log.args.at(-1), '-');
    assert.equal(arg('--model'), 'gpt-6-luna');
    assert.equal(arg('--sandbox'), 'read-only');
    for (const flag of ['--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check']) assert.ok(log.args.includes(flag), flag);
    for (const c of ['features.shell_tool=false', 'forced_login_method="chatgpt"', 'web_search="disabled"']) assert.ok(log.args.includes(c), c);
    assert.ok(log.args.some((a: string) => a.startsWith('developer_instructions=')));
    assert.deepEqual(log.schema.required, ['keep']);
    assert.deepEqual(JSON.parse(log.prompt).state, { name: 'Umer' });
    // The person's own HOME and PATH, no CODEX_HOME, and no per-use key or base URL.
    assert.equal(log.env.HOME, home);
    assert.equal(log.env.PATH, process.env.PATH);
    assert.equal('CODEX_HOME' in log.env, false);
    assert.equal('OPENAI_API_KEY' in log.env, false);
    assert.equal('OPENAI_BASE_URL' in log.env, false);
    await assert.rejects(readFile(join(log.cwd, 'schema.json')), { code: 'ENOENT' });
    const generated = await codex({ bin, account: kit.launchEnv(managed.id), timeoutMs: 5000 }).generate({ prompt: 'normal', schema,
      images: [{ id: 'Umer-design', mime: 'image/png', bytes: new Uint8Array([137, 80, 78, 71]) }] });
    assert.deepEqual(generated.data, data);
    assert.deepEqual(generated.usage, { input_tokens: 17, output_tokens: 29 });
    const managedLog = JSON.parse(await readFile(join(logDir, 'invocation.json'), 'utf8'));
    assert.equal(managedLog.env.CODEX_HOME, kit.folderOf(managed.id));
    assert.deepEqual(managedLog.images, [[137, 80, 78, 71]]);
    assert.match(managedLog.prompt, /^Images, in attachment order: Umer-design\n/);
    assert.equal(managedLog.args.includes('--model'), false);
    const viaGenerate = await generate<typeof data>({ state: { name: 'Umer' } }, schema, { backends: [backend] });
    assert.deepEqual([viaGenerate.data, viaGenerate.by], [data, 'codex']);
    for (const [prompt, code] of [['broken', 'invalid_json'], ['partial', 'invalid_output'], ['failed', 'process']] as const) {
      await assert.rejects(backend.generate({ prompt, schema }), (e: unknown) => e instanceof CodexError && e.code === code && !e.message.includes('private'));
    }
    await assert.rejects(codex({ bin, timeoutMs: 100 }).generate({ prompt: 'hang', schema }), (e: unknown) => e instanceof CodexError && e.code === 'timeout');
    const execs = async () => (await readFile(join(logDir, 'calls.jsonl'), 'utf8')).split('\n').filter((l) => l.startsWith('["exec"')).length;
    const before = await execs();
    for (const mode of ['api', 'out']) {
      await writeFile(join(logDir, 'auth-mode'), mode);
      await assert.rejects(backend.generate({ prompt: 'normal', schema }), (e: unknown) => e instanceof CodexError && e.code === 'subscription_required' && !e.message.includes('sk-'));
    }
    assert.equal(await execs(), before, 'an API-key or missing sign-in never reaches generation');
    await assert.rejects(codex({ bin: join(root, 'not-installed'), timeoutMs: 1000 }).generate({ prompt: 'normal', schema }), CodexError);
    assert.throws(() => codex({ bin, account: { set: { CLAUDE_CONFIG_DIR: root }, unset: [] }, timeoutMs: 5000 }), /Codex account/);
    assert.equal(await readFile(join(home, '.codex', 'auth.json'), 'utf8'), 'the fake never opens this');
  } finally {
    for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await rm(root, { recursive: true, force: true });
  }
});

const realClaudeBin = (() => {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    try { const candidate = join(dir, 'claude'); if (existsSync(candidate)) return candidate; } catch {}
  }
  return undefined;
})();

test('real Claude CLI accepts the exact flag list the adapter builds', { skip: !realClaudeBin && 'no claude binary on PATH' }, async () => {
  assert.ok(realClaudeBin);
  const root = await mkdtemp(join(tmpdir(), 'byokit-decide-claude-flags-'));
  try {
    // Capture the exact args (and stdin envelope) through the fake binary's log.
    const captureDir = join(root, 'capture-sign-in');
    const bin = join(root, 'fake-claude');
    await mkdir(captureDir);
    await writeFile(bin, fakeSource, { mode: 0o700 });
    process.env.FAKE_CLAUDE_LOG = captureDir;
    const capture = claudeCode({ bin, timeoutMs: 5000 });
    await capture.generate({ prompt: 'normal', schema }).finally(() => { delete process.env.FAKE_CLAUDE_LOG; });
    const logged = JSON.parse(await readFile(join(captureDir, 'invocation.json'), 'utf8'));
    const args = logged.args as string[];
    const stdin = `${JSON.stringify(logged.request)}\n`;
    // Replay them against the real CLI with an empty scratch config dir.
    const emptyConfig = join(root, 'empty-sign-in');
    const scratch = join(root, 'scratch-home');
    await mkdir(emptyConfig);
    await mkdir(scratch);
    const output = await new Promise<{ stdout: string; stderr: string }>((resolveOutput, reject) => {
      const child = spawn(realClaudeBin, args, { cwd: scratch, env: {
        HOME: scratch, USERPROFILE: scratch, TMPDIR: scratch, TMP: scratch, TEMP: scratch,
        XDG_CONFIG_HOME: scratch, XDG_CACHE_HOME: scratch, XDG_DATA_HOME: scratch,
        PATH: '/usr/bin:/bin', CLAUDE_CONFIG_DIR: emptyConfig,
      }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.on('data', (chunk: string) => { stderr += chunk; });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('real claude run timed out')); }, 60_000);
      child.on('error', reject);
      child.on('close', () => { clearTimeout(timer); resolveOutput({ stdout, stderr }); });
      child.stdin.end(stdin);
    });
    const combined = `${output.stdout}\n${output.stderr}`;
    assert.ok(!combined.includes('requires output-format'),
      `real CLI refused the flag combination: ${combined.slice(0, 500)}`);
    // A not-signed-in result is fine; the CLI must still speak stream-json events.
    const events = output.stdout.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
    assert.ok(events.length > 0 && events.every((event) => typeof event.type === 'string'),
      `real CLI emitted no stream-json events: ${combined.slice(0, 500)}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('generation validates locally, refuses unsupported schemas, separates model/schema/state, and treats incomplete as failure', async () => {
  let calls = 0;
  let response: unknown = data;
  const backend: GenerationBackend = { name: 'fake', model: 'one', leaves: false, async generate(request) {
    calls++;
    assert.equal(request.maxOutputTokens, 16_384);
    return { data: response, text: '', usage: { output_tokens: 4 } };
  } };
  const opts = { backends: [backend], cache: new MemoryGenerationCache() };
  assert.deepEqual((await generate({ state: 'Umer' }, schema, opts)).data, data);
  assert.equal((await generate({ state: 'Umer' }, schema, opts)).source, 'cache');
  assert.equal(calls, 1);
  const key = generationCacheKey({ state: 'Umer' }, schema, backend);
  assert.notEqual(key, generationCacheKey({ state: 'changed' }, schema, backend));
  assert.notEqual(key, generationCacheKey({ state: 'Umer' }, { ...schema, title: 'another' }, backend));
  assert.notEqual(key, generationCacheKey({ state: 'Umer' }, schema, { ...backend, model: 'two' }));
  const image = { id: 'Umer-design', mime: 'image/png', bytes: new Uint8Array([1, 2, 3]) };
  const imageKey = generationCacheKey({ state: 'Umer', images: [image] }, schema, backend);
  assert.notEqual(key, imageKey);
  assert.notEqual(imageKey, generationCacheKey({ state: 'Umer', images: [{ ...image, bytes: new Uint8Array([1, 2, 4]) }] }, schema, backend));
  assert.equal(imageKey, generationCacheKey({ state: 'Umer', images: [{ id: image.id, mime: image.mime, dataUrl: 'data:image/png;base64,AQID' }] }, schema, backend));
  await assert.rejects(generate({ state: 'Umer', images: [image] }, schema, opts), { name: 'UnsupportedImagesError' });
  const imageBackend = { ...backend, supportsImages: true, async generate(request: any) {
    assert.deepEqual(request.images, [{ id: image.id, mime: image.mime, dataUrl: 'data:image/png;base64,AQID' }]);
    return { data, text: '' };
  } };
  assert.deepEqual((await generate({ state: 'Umer', images: [image] }, schema, { backends: [imageBackend] })).data, data);
  for (const invalid of [{ name: 'Umer' }, { ...data, extra: true }, { name: 'Other', scenes: [{ duration: 6 }] },
    { name: 'Umer', scenes: [] }, { name: 'Umer', scenes: [{ duration: 0 }] }, { name: 'Umer', scenes: [{ duration: 121 }] }]) {
    response = invalid;
    const result = await generate({ state: 'different' }, schema, { backends: [backend] });
    assert.equal(result.data, null);
    assert.equal(result.failure?.code, 'invalid_output');
  }
  for (const unsupported of [{ $ref: '#' }, { properties: { x: { type: 'string', pattern: 'x' } } }]) {
    await assert.rejects(generate({ state: null }, unsupported as any, opts), InvalidSchemaError);
  }
  const incomplete = { ...backend, async generate() { const error = new Error('private diagnostic'); error.name = 'IncompleteError'; throw error; } };
  const result = await generate({ state: 'Umer' }, schema, { backends: [incomplete] });
  assert.equal(result.data, null);
  assert.equal(result.failure?.code, 'incomplete');
  assert.ok(!JSON.stringify(result).includes('private diagnostic'));
  assert.equal((await generate({ state: 'Umer' }, schema, { backends: [{ ...backend, leaves: true }], privacy: 'stays-here' })).by, 'none');
  const hung = { ...backend, async generate() { return new Promise<never>(() => {}); } };
  assert.equal((await generate({ state: 'Umer' }, schema, { backends: [hung], budget: { timeoutMs: 20 } })).failure?.code, 'timeout');
});
