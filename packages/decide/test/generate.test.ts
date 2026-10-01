import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generate, generationCacheKey, MemoryGenerationCache, decide, InvalidSchemaError, type GenerationBackend } from '../src/index.ts';
import { claudeCode, ClaudeCodeError } from '../src/claude-code.ts';

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
  try { method = readFileSync(process.env.CLAUDE_CONFIG_DIR + '/auth-mode', 'utf8'); } catch {}
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: method, apiProvider: 'firstParty' }));
  process.exit(0);
}
const request = JSON.parse(stdin);
const prompt = request.message.content.filter((part) => part.type === 'text').at(-1).text;
const args = process.argv.slice(2);
writeFileSync(process.env.CLAUDE_CONFIG_DIR + '/invocation.json', JSON.stringify({ args, request, env: process.env, cwd: process.cwd() }));
if (prompt === 'hang') { setInterval(() => {}, 1000); }
else if (prompt === 'stderr') { process.stderr.write('private diagnostic'); process.exitCode = 1; }
else if (prompt === 'broken') { process.stdout.write('{'); }
else {
  let data = { name: 'Umer', scenes: [{ duration: 6 }] };
  if (prompt === 'partial') data = { name: 'Umer' };
  if (prompt.startsWith('{')) {
    const input = JSON.parse(prompt);
    if (input.questions) data = Object.fromEntries(Object.entries(input.questions).map(([k, q]) => {
      const keys = q.kind === 'choice' ? Object.keys(q.options) : q.kind === 'yesno' ? ['true', 'false'] : q.levels.map((_, i) => String(i));
      return [k, { probabilities: Object.fromEntries(keys.map((key, i) => [key, i === 0 ? 0.9 : 0.1 / (keys.length - 1)])), pick: keys[0] }];
    }));
  }
  process.stdout.write(JSON.stringify({ type: 'result', subtype: prompt === 'incomplete' ? 'error_max_turns' : 'success',
    is_error: prompt === 'incomplete', structured_output: data, result: 'Complete.', usage: { input_tokens: 17, output_tokens: 29 } }));
}
`;

test('Claude binary seam: isolated subscription, structured generation, scalar decisions and fixed failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'byokit-decide-generate-'));
  const configDir = join(root, 'app-sign-in');
  const ambient = join(root, 'ambient-config');
  const decoyHome = join(root, 'ambient-home');
  const homeClaude = join(decoyHome, '.claude');
  const previousHome = process.env.HOME;
  const previousConfig = process.env.CLAUDE_CONFIG_DIR;
  try {
    await mkdir(configDir);
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
    const backend = claudeCode({ bin, configDir, model: 'chosen-model', timeoutMs: 5000 });
    assert.equal(backend.billing, 'subscription');
    const result = await backend.generate({ system: 'Make a storyboard.', prompt: 'normal', schema });
    assert.deepEqual(result.data, data);
    assert.deepEqual(result.usage, { input_tokens: 17, output_tokens: 29 });
    const log = JSON.parse(await readFile(join(configDir, 'invocation.json'), 'utf8'));
    const arg = (flag: string) => log.args[log.args.indexOf(flag) + 1];
    assert.equal(log.args[0], '-p');
    assert.equal(arg('--output-format'), 'json');
    assert.equal(arg('--input-format'), 'stream-json');
    assert.equal(arg('--tools'), '');
    assert.equal(arg('--disallowedTools'), 'mcp__*');
    assert.equal(arg('--mcp-config'), '{"mcpServers":{}}');
    assert.equal(arg('--setting-sources'), '');
    assert.ok(log.args.includes('--safe-mode'));
    assert.ok(log.args.includes('--no-session-persistence'));
    assert.equal(JSON.parse(arg('--settings')).forceLoginMethod, 'claudeai');
    assert.deepEqual(JSON.parse(arg('--json-schema')), schema);
    assert.equal(arg('--model'), 'chosen-model');
    assert.equal(log.env.CLAUDE_CONFIG_DIR, configDir);
    assert.equal(log.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '16384');
    assert.equal(log.env.HOME, log.cwd);
    assert.notEqual(log.cwd, process.cwd());
    assert.deepEqual(Object.keys(log.env).filter((k: string) => /KEY|TOKEN|SECRET|NODE_OPTIONS/.test(k) && k !== 'CLAUDE_CODE_MAX_OUTPUT_TOKENS'), []);
    await assert.rejects(readFile(join(log.cwd, 'any')), { code: 'ENOENT' });
    assert.deepEqual(await readdir(homeClaude), before);
    assert.equal(await readFile(join(homeClaude, 'byokit-test-canary'), 'utf8'), 'unchanged');
    assert.deepEqual(await readdir(ambient), ['canary']);
    assert.equal(await readFile(join(ambient, 'canary'), 'utf8'), 'unchanged');
    assert.equal(await readFile(join(configDir, '.credentials.json'), 'utf8'), 'the fake never opens this');
    const image = { id: 'Umer-design', mime: 'image/png', bytes: new Uint8Array([137, 80, 78, 71]) };
    await backend.generate({ prompt: 'normal', schema, images: [image] });
    const imageLog = JSON.parse(await readFile(join(configDir, 'invocation.json'), 'utf8'));
    assert.deepEqual(imageLog.request.message.content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw==' } });
    assert.equal(imageLog.request.message.content[0].text, 'Image: Umer-design');
    await backend.generate({ prompt: 'normal', schema, images: [{ id: 'Umer-jpeg', mime: 'image/jpg', dataUrl: 'data:image/jpg;base64,/9j/2Q==' }] });
    const jpegLog = JSON.parse(await readFile(join(configDir, 'invocation.json'), 'utf8'));
    assert.equal(jpegLog.request.message.content[1].source.media_type, 'image/jpeg');
    await assert.rejects(backend.generate({ prompt: 'normal', schema, images: [{ ...image, mime: 'image/webp' }] }), { name: 'InvalidImageError' });
    const answers = await decide({ name: 'Umer' }, {
      choice: { kind: 'choice', images: ['Umer-design'], options: { keep: 'Keep it', drop: 'Drop it' } },
      yesno: { kind: 'yesno', question: 'Keep it?' },
      score: { kind: 'score', levels: ['Good', 'Poor'] },
    }, { privacy: 'may-leave', backends: [backend], images: [image] });
    assert.deepEqual(Object.values(answers).map((a) => a.answer), ['keep', true, 0]);
    assert.equal(answers.choice.confidenceSource, 'self-reported');
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
    await writeFile(join(configDir, 'auth-mode'), 'api_key');
    const beforeRefusal = await readFile(join(configDir, 'invocation.json'), 'utf8');
    await assert.rejects(backend.generate({ prompt: 'normal', schema }), (e: unknown) => e instanceof ClaudeCodeError && e.code === 'subscription_required');
    assert.equal(await readFile(join(configDir, 'invocation.json'), 'utf8'), beforeRefusal, 'wrong billing route never reaches generation');
    await rm(join(configDir, 'auth-mode'));
    const short = claudeCode({ bin, configDir, timeoutMs: 100 });
    await assert.rejects(short.generate({ prompt: 'hang', schema }), (e: unknown) => e instanceof ClaudeCodeError && e.code === 'timeout');
    const controller = new AbortController();
    const pending = backend.generate({ prompt: 'hang', schema, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(pending, (e: unknown) => e instanceof ClaudeCodeError && e.code === 'aborted');
    const missing = claudeCode({ bin: join(root, 'not-installed'), configDir, timeoutMs: 100 });
    await assert.rejects(missing.generate({ prompt: 'normal', schema }), ClaudeCodeError);
    assert.throws(() => claudeCode({ bin, configDir: homeClaude, timeoutMs: 100 }), /separate/);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfig;
    await rm(join(homeClaude, 'byokit-test-canary'), { force: true });
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
