// @byokit/openclaw — the OpenClaw runtime kit, host side (docs/runtime-kits.md 5.3). Entries: `.` (this),
// `./device` (portable), `./link` (Node host-side adapter), `./testing` (fakes and contract suite).
export { ENGINE_VERSION, OPERATOR_SCOPES, PROTOCOL_VERSION } from './constants.ts';
export type {
  Approval,
  CallOptions,
  Decision,
  GatewayEventName,
  GatewayEventPayload,
  GatewayMethod,
  GatewayParams,
  GatewayResult,
  GatewayTransport,
  GateResult,
  Hello,
  KitState,
  Member,
  Route,
  RunEnd,
  RunEvent,
  RunRef,
  RunSpec,
  SignInView,
  ToolHost,
  ToolSpec,
} from './types.ts';
export { OpenClawKit, type KitOptions, type RetainedLogin } from './kit.ts';
export { stateWords, toAccountView, words, type AccountView, type WordKey } from './words.ts';
