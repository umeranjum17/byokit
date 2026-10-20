// An OpenRouter API key (pay-as-you-go, no plan) takes the model the person chooses, through the built @byokit/openclaw.
// Offline by default (fakeGateway answering OpenRouter's catalog). `--engine` drives the real pinned engine's OpenRouter
// catalog hook with a dummy bearer (OpenRouter's /models list is public) and its key probe with a stand-in key that
// OpenRouter refuses: no real key and no inference are involved.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenClawKit } from '@byokit/openclaw';
import { fakeGateway } from '@byokit/openclaw/testing';

const engine = process.argv.includes('--engine');
const CHOSEN = 'openrouter/deepseek/deepseek-v4.1-flash-1017';
const ROW = CHOSEN.slice('openrouter/'.length);
const say = (...parts) => console.log(parts.join(' '));
const providers = async (kit) => (await kit.call('config.get', {})).config?.models?.providers ?? {};

if (!engine) {
  const key = 'byokit-openrouter-stand-in-key-950';
  const fake = fakeGateway();
  const funded = () => fake.calls.some((c) => c.method === 'openclaw.setup.activate' && c.params?.authChoice === 'openrouter-api-key');
  // OpenRouter's catalog ids carry the maker's slash; the preview pair collides once the engine canonicalizes it.
  fake.handle('byokit.catalog', (p) => p.provider === 'openrouter' && funded() ? { ok: true, models: [
    { id: ROW, name: 'DeepSeek V4.1 Flash', api: 'openai-completions' },
    { id: 'google/gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', api: 'openai-completions' },
    { id: 'google/gemini-3.1-flash-lite-preview', name: 'Gemini 3.1 Flash Lite Preview', api: 'openai-completions' }] }
    : { ok: false, reason: 'no-key' });
  const stateDir = mkdtempSync(join(tmpdir(), 'or-key-')); // short: the bridge socket path has a length limit
  const kit = new OpenClawKit({ stateDir, callbackPort: 0, transport: fake.factory, spawnEngine: false });
  try {
    await kit.start();
    // Crewhouse's key sign-in names OpenRouter's browser choice and no model; the add takes OpenRouter's key route.
    const signedIn = await kit.addKey('umer', { authChoice: 'openrouter-oauth', apiKey: key });
    say('addKey under openrouter-oauth:', JSON.stringify(signedIn));
    assert.deepEqual(signedIn, { status: 'ok' });
    const added = await kit.addKey('umer', { authChoice: 'openrouter-api-key', apiKey: key, model: CHOSEN });
    say('addKey with', CHOSEN + ':', JSON.stringify(added));
    assert.deepEqual(added, { status: 'ok' });
    const listed = (await kit.models('umer', { authChoice: 'openrouter-api-key' })).map((m) => m.id);
    say('models:', JSON.stringify(listed));
    assert.ok(listed.includes(CHOSEN));
    const registered = (await providers(kit)).openrouter;
    say('registered:', JSON.stringify(registered?.models?.map((m) => m.id)), 'headers:', JSON.stringify(registered?.headers ?? null));
    assert.deepEqual(registered?.models?.map((m) => m.id), [ROW]);
    const end = await kit.run({ member: 'umer', sessionKey: 'agent:umer:verify-openrouter', auth: 'apiKey', message: 'Hi' });
    const model = fake.calls.findLast((c) => c.method === 'agent')?.params?.model;
    say('key run:', JSON.stringify({ ok: end.ok, model }));
    assert.equal(end.ok, true);
    assert.equal(model, ROW);
    const unknown = await kit.addKey('ana', { authChoice: 'openrouter-api-key', apiKey: key, model: 'openrouter/not/a-model' });
    say('unknown model:', JSON.stringify(unknown));
    assert.deepEqual(unknown, { status: 'not_included', reason: 'model' });
    const other = await kit.addKey('ana', { authChoice: 'openai-api-key', apiKey: key, model: 'openai/gpt-5.1' });
    say('model on a non-live route:', JSON.stringify(other));
    assert.deepEqual(other, { status: 'not_included', reason: 'model' });
    const workspace = await kit.addKey('ana', { authChoice: 'openrouter-api-key', apiKey: key, model: CHOSEN, orgId: 'org-umer' });
    say('Go workspace on OpenRouter:', JSON.stringify(workspace));
    assert.deepEqual(workspace, { status: 'not_included', reason: 'model' });
    for (const authChoice of ['openai', 'nope']) {
      const refused = await kit.addKey('ana', { authChoice, apiKey: key }).then((r) => JSON.stringify(r), (e) => e.message);
      say(`a choice that takes no key (${authChoice}):`, refused);
      assert.match(refused, /takes no API key|No sign-in is named/);
    }
    assert.equal(JSON.stringify(fake.calls).includes(key), false);
    say('OPENROUTER-KEY-MODEL OK');
  } finally {
    await kit.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
} else {
  // Disk-backed engine home (never RAM /tmp for an install) unless BYOKIT_TEST_ENGINE_DIR names an installed set.
  const root = mkdtempSync(join(process.env.BYOKIT_SCRATCH ?? tmpdir(), 'openrouter-engine-'));
  const kit = new OpenClawKit({ stateDir: join(root, 'state'), engineDir: process.env.BYOKIT_TEST_ENGINE_DIR ?? join(root, 'engine'),
    callbackPort: 0, offered: ['openrouter'] });
  try {
    await kit.start();
    await kit.stop();
    kit.setConfigKey('models.providers.openrouter', { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'byokit-dummy-bearer', models: [] });
    await kit.start();
    const answer = await kit.callDynamic('byokit.catalog', { provider: 'openrouter' }, { timeoutMs: 120_000 });
    const row = answer.models?.find((m) => m.id === ROW);
    say('byokit.catalog openrouter:', JSON.stringify({ ok: answer.ok, count: answer.models?.length, row }));
    assert.equal(answer.ok, true);
    assert.ok(row);
    await kit.stop();
    kit.setConfigKey('models.providers.openrouter', { baseUrl: 'https://openrouter.ai/api/v1', models: [] });
    await kit.start();
    const whole = await kit.patchConfig({ models: { providers: { openrouter: { models: answer.models } } } }).then(() => 'ok', (e) => e.message);
    say('registering the whole list:', whole);
    await kit.patchConfig({ models: { providers: { openrouter: { models: [row] } } } });
    const registered = (await providers(kit)).openrouter?.models?.map((m) => m.id);
    say('registering the chosen model:', JSON.stringify(registered));
    assert.deepEqual(registered, [ROW]);
    // Crewhouse's key sign-in on the real engine: a stand-in key under `openrouter-oauth` reaches OpenRouter's key
    // probe, which refuses it (no inference); before, the kit refused locally as not_included/model.
    const probed = await kit.addKey('umer', { authChoice: 'openrouter-oauth', apiKey: 'byokit-invalid-stand-in-key' });
    say('addKey under openrouter-oauth, stand-in key:', JSON.stringify(probed));
    assert.deepEqual(probed, { status: 'invalid', reason: 'auth' });
    say('OPENROUTER-ENGINE-CATALOG OK');
  } finally {
    await kit.stop();
    execFileSync('chmod', ['-R', 'u+w', root]); // the engine set is installed read-only
    rmSync(root, { recursive: true, force: true });
  }
}
