// The kit's fake Herdr and contract suite (docs/runtime-kits.md 6.8). Built in H6; H3/H5 run the
// contract against the fake, H9 against the real pinned Herdr. Tests import this by relative path —
// the package's public exports stay the kit surface.
//
// The fake's documented test handle is `FakeHerdr`: `fake.world` is the LIVE world the server
// answers from (mutable, with seeded ids from `world.seed`), `fake.emit` routes frames to the
// sockets watching them (filtered kinds reach only their pane's watchers), `fake.watching()`
// lists the watched panes, `fake.snapshotCount()` counts `session.snapshot` calls, and the
// `holdSnapshot`/`failNextSnapshot`/`holdAck`/`failNextAck` hooks script slow or failing answers.
// The bin shim speaks real terminal frames (`{ type: 'terminal.frame', full, bytes }`, plus a
// `data` alias) with `terminal.resize`/`terminal.input` on stdin, and `api schema` prints the
// pinned v0.9.1 snapshot.
export { startFakeHerdr, type AgentStartFault, type FakeHerdr, type FakeHerdrOptions } from './fake-herdr/server.ts';
export { writeBinShim, main as fakeHerdrBinMain } from './fake-herdr/bin.ts';
export { createWorld, type FakeWorld } from './fake-herdr/world.ts';
export { herdrContract, type HerdrContractBench, type HerdrContractOptions, type HerdrContractTestFn, type HerdrContractTestContext } from './contract.ts';
