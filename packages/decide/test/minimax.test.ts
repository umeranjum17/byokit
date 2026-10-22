// MiniMax key decisions: the Messages wire at the minimax:key route's base URL, API-billed only.
// Fake fetch below; no live call here (no key held).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decide, minimax, parseConfig, MINIMAX_ROUTES, ConfigError, UnsupportedAccountError, type Question } from '../src/index.ts';
import routes from '../../accounts/src/routes.json' with { type: 'json' };

const fixture = JSON.parse(readFileSync(new URL('./fixtures/anthropic-messages.json', import.meta.url), 'utf8'));
const questions: Record<string, Question> = {
  intent: { kind: 'choice', options: { task: 'Something new to do', followup: 'About an earlier job', chat: 'Just talking' } },
};

test('an app decides on a MiniMax key over the minimax:key route, API-billed only', async () => {
  assert.deepEqual(MINIMAX_ROUTES, { apiKey: { billing: 'api', offer: false } });
  // The endpoint is the accounts route's own, so the two layers cannot drift apart.
  const route = routes.find((r) => r.id === 'minimax:key')!;
  const sent: { url: unknown; key: unknown; body: any }[] = [];
  const fetch = async (url: unknown, init?: { headers?: unknown; body?: unknown }) => {
    sent.push({ url, key: (init!.headers as any)['x-api-key'], body: JSON.parse(init!.body as string) });
    return Response.json(fixture.completed);
  };
  const backend = minimax({ model: 'MiniMax-M3.1-Flash', key: 'mm-key', fetch: fetch as typeof globalThis.fetch });
  assert.equal(backend.name, 'minimax');
  const direct = await decide({}, questions, { privacy: 'may-leave', backends: [backend] });
  assert.equal(direct.intent.answer, 'followup');
  assert.equal(direct.intent.by, 'minimax');

  // The same backend through a portable config, the key from the host's own slot.
  const viaConfig = await decide({}, questions, { privacy: 'may-leave',
    config: parseConfig({ backend: 'minimax', model: 'MiniMax-M3.1-Flash' }),
    host: { keys: { minimax: 'mm-key' }, fetch: fetch as typeof globalThis.fetch } });
  assert.equal(viaConfig.intent.by, 'minimax');
  assert.equal(sent.length, 2);
  for (const call of sent) {
    assert.equal(call.url, `${route.models!.baseUrl}/v1/messages`);
    assert.equal(call.key, 'mm-key');
    assert.equal(call.body.model, 'MiniMax-M3.1-Flash');
    assert.deepEqual(call.body.tool_choice, { type: 'tool', name: 'decisions' });
  }

  // A refused key abstains with its code; a missing model or key, a plan account and an unknown field are refused.
  const refused = await decide({}, questions, { privacy: 'may-leave',
    backends: [minimax({ model: 'm', key: 'bad', fetch: async () => new Response('', { status: 401 }) })] });
  assert.deepEqual(refused.intent.failure, { code: 'key_refused', status: 401 });
  assert.throws(() => minimax({ model: ' ', key: 'k' }), /minimax needs an explicit model/);
  assert.throws(() => minimax({ model: 'm', key: '' }), /minimax needs a key/);
  assert.throws(() => parseConfig({ backend: 'minimax' }), ConfigError);
  assert.throws(() => parseConfig({ backend: 'minimax', auth: 'account', model: 'm' }), UnsupportedAccountError);
  assert.throws(() => parseConfig({ backend: 'minimax', model: 'm', request: {} }), ConfigError);
});
