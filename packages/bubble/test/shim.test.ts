// The deprecated @byokit/overlay shim (removed in 0.4.0) must answer exactly like @byokit/bubble.
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('deprecated @byokit/overlay re-exports @byokit/bubble unchanged', async () => {
  const [shim, kit] = await Promise.all([import('@byokit/overlay'), import('@byokit/bubble')]);
  assert.deepEqual(Object.keys(shim).sort(), Object.keys(kit).sort());
  assert.equal(shim.createOverlay, kit.createOverlay);
  assert.equal(shim.overlay, kit.overlay);
  for (const sub of ['focused-field', 'screen-frame'] as const) {
    const [shimSub, kitSub] = await Promise.all([import(`@byokit/overlay/${sub}`), import(`@byokit/bubble/${sub}`)]);
    assert.deepEqual(Object.keys(shimSub).sort(), Object.keys(kitSub).sort(), sub);
  }
});
