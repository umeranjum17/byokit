// BK-P1: the contract suite runs against the fake engine in `npm test` (docs/capability-kits.md 9.2).
import { Compose } from '../src/compose.ts';
import { composeContract, fakeEngine } from '../src/testing/index.ts';

composeContract(async () => {
  const fake = fakeEngine();
  return { compose: new Compose({ engine: fake }), fake };
});
