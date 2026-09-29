// M1 acceptance: contract.test.ts runs machineContract against fakeProvider() with
// installs: false (cases 1-4, 6, 9-12, 15, 16 and 20 pass).
import { fakeProvider, memoryStore } from '../src/testing/fake-provider.ts';
import { machineContract, type MachineBench } from '../src/testing/contract.ts';

machineContract(async (): Promise<MachineBench> => {
  const f = fakeProvider();
  return { provider: f, store: memoryStore(), fake: f.fake, installs: false };
});
