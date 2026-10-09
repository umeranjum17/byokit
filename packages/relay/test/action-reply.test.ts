// The action route's bounded sealed reply: an optional opaque ciphertext (for example a free-text answer sealed to
// the host's box key) that a device attaches to a notification button. The relay forwards it unchanged to the host's
// `onAction` and never reads or stores it; the one-use token, action authorization and per-address rate limits are
// unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { isActionReply, LIMITS, MAX_ACTION_REPLY, type PushAction } from '../src/index.ts';
import { paired, startRelay } from './helpers.ts';

/** Expo accepts every send; each message is recorded so the test can read its one-use action token. */
function expoWorld() {
  const sent: any[] = [];
  const send = (async (_url: string, init?: RequestInit) => {
    const msgs = JSON.parse(String(init?.body ?? '[]'));
    const arr = Array.isArray(msgs) ? msgs : [msgs];
    sent.push(...arr);
    return Response.json({ data: arr.map(() => ({ status: 'ok', id: 'x' })) });
  }) as typeof fetch;
  return { sent, fetch: send };
}

/** A ciphertext-shaped reply: unpadded base64url, the wire form of a sealed box. */
const sealed = (n = 48) => randomBytes(n).toString('base64url');

const press = (http: string, token: string, action: string, reply?: unknown) =>
  fetch(`${http}/relay/v1/push/action`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, action, ...(reply !== undefined && { reply }) }),
  });

type Relay = Awaited<ReturnType<typeof startRelay>>;
type Paired = Awaited<ReturnType<typeof paired>>;
/** A fresh notification with a button; returns its one-use action token. */
async function ask(r: Relay, h: Paired, world: { sent: any[] }, id: string): Promise<string> {
  await h.client.subscribe(h.grant.device.id, { expo: 'ExponentPushToken[phone]' });
  await h.client.notify({ id, title: 'Allow?', actions: ['answer'] });
  return world.sent.at(-1)!.data.action as string;
}

test('a sealed reply is forwarded to the host callback unchanged', async () => {
  const world = expoWorld();
  const r = await startRelay({ push: { fetch: world.fetch } });
  const seen: PushAction[] = [];
  const h = await paired(r, 'Phone', { onAction: (a) => { seen.push(a); return { echoed: a.reply }; } });
  const token = await ask(r, h, world, 'seal-1');
  const reply = sealed();
  const res = await press(r.http, token, 'answer', reply);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, value: { echoed: reply } });
  assert.deepEqual(seen, [{ device: h.grant.device.id, event: 'seal-1', action: 'answer', reply }]);
});

test('the reply bound accepts the maximum and refuses malformed or oversized replies without spending the token', async () => {
  const world = expoWorld();
  const r = await startRelay({ push: { fetch: world.fetch } });
  const replies: (string | undefined)[] = [];
  const h = await paired(r, 'Phone', { onAction: (a) => { replies.push(a.reply); return null; } });
  const token = await ask(r, h, world, 'bound-1');
  for (const bad of [42, {}, [], ['x'], '', 'x'.repeat(MAX_ACTION_REPLY + 1)]) {
    const res = await press(r.http, token, 'answer', bad);
    assert.equal(res.status, 400, `refused: ${JSON.stringify(bad).slice(0, 32)}`);
    assert.deepEqual(await res.json(), { error: 'bad reply' });
  }
  assert.equal(isActionReply('x'.repeat(MAX_ACTION_REPLY)), true);
  assert.equal(isActionReply('x'.repeat(MAX_ACTION_REPLY + 1)), false);
  assert.equal(isActionReply(''), false);
  const max = 'x'.repeat(MAX_ACTION_REPLY);
  assert.equal((await press(r.http, token, 'answer', max)).status, 200, 'the token survived every refusal');
  assert.deepEqual(replies, [max]);
  assert.equal((await press(r.http, token, 'answer', max)).status, 404, 'still one use');
});

test('action authorization, one-use and rate limits are unchanged with a reply', async () => {
  const world = expoWorld();
  const r = await startRelay({ push: { fetch: world.fetch } });
  const replies: (string | undefined)[] = [];
  const h = await paired(r, 'Phone', { onAction: (a) => { replies.push(a.reply); return null; } });
  const token = await ask(r, h, world, 'auth-1');
  assert.equal((await press(r.http, token, 'nope', sealed())).status, 400, 'unknown action refused');
  assert.equal((await press(r.http, token, 'answer', sealed())).status, 200);
  assert.equal(replies.length, 1, 'the refused action never reached the host');
  assert.equal((await press(r.http, token, 'answer', sealed())).status, 404, 'one use');

  // The per-address action limit is checked before the token, so unknown tokens still count toward it.
  const limited = await startRelay();
  let status = 0;
  for (let i = 0; i < LIMITS.action; i++) status = (await press(limited.http, 'made-up', 'answer', sealed())).status;
  assert.equal(status, 404);
  assert.equal((await press(limited.http, 'made-up', 'answer', sealed())).status, 429, 'the action limit still 429s');
});

test('the relay neither reads nor stores the reply content', async () => {
  const world = expoWorld();
  const r = await startRelay({ push: { fetch: world.fetch } });
  const seen: string[] = [];
  const h = await paired(r, 'Phone', { onAction: (a) => { seen.push(a.reply!); throw new Error('host declined'); } });
  const token = await ask(r, h, world, 'secret-1');
  // Not valid base64url or JSON, with a control character the relay's own name/notice filters reject elsewhere.
  const canary = 'CANARY-not/sealed \u0001 <script>content-secret';
  const res = await press(r.http, token, 'answer', canary);
  assert.equal(res.status, 502);
  assert.doesNotMatch(await res.text(), /CANARY|content-secret/, 'an error never echoes the reply');
  assert.deepEqual(seen, [canary], 'the host callback receives the reply byte for byte');
  assert.doesNotMatch(JSON.stringify(r.saved()), /CANARY|content-secret/, 'the relay stores no reply content');
});
