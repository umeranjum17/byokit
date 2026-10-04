// The kit's fakes, contract suite and scripted model (5.11). Built in O7.
export { fakeGateway, type FakeScript } from './fake-gateway.ts';
export { fakeBrowserHost, createBrowserHostFake, browserHostContract, memorySignInStore,
  type FakeBrowserHost, type FakeBrowserHostOptions, type BrowserFixture } from './browser.ts';
export { openclawContract, type ContractFixture } from './contract.ts';
export { STUB_USAGE, startModelStub, useModelStub, releaseStub, stubHolding, toolCalls, type ModelStub, type ModelStubOptions, type StubCall } from './model-stub.ts';
