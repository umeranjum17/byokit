// G3 acceptance (docs/runtime-kits.md 6.8): the contract suite runs against the fake in `npm test`,
// through the kit's own `cli`/`terminal` wiring (never a real Herdr).
import { scratchDir } from '../../test-support.ts';
import { HerdrKit } from '../src/kit.ts';
import { herdrContract, startFakeHerdr } from '../src/testing/index.ts';
import type { HerdrProtocolRange, HerdrTransport } from '../src/types.ts';

herdrContract(async () => {
  const fake = await startFakeHerdr({ dir: scratchDir('herdr-contract') });
  const kit = new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath });
  return {
    kit,
    fake,
    withTransport: (transport: HerdrTransport, o?: { protocolRange?: HerdrProtocolRange }) =>
      new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath, transport, ...o }),
  };
});
