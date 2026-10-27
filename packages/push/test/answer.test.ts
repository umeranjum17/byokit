// Answer from the notification, end to end on loopback: the host sends a sealed, answerable notice through a real
// relay, the phone opens it from the Expo payload, seals the typed reply as the native handler does, presses the
// relay's action route, and the host opens the reply. Push delivery is a fake Expo `fetch`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxKeyPair, sealNotice } from '@byokit/seal';
import { openAnswer, openChoice, openNoticeContent, sealAnswer } from '../src/index.ts';
import { paired, startRelay } from '../../relay/test/helpers.ts';
import vector from '../ios/AnswerTests/answer-vector.json' with { type: 'json' };

test('the reply the Swift handler seals opens on the host only for its own notification, button and device', () => {
  const bytes = (name: 'deviceSecret' | 'hostSecret' | 'devicePublic' | 'hostPublic' | 'nonce') => Uint8Array.from(vector[name]);
  const press = { event: vector.reply.event, action: vector.reply.action, reply: vector.sealed };
  assert.equal(sealAnswer(vector.reply, bytes('deviceSecret'), bytes('hostPublic'), () => bytes('nonce')), vector.sealed, 'same bytes as Swift');
  assert.equal(openAnswer(press, bytes('devicePublic'), bytes('hostSecret')), vector.reply.text);
  assert.equal(openAnswer({ ...press, event: 'ask-43' }, bytes('devicePublic'), bytes('hostSecret')), null, 'replayed onto another notification');
  assert.equal(openAnswer({ ...press, action: 'open' }, bytes('devicePublic'), bytes('hostSecret')), null, 'another button');
  assert.equal(openAnswer(press, boxKeyPair().publicKey, bytes('hostSecret')), null, 'another device');
  assert.equal(openAnswer({ ...press, reply: vector.sealed.slice(0, -2) + 'AA' }, bytes('devicePublic'), bytes('hostSecret')), null, 'tampered');
  assert.equal(openAnswer({ event: press.event, action: press.action }, bytes('devicePublic'), bytes('hostSecret')), null, 'no reply');
});

test('the choice the Swift handler seals opens as a choice only, never as text', () => {
  const bytes = (name: 'deviceSecret' | 'hostSecret' | 'devicePublic' | 'hostPublic' | 'nonce') => Uint8Array.from(vector[name]);
  const { reply, sealed } = vector.choice;
  const press = { event: reply.event, action: reply.action, reply: sealed };
  assert.equal(sealAnswer(reply, bytes('deviceSecret'), bytes('hostPublic'), () => bytes('nonce')), sealed, 'same bytes as Swift');
  assert.equal(openChoice(press, bytes('devicePublic'), bytes('hostSecret')), 'allow');
  assert.equal(openAnswer(press, bytes('devicePublic'), bytes('hostSecret')), null, 'a choice is not typed text');
  assert.equal(openChoice({ event: vector.reply.event, action: vector.reply.action, reply: vector.sealed }, bytes('devicePublic'), bytes('hostSecret')), null, 'typed text is not a choice');
  assert.equal(openChoice({ ...press, event: 'perm-8' }, bytes('devicePublic'), bytes('hostSecret')), null, 'replayed onto another notification');
  assert.equal(openChoice({ ...press, action: 'deny' }, bytes('devicePublic'), bytes('hostSecret')), null, 'another button');
  assert.equal(openChoice(press, boxKeyPair().publicKey, bytes('hostSecret')), null, 'another device');
});

