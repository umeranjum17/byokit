// The kit's fake Herdr and contract suite (docs/runtime-kits.md 6.8). Built in H6; H3/H5 run the
// contract against the fake, H9 against the real pinned Herdr. Tests import this by relative path —
// the package's public exports stay the kit surface.
export { startFakeHerdr, type AgentStartFault, type FakeHerdr, type FakeHerdrOptions } from './fake-herdr/server.ts';
export { writeBinShim, main as fakeHerdrBinMain } from './fake-herdr/bin.ts';
export { createWorld, type FakeWorld } from './fake-herdr/world.ts';
export { herdrContract, type HerdrContractBench, type HerdrContractOptions, type HerdrContractTestFn, type HerdrContractTestContext } from './contract.ts';
