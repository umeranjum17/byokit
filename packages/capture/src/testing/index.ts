// The kit's fake recorder and contract suite (docs/capability-kits.md 5.5).
export {
  fakeRecorder, type FakeInvocation, type FakeRecorder, type FakeRecorderScript, type RecorderErrorWire,
} from './fake-recorder.ts';
export {
  captureContract, type CaptureContractBench, type CaptureContractOptions, type CaptureContractTestFn,
} from './contract.ts';
