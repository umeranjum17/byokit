// Real built SDK and native Pi, using fake keys and a loopback-only provider. No Herdr lifecycle.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pi } from '@byokit/decide/pi';
import { nativePiAccount, cliAccounts } from '@byokit/accounts/cli';
import { HerdrKit } from '@byokit/herdr';
const out = process.env.DONE_DONE_EVIDENCE_ROOT;
assert.ok(out && process.env.PI_BIN, 'Pass the evidence root and absolute native PI_BIN.');
const dir = mkdtempSync(join(tmpdir(), 'byk-pi-'));
const folder = join(dir, 'pi', 'abcdef'); mkdirSync(folder, { recursive: true });
const env = { HOME: join(dir, 'home'), PATH: '/usr/bin:/bin', PI_CODING_AGENT_DIR: folder };
const requests = [];
const server = createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    const data = JSON.parse(body); requests.push({ model: data.model, fixtureAuth: req.headers.authorization === 'Bearer local-incident-fixture' });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta, finish_reason, usage) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: data.model, choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`;
    res.end(chunk({ role: 'assistant', content: '{"name":"Umer"}' }, null) + chunk({}, 'stop', { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 }) + 'data: [DONE]\n\n');
  });
});
const before = process.env.OPENROUTER_API_KEY;
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const provider = { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions' };
  const config = () => writeFileSync(join(folder, 'models.json'), JSON.stringify({ providers: { openrouter: provider } }));
  config();
  const child = spawn(process.env.PI_BIN, ['--mode', 'json', '--no-session', '--no-tools', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-approve', '-p', 'Return a name.'], { cwd: dir, env: { ...env, OPENROUTER_API_KEY: 'local-incident-fixture' }, stdio: 'ignore' });
  const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
  const [code] = await once(child, 'close'); clearTimeout(timer);
  assert.equal(code, 0); assert.deepEqual(requests, [{ model: 'moonshotai/kimi-k2.6', fixtureAuth: true }]);
  const baseline = requests.length;
  process.env.OPENROUTER_API_KEY = 'local-incident-fixture';
  const kit = cliAccounts({ stateDir: dir, bins: { pi: process.env.PI_BIN }, env });
  const hd = new HerdrKit({ mode: 'adopt', bin: '/unused', socketPath: '/unused' });
  for (const model of [undefined, '', '  ', 'openrouter/', 'openrouter/:high']) {
    assert.throws(() => pi({ bin: process.env.PI_BIN, model, env, timeoutMs: 30000 }), { code: 'model_required' });
    assert.throws(() => nativePiAccount({ stateDir: dir, folder, bin: process.env.PI_BIN, home: env.HOME, model }), { code: 'model-required' });
    await assert.rejects(kit.add('pi', { piProvider: 'openai-codex', model }), { code: 'model-required' });
    await assert.rejects(hd.startAgent({ kind: 'pi', cwd: dir, place: { workspace: 'new' }, args: model === undefined ? [] : ['--model', model] }), { code: 'model_required' });
  }
  assert.equal(requests.length, baseline);
  // The selected account supplies its own fixture credential; the ambient key is not copied.
  provider.apiKey = 'local-incident-fixture'; config();
  const model = 'openrouter/moonshotai/kimi-k2.6';
  const descriptor = nativePiAccount({ stateDir: dir, folder, bin: process.env.PI_BIN, home: env.HOME, model });
  assert.deepEqual(descriptor.args, ['--model', model]);
  const answer = await pi({ bin: process.env.PI_BIN, model, env, timeoutMs: 30000 }).generate({ prompt: 'Who?', schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } });
  assert.deepEqual(answer.data, { name: 'Umer' }); assert.equal(requests.length - baseline, 1);
  const result = { rawNativeMissingModel: requests[0].model, guardedMissingModelRequests: 0, explicitModel: requests[1].model, answer: answer.data, selectedEnvironmentHasAmbientKey: Object.hasOwn(env, 'OPENROUTER_API_KEY'), herdr: 'offline preflight only; no Herdr process, workspace runner or live account' };
  writeFileSync(join(out, 'pi-admission.txt'), JSON.stringify(result, null, 2) + '\nPASS\n');
  writeFileSync(join(out, 'summary.txt'), 'done-done-verify-byokit: Pi model admission\nCommand: node .agents/skills/done-done-verify-byokit/capture/pi-model-admission.mjs\nPASS: raw native fallback reproduced with a fake key and loopback endpoint.\nPASS: built Accounts, native descriptor, Decide and Herdr preflight refuse missing/empty models with zero requests.\nPASS: explicit-model Decide answers Umer using only the selected account environment.\nLimitations: Herdr environment replacement is covered by offline fixtures, not a live Herdr process or workspace runner. Raw Herdr call/cli and the example Pi picker need separate qualification.\nscreen: none\n');
  writeFileSync(join(out, 'steps.json'), JSON.stringify({ target: { version: 'built public BYOKit entries and native Pi supplied by host' }, start: 'isolated folders, fake ambient key, loopback endpoint only', steps: ['Reproduce raw native missing-model fallback', 'Refuse missing and empty models through Accounts, native descriptor, Decide and Herdr preflight without sending a request', 'Answer on an explicit model through the built Decide entry and selected account environment'], result: 'Pi launches require an explicit model; the missing-model guards send zero requests, the explicit model answers, and the selected child environment omits the ambient provider key. Herdr lifecycle remains unqualified.' }, null, 2));
} finally {
  if (before === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = before;
  server.closeAllConnections(); await new Promise(r => server.close(r)); rmSync(dir, { recursive: true, force: true });
}
