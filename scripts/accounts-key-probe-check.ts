import assert from 'node:assert/strict';

/** Node-side assertions over a web-only cold/packed probe; no timestamp or equal-error success shortcuts. */
export function verifyAccountsProbe(value: unknown): void {
  const result = JSON.parse(JSON.stringify(value)); // Realm-independent arrays/objects from node:vm.
  for (const api of ['openai-completions', 'anthropic-messages']) {
    const answer = result[api];
    assert.equal(answer.text, 'Hello');
    assert.equal(answer.stop, 'toolUse');
    assert.deepEqual(answer.usage, [3, 2, 5]);
    assert.deepEqual(answer.tools, [{ name: 'lookup', arguments: { q: 'x' } }]);
    for (const event of ['text_delta', 'toolcall_end', 'done']) assert.ok(answer.events.includes(event));
    assert.equal(answer.temperature, 0.4);
    assert.equal(answer.sentTools, 1);
    assert.equal(answer.sends, 1);
    assert.equal(answer.selected, true);
    assert.equal(answer.shadowed, false);
    assert.equal(answer.nonAuth, true);
    assert.equal(answer.payloads, 1);
    assert.equal(answer.responses, 1);
    assert.equal(answer.leaked, false);
  }
  assert.equal(result.abort, 'aborted');
  assert.equal(result.bedrock, 'unsupported_platform');
  assert.equal(result.reads, 0, 'platform guards before secret backend');
  assert.equal(result.opaque, 'auth_override');
  assert.equal(result.opaqueReads, 0, 'opaque clients refused before secret backend');
  assert.deepEqual(result.native, { clients: 1, payloads: 1, responses: 1, metadata: true, stop: 'toolUse', usage: [3, 2, 5] });
}
