import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Accounts, memoryStore } from '@byokit/accounts';
import { diagnostic, pairedTurn } from './cloud-m6.ts';

// A fake Anthropic Messages server that enforces the rules the live API applies to these two calls.
function claudeServer(fail?: { call: number; status: number; type: string }) {
  const bodies: any[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); bodies.push(body);
    assert.equal(String(url), 'https://api.anthropic.com/v1/messages');
    const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if (fail?.call === bodies.length) return json(fail.status, { type: 'error', error: { type: fail.type, message: 'echoes recorded-access' } });
    const history = body.messages.some((m: any) => Array.isArray(m.content) && m.content.some((c: any) => c.type === 'tool_use' || c.type === 'tool_result'));
    if (history && !body.tools?.length) return json(400, { type: 'error', error: { type: 'invalid_request_error', message: 'Requests which include `tool_use` or `tool_result` blocks must define tools.' } });
    const message = (content: unknown[]) => json(200, { id: 'msg_' + bodies.length, type: 'message', role: 'assistant', model: body.model, content,
      stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
    return bodies.length === 1
      ? message([{ type: 'tool_use', id: 'tu_1', name: 'get_machine', input: { input: 'state' } }])
      : message([{ type: 'text', text: 'Hello Umer, it runs ' + JSON.parse(body.messages[2].content[0].content).platform + '.' }]);
  }) as unknown as typeof globalThis.fetch;
  return { bodies, fetch };
}
async function signedIn(fetch: typeof globalThis.fetch) {
  const store = memoryStore();
  await store.modify('byokit-claude-plan', async () => ({ type: 'oauth', access: 'recorded-access', refresh: 'recorded-refresh', expires: Date.now() + 3600_000 }));
  return new Accounts<any, number>({ store: () => store, fetch });
}
const link = { request: async () => ({ platform: 'linux', toolCalls: 1 }) } as any;

test('M6 Claude plan turn: forced tool call, then a text answer whose history defines the tool', async () => {
  const server = claudeServer();
  const answer = await pairedTurn(await signedIn(server.fetch), link);
  assert.equal(answer.text, 'Hello Umer, it runs linux.');
  assert.equal(server.bodies.length, 2);
  assert.deepEqual(server.bodies[0].tool_choice, { type: 'tool', name: 'get_machine' });
  assert.deepEqual(server.bodies[1].tool_choice, { type: 'none' });
  assert.equal(server.bodies[1].tools[0].name, 'get_machine');
  assert.equal(server.bodies[1].messages[2].content[0].tool_use_id, 'tu_1');
});

for (const [call, name] of [[1, 'tool call'], [2, 'answer']] as const) {
  test(`M6 diagnostic names the failed ${name} with its HTTP status and type, never the provider message`, async () => {
    const server = claudeServer({ call, status: 400, type: 'invalid_request_error' });
    const error = await pairedTurn(await signedIn(server.fetch), link).then(() => assert.fail('the turn should fail'), (e: Error) => e);
    assert.equal(error.message, 'Claude could not answer (HTTP 400). Try again or sign in again.');
    const line = diagnostic(error);
    assert.equal(line, `M6 diagnostic {"call":"${name}","status":400,"reason":"invalid_request_error","detail":"echoes [private]"}`);
    assert.ok(!line.includes('recorded-access'));
  });
}
