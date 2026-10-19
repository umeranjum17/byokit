// The signed-in CLI routes list their models on the real pinned engine: a ChatGPT login lists the Codex CLI route's
// models, and a signed-in Claude Code login lists the Claude CLI route's models, both through the kit's own account
// listing. Synthetic sign-ins, a task-owned `claude` on the engine's PATH, never a real account or the network. Runs
// only in the engine job (npm run test:engine).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { provider } from '@byokit/accounts';
import { OpenClawKit } from '../../src/kit.ts';
import { scratchDir, sharedEngineDir } from '../../../test-support.ts';

test('a signed-in ChatGPT login lists the Codex CLI route\'s models', { timeout: 900_000 }, async () => {
  const dir = scratchDir('mlist-codex');
  const stateDir = join(dir, 'state');
  const kit = new OpenClawKit({ stateDir, engineDir: sharedEngineDir(), callbackPort: 0 });
  try {
    await kit.start();
    await kit.ensureMember('m1');
    await kit.stop();
    const legacy = join(dir, 'people', 'm1', 'auth.json');
    mkdirSync(join(legacy, '..'), { recursive: true });
    writeFileSync(legacy, JSON.stringify({ 'openai-codex': { type: 'oauth', provider: 'openai-codex',
      access: 'a-m1', refresh: 'r-m1', expires: Date.now() + 30 * 86_400_000 } }));
    assert.equal(await kit.migrateRetainedLogin('m1', { path: legacy }), 'staged');
    await kit.start();
    const [chatgpt] = (await kit.accounts('m1')).filter((row) => row.provider === 'openai');
    assert.ok(chatgpt, 'the ChatGPT login is an account');
    // The same ids the ChatGPT catalogue names for its strong and fast models.
    const { strong, fast } = provider('chatgpt').models;
    const codex = (await kit.models('m1', chatgpt.id)).filter((m) => m.id.startsWith('openai-codex/'));
    assert.deepEqual(codex.map((m) => m.id).sort(), [`openai-codex/${strong}`, `openai-codex/${fast}`].sort());
    assert.ok(codex.every((m) => m.available === true), `the Codex CLI models are available: ${JSON.stringify(codex)}`);
  } finally {
    await kit.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a signed-in Claude Code login is a kit account, and its Claude CLI models are listed', { timeout: 900_000 }, async () => {
  // A task-owned `claude` on the engine's PATH, logged in on a plan; it prints no credential.
  const dir = scratchDir('mlist-claude');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), `#!${process.execPath}
const a = process.argv.slice(2).join(' ');
if (a === '--version') console.log('2.1.0 (Claude Code)');
else if (a === 'auth status --text') console.log('Login method: Claude Max Account');
else if (a === 'auth status --json') console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }));
else process.exit(2);
`, { mode: 0o700 });
  const kit = new OpenClawKit({ stateDir: join(dir, 'state'), engineDir: sharedEngineDir(), enginePath: [bin], callbackPort: 0 });
  try {
    await kit.start();
    const { agentId } = await kit.ensureMember('m1');
    // The app's setup detection is how the engine learns a Claude Code login exists.
    await kit.call('openclaw.setup.detect', { agentId }, { timeoutMs: 30_000 });
    const [claude] = (await kit.accounts('m1')).filter((row) => row.provider === 'claude-cli');
    assert.ok(claude, 'the signed-in Claude Code login is a kit account');
    assert.equal(claude.state, 'ready');
    const models = (await kit.models('m1', claude.id)).filter((m) => m.id.startsWith('claude-cli/'));
    assert.ok(models.length > 0, 'the Claude CLI route lists its models');
    assert.ok(models.some((m) => m.available), `a listed Claude CLI model is available: ${JSON.stringify(models)}`);
  } finally {
    await kit.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