test('a typed Answer travels from the notification through the relay to the host', async () => {
  const sent: any[] = [];
  const fetch = (async (_url: string, init?: RequestInit) => {
    const msgs = JSON.parse(String(init?.body ?? '[]'));
    sent.push(...msgs);
    return Response.json({ data: msgs.map(() => ({ status: 'ok', id: 'x' })) });
  }) as typeof globalThis.fetch;
  const phone = boxKeyPair(), host = boxKeyPair(), stranger = boxKeyPair();
  const answers: string[] = [];
  const r = await startRelay({ push: { fetch } });
  const h = await paired(r, 'Umer phone', { onAction: (a) => {
    const text = openAnswer(a, phone.publicKey, host.secretKey);
    const choice = openChoice(a, phone.publicKey, host.secretKey);
    if (text === null && choice === null) throw new Error('not an answer from this phone');
    answers.push(text ?? `choice:${choice}`);
    return { answered: a.event };
  } });
  await h.client.subscribe(h.grant.device.id, { expo: 'ExponentPushToken[phone]', platform: 'ios' });
  const ask = async (id: string) => {
    await h.client.notify({
      id, title: 'An agent needs you', urgency: 'high', mutableContent: true, categoryId: 'agent-question', actions: ['answer'],
      data: sealNotice({ title: 'Claude asks', body: 'Run the tests? y/n', data: { sessionId: 's-1', answer: { host: 'home' } } }, phone.publicKey),
    }, { includeContent: true });
    const message = sent.at(-1);
    assert.equal(message.categoryId, 'agent-question');
    return { body: message.data as Record<string, any> }; // Expo's APNs userInfo: the relay payload under `body`
  };
  const pressOn = (userInfo: { body: Record<string, any> }, reply: string) => globalThis.fetch(`${r.http}/relay/v1/push/action`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: userInfo.body.action, action: 'answer', reply }),
  });

  const userInfo = await ask('ask-42');
  const opened = openNoticeContent(userInfo, phone.secretKey);
  assert.equal(opened?.body, 'Run the tests? y/n', 'the extension opens the relay shape, body.data');
  assert.deepEqual(opened?.data?.answer, { host: 'home' });
  const reply = sealAnswer({ event: userInfo.body.id, action: 'answer', text: 'y' }, phone.secretKey, host.publicKey);
  const res = await pressOn(userInfo, reply);
  assert.deepEqual([res.status, await res.json()], [200, { ok: true, value: { answered: 'ask-42' } }]);
  assert.deepEqual(answers, ['y']);

  const next = await ask('ask-43');
  const replayed = await pressOn(next, reply);
  assert.equal(replayed.status, 502, 'an earlier answer replayed onto a new question is refused');
  const forged = await ask('ask-44');
  const res2 = await pressOn(forged, sealAnswer({ event: 'ask-44', action: 'answer', text: 'y' }, stranger.secretKey, host.publicKey));
  assert.equal(res2.status, 502, 'a reply this phone did not seal is refused');
  assert.deepEqual(answers, ['y']);

  // The same pipe carries a pressed choice: the notice lists the choices, the press seals the chosen id.
  const permission = async (id: string) => {
    await h.client.notify({
      id, title: 'Claude needs permission', urgency: 'high', mutableContent: true, categoryId: 'agent-permission', actions: ['allow', 'deny'],
      data: sealNotice({ title: 'Claude asks', body: 'Run rm -rf build?', data: { answer: { host: 'home', choices: [{ id: 'allow', label: 'Allow' }, { id: 'deny', label: 'Deny' }] } } }, phone.publicKey),
    }, { includeContent: true });
    return sent.at(-1).data as Record<string, any>;
  };
  const press = (body: Record<string, any>, action: string, sealedAs: string) => globalThis.fetch(`${r.http}/relay/v1/push/action`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: body.action, action, reply: sealAnswer({ event: body.id, action: sealedAs, choice: sealedAs }, phone.secretKey, host.publicKey) }),
  });
  const first = await permission('perm-7');
  const choices = (openNoticeContent({ body: first }, phone.secretKey)?.data?.answer as { choices: { id: string }[] }).choices;
  assert.deepEqual(choices.map((c) => c.id), ['allow', 'deny'], 'the choices arrive sealed in the notice, not in the clear');
  const allowed = await press(first, 'allow', 'allow');
  assert.deepEqual([allowed.status, await allowed.json()], [200, { ok: true, value: { answered: 'perm-7' } }]);
  assert.deepEqual(answers, ['y', 'choice:allow']);
  assert.equal((await press(await permission('perm-8'), 'deny', 'allow')).status, 502, 'an Allow seal cannot ride the Deny button');
  assert.deepEqual(answers, ['y', 'choice:allow']);
});
