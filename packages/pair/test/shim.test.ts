// The deprecated @byokit/link shim (removed in 0.9.0) must answer exactly like @byokit/pair.
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('deprecated @byokit/link re-exports @byokit/pair unchanged', async () => {
  const [shim, kit] = await Promise.all([import('@byokit/link'), import('@byokit/pair')]);
  assert.deepEqual(Object.keys(shim).sort(), Object.keys(kit).sort());
  assert.equal(shim.Host, kit.Host);
  assert.equal(shim.keyPair, kit.keyPair);
  const [shimNode, kitNode] = await Promise.all([import('@byokit/link/node'), import('@byokit/pair/node')]);
  assert.deepEqual(Object.keys(shimNode).sort(), Object.keys(kitNode).sort());
  assert.equal(shimNode.hostKeyFile, kitNode.hostKeyFile);
});
