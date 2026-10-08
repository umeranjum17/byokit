// The deprecated @byokit/ui-core shim (removed in 0.8.0) must answer exactly like @byokit/ui.
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('deprecated @byokit/ui-core re-exports @byokit/ui unchanged', async () => {
  const [shim, kit] = await Promise.all([import('@byokit/ui-core'), import('@byokit/ui')]);
  assert.deepEqual(Object.keys(shim).sort(), Object.keys(kit).sort());
  assert.equal(shim.phaseOf, kit.phaseOf);
  assert.equal(shim.qrMatrix, kit.qrMatrix);
  const [shimPhase, kitPhase] = await Promise.all([import('@byokit/ui-core/phase'), import('@byokit/ui/phase')]);
  assert.deepEqual(Object.keys(shimPhase).sort(), Object.keys(kitPhase).sort());
  assert.equal(shimPhase.phaseOf, kitPhase.phaseOf);
  for (const sub of ['route', 'link', 'kits', 'steps', 'connect'] as const) {
    const [shimSub, kitSub] = await Promise.all([import(`@byokit/ui-core/${sub}`), import(`@byokit/ui/${sub}`)]);
    assert.deepEqual(Object.keys(shimSub).sort(), Object.keys(kitSub).sort(), sub);
  }
});
