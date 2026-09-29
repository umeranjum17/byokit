// K12 acceptance (muxr runs its host suite under vitest): `herdrContract` accepts the runner's
// `test` instead of hard-wiring `node:test`, so the same suite registers against the kit fake
// through a vitest-shaped double here — and against vitest's real `test` in the consumer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scratchDir } from '../../test-support.ts';
import { HerdrKit } from '../src/kit.ts';
import { herdrContract } from '../src/testing/index.ts';
import type { HerdrContractTestFn, HerdrContractTestContext } from '../src/testing/index.ts';
import type { HerdrTransport } from '../src/types.ts';

const makeBench = async () => {
  const { startFakeHerdr } = await import('../src/testing/index.ts');
  const fake = await startFakeHerdr({ dir: scratchDir('herdr-contract-runner') });
  const kit = new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath });
  return {
    kit,
    fake,
    withTransport: (transport: HerdrTransport) =>
      new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath, transport }),
  };
};

class Skipped extends Error {}

function vitestLike(cases: { name: string; fn: (t: HerdrContractTestContext) => void | Promise<void> }[]): HerdrContractTestFn {
  return ((name: string, fn: (t: HerdrContractTestContext) => void | Promise<void>) => {
    cases.push({ name, fn });
  }) as HerdrContractTestFn;
}

const runCase = (fn: (t: HerdrContractTestContext) => void | Promise<void>): Promise<'ran' | 'skipped'> => {
  const t: HerdrContractTestContext = {
    // vitest's `context.skip()` aborts the test by throwing; node:test's `t.skip()` marks and
    // returns. The contract only does `return t.skip(...)`, which is correct under both.
    skip: (_message?: string) => {
      throw new Skipped();
    },
  };
  return Promise.resolve()
    .then(() => fn(t))
    .then(() => 'ran' as const)
    .catch((e) => {
      if (e instanceof Skipped) return 'skipped' as const;
      throw e;
    });
};

test('contract: registers and passes through an injected runner test fn (vitest-shaped)', async () => {
  const cases: { name: string; fn: (t: HerdrContractTestContext) => void | Promise<void> }[] = [];
  herdrContract(makeBench, { test: vitestLike(cases) });
  assert.ok(cases.length >= 10, `expected the full suite, got ${cases.length} cases`);
  assert.ok(cases.every(({ name }) => name.startsWith('contract:')), 'every case keeps its contract: name');
  const outcomes = new Map<string, 'ran' | 'skipped'>();
  for (const c of cases) outcomes.set(c.name, await runCase(c.fn));
  assert.ok(
    [...outcomes.values()].every((o) => o === 'ran'),
    `every case runs when make provides a transport double: ${JSON.stringify([...outcomes])}`,
  );
});

test('contract: transport-dependent cases skip (not fail) when make omits the double', async () => {
  const { startFakeHerdr } = await import('../src/testing/index.ts');
  const cases: { name: string; fn: (t: HerdrContractTestContext) => void | Promise<void> }[] = [];
  herdrContract(
    async () => {
      const fake = await startFakeHerdr({ dir: scratchDir('herdr-contract-runner-no-double') });
      const kit = new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath });
      return { kit, fake };
    },
    { test: vitestLike(cases) },
  );
  let skipped = 0;
  for (const c of cases) {
    if ((await runCase(c.fn)) === 'skipped') skipped += 1;
  }
  assert.ok(skipped >= 1, 'the withTransport cases skip when make provides no transport double');
});

test('contract: also accepts the runner test fn bare (without the options wrapper)', () => {
  const cases: { name: string; fn: (t: HerdrContractTestContext) => void | Promise<void> }[] = [];
  herdrContract(makeBench, vitestLike(cases));
  assert.ok(cases.length >= 10, `expected the full suite, got ${cases.length} cases`);
});
