// One chat channel (5.18) on the real pinned engine: the engine long-polls a loopback Telegram Bot API, every
// message from a listed person reaches the app's one handler and no engine agent (a message naming a helper and
// chat commands included), an unlisted sender reaches nothing, kit.reply answers the chat, and the bot token is never on disk.
// Runs only in the engine job (npm run test:engine), never in npm test.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenClawKit } from '../../src/kit.ts';
import { Engine } from '../../src/engine.ts';
import { fakeTelegram, type FakeTelegram } from '../../src/testing/fake-telegram.ts';
import { startModelStub, useModelStub, type ModelStub } from '../../src/testing/model-stub.ts';
import type { ChannelMessage } from '../../src/types.ts';
import { scratchDir, sharedEngineDir } from '../../../test-support.ts';

const TOKEN = '7000001:fake-token-for-a-loopback-bot';
const PERSON = '4242';
const install = scratchDir('channel-engine');
const engineDir = sharedEngineDir() ?? join(install, 'engine');
let stub: ModelStub;
let telegram: FakeTelegram;

before(async () => {
  const bootstrap = new Engine({ stateDir: join(install, 'bootstrap'), engineDir, pluginId: 'byokit',
    tools: [], spawnEngine: true, onState: () => {}, onExit: () => {} });
  await bootstrap.prepare();
  stub = await startModelStub();
  telegram = await fakeTelegram({ token: TOKEN });
}, { timeout: 600_000 });

after(async () => {
  await telegram?.close();
  await stub?.close();
});

async function until<T>(what: string, read: () => T | undefined | false, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(100);
  }
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    const stat = statSync(path, { throwIfNoEntry: false });
    return !stat ? [] : stat.isDirectory() ? filesUnder(path) : stat.isFile() ? [path] : [];
  });
}

test('a Telegram message reaches only the app handler, never an agent, and kit.reply answers it', { timeout: 600_000 }, async () => {
  const stateDir = scratchDir('channel');
  const received: ChannelMessage[] = [];
  const kit = new OpenClawKit({ stateDir, engineDir, tools: [],
    channels: { telegram: { token: TOKEN, allowFrom: [PERSON], member: 'm1', apiRoot: telegram.url, onMessage: (m) => received.push(m) } } });
  try {
    await kit.start();
    assert.equal(kit.state.phase, 'ready');
    await useModelStub(kit, stub);
    // Chief's member and a helper member both exist: neither may be reached from the channel.
    await kit.ensureMember('m1');
    await kit.ensureMember('helper');
    await until('the engine to long-poll the fake Bot API', () => telegram.calls.some((c) => c.method === 'getUpdates'));
    const modelCalls = stub.calls.length;

    telegram.message(PERSON, 'Hi Chief, are you there?');
    telegram.message(PERSON, '@helper take this one yourself');
    telegram.message('999', 'let me in');
    telegram.message(PERSON, '/acp spawn helper');
    telegram.message(PERSON, '/new');
    await until('every listed message at the handler', () => received.length >= 4);
    await delay(3_000); // room for a late dispatch, a stray agent run or the unlisted sender to show up

    // Chat commands are text for the app too: the engine never acts on one from the channel.
    assert.deepEqual(received, [
      { chat: { channel: 'telegram', id: PERSON }, from: PERSON, text: 'Hi Chief, are you there?' },
      { chat: { channel: 'telegram', id: PERSON }, from: PERSON, text: '@helper take this one yourself' },
      { chat: { channel: 'telegram', id: PERSON }, from: PERSON, text: '/acp spawn helper' },
      { chat: { channel: 'telegram', id: PERSON }, from: PERSON, text: '/new' },
    ]);
    assert.equal(stub.calls.length, modelCalls, 'an engine agent ran from the channel');
    for (const agentId of ['m1', 'helper']) {
      const sessions = await kit.call('sessions.list', { agentId }) as { sessions?: { key: string }[] };
      assert.deepEqual((sessions.sessions ?? []).map((s) => s.key), [], `the engine opened a ${agentId} session for a channel message`);
    }
    assert.deepEqual(telegram.sent, [], 'the engine answered the chat by itself');

    await kit.reply(received[0]!.chat, 'Chief here. Yes, I am.');
    await until('the reply at the fake Bot API', () => telegram.sent.length > 0);
    assert.deepEqual(telegram.sent, [{ chat: PERSON, text: 'Chief here. Yes, I am.' }]);

    // An ordinary run still runs: the claim is for channel messages only.
    const end = await kit.run({ member: 'm1', sessionKey: 'agent:m1:chief:1', message: 'hello' }, () => {});
    assert.ok(end.ok, JSON.stringify(end));
    const listed = await kit.call('sessions.list', { agentId: 'm1' }) as { sessions?: { key: string }[] };
    assert.ok((listed.sessions ?? []).some((s) => s.key === 'agent:m1:chief:1'), 'the session check sees a real session');

    const config = JSON.parse(readFileSync(join(stateDir, 'openclaw', 'openclaw.json'), 'utf8'));
    assert.deepEqual(Object.keys(config.channels), ['telegram']);
    assert.equal(config.channels.telegram.dmPolicy, 'allowlist');
    assert.equal(config.channels.telegram.groupPolicy, 'disabled');
    assert.ok(config.plugins.allow.includes('telegram'));
  } finally {
    await kit.stop();
  }
  await assert.rejects(kit.reply({ channel: 'telegram', id: PERSON }, 'late'), /gateway not ready/);
  const leaked = filesUnder(stateDir).filter((path) => readFileSync(path).includes(TOKEN));
  assert.deepEqual(leaked, [], 'the bot token was written to disk');
});

test('the channel stays off unless turned on, and a bad option is refused without echoing the token', async () => {
  const kit = new OpenClawKit({ stateDir: scratchDir('channel-off'), engineDir, tools: [], spawnEngine: false });
  await assert.rejects(kit.reply({ channel: 'telegram', id: PERSON }, 'hi'), /channel is not turned on: telegram/);
  for (const telegram of [
    { token: TOKEN, allowFrom: [], member: 'm1', onMessage: () => {} },
    { token: TOKEN, allowFrom: ['*'], member: 'm1', onMessage: () => {} },
    { token: TOKEN, allowFrom: [PERSON], member: 'Chief!', onMessage: () => {} },
    { token: 'not a token', allowFrom: [PERSON], member: 'm1', onMessage: () => {} },
  ]) {
    assert.throws(() => new OpenClawKit({ stateDir: scratchDir('channel-bad'), engineDir, tools: [], spawnEngine: false,
      channels: { telegram } }), (error: Error) => error.message === 'invalid telegram channel options');
  }
});
