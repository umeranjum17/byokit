// One chat channel (docs/runtime-kits.md 5.18) the way Crewhouse uses it: every Telegram message from the listed
// person lands in Chief's thread through the app's handler, the reply comes back to the chat, a message naming a
// helper still lands with Chief, an unlisted sender reaches nothing, and the bot token is never on disk.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenClawKit, ENGINE_VERSION } from '@byokit/openclaw';
import { fakeTelegram, startModelStub, useModelStub } from '@byokit/openclaw/testing';

const scratch = process.env.CHANNEL_SCRATCH;
assert.ok(scratch, 'CHANNEL_SCRATCH names the exclusive scratch dir');
const TOKEN = '7000001:verify-loopback-bot-token';
const PERSON = '4242';
const CHIEF = 'agent:m1:crewhouse:chief:1'; // the app's own key for Chief's thread
const t0 = Date.now();
const log = (label, value = {}) => console.log(JSON.stringify({ ms: Date.now() - t0, label, ...value }));
async function until(fn, what, ms = 120_000) {
  const end = Date.now() + ms;
  while (!fn()) { assert.ok(Date.now() < end, `timed out waiting for ${what}`); await delay(50); }
}
const files = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name), stat = statSync(path, { throwIfNoEntry: false });
  return !stat ? [] : stat.isDirectory() ? files(path) : stat.isFile() ? [path] : [];
});

// Error case first: a wildcard allow list is refused, typed, without the token in the message.
try {
  new OpenClawKit({ stateDir: join(scratch, 'bad'), spawnEngine: false,
    channels: { telegram: { token: TOKEN, allowFrom: ['*'], member: 'm1', onMessage: () => {} } } });
  assert.fail('a wildcard allow list was accepted');
} catch (error) {
  log('refused', { message: error.message });
  assert.equal(error.message, 'invalid telegram channel options');
}

const telegram = await fakeTelegram({ token: TOKEN });
const stub = await startModelStub();
const stateDir = join(scratch, 'state');
const handled = [];
let chain = Promise.resolve();
const kit = new OpenClawKit({ stateDir, engineDir: process.env.BYOKIT_TEST_ENGINE_DIR ?? join(scratch, 'engine'),
  channels: { telegram: { token: TOKEN, allowFrom: [PERSON], member: 'm1', apiRoot: telegram.url,
    // The app's router: everything from the channel goes to Chief's thread, one message at a time.
    onMessage: (m) => { chain = chain.then(async () => {
      log('onMessage', m);
      const end = await kit.run({ member: 'm1', sessionKey: CHIEF, message: m.text }, () => {});
      log('chief answered', { ok: end.ok, text: end.ok ? end.text : end.message });
      if (end.ok) await kit.reply(m.chat, end.text);
      handled.push(m);
    }).catch((error) => log('handler failed', { message: error.message })); },
  } } });
try {
  await kit.start();
  log('ready', { engine: ENGINE_VERSION, entry: import.meta.resolve('@byokit/openclaw'), phase: kit.state.phase });
  await useModelStub(kit, stub);
  await kit.ensureMember('m1');
  await kit.ensureMember('helper');
  await until(() => telegram.calls.some((c) => c.method === 'getUpdates'), 'the engine to long-poll the Bot API');
  log('polling', { methods: [...new Set(telegram.calls.map((c) => c.method))] });

  telegram.message(PERSON, 'Hi Chief, what is on today?');
  telegram.message(PERSON, '@helper do this one yourself');
  telegram.message('999', 'let me in');
  await until(() => handled.length >= 2 && telegram.sent.length >= 2, 'both replies at the chat');
  await delay(3_000); // room for the unlisted sender or a stray engine reply to show up
  log('sent to Telegram', { sent: telegram.sent });
  assert.deepEqual(handled.map((m) => m.text), ['Hi Chief, what is on today?', '@helper do this one yourself']);
  assert.equal(telegram.sent.length, 2, 'one reply per listed message, none from the engine itself');
  assert.ok(telegram.sent.every((s) => s.chat === PERSON && s.text.length > 0));

  const keys = {};
  for (const agentId of ['m1', 'helper'])
    keys[agentId] = ((await kit.call('sessions.list', { agentId })).sessions ?? []).map((s) => s.key);
  log('engine sessions', keys);
  assert.ok(keys.m1.includes(CHIEF), "the messages ran in Chief's thread");
  assert.deepEqual(keys.helper, [], 'nothing reached the helper');
  assert.ok(keys.m1.every((key) => !key.includes('helper')));
} finally {
  await kit.stop();
  await telegram.close();
  await stub.close();
}
try { await kit.reply({ channel: 'telegram', id: PERSON }, 'late'); assert.fail('a reply after stop was sent'); }
catch (error) { log('reply after stop', { message: error.message }); assert.match(error.message, /gateway not ready/); }
const leaked = files(stateDir).filter((path) => readFileSync(path).includes(TOKEN));
log('token on disk', { files: leaked.length });
assert.deepEqual(leaked, []);
console.log('TELEGRAM-CHANNEL OK');
