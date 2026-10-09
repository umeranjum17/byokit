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
  KitEventName,
  KitEventPayload,
  BrowserPing,
  LearningCapture,
  LearningMode,
  Member,
  PlanWindow,
  Route,
  RunEnd,
  RunEvent,
  RunRef,
  RunSpec,
  OutputSchema,
  SchemaOutput,
  RunUsage,
  SignInOptions,
  SignInView,
  ToolHost,
  ToolSpec,
} from './types.ts';
// The tables themselves, so an app can write its own generic wrapper over `call` without re-deriving them.
export type { GatewayMethods } from './generated/methods.ts';
export type { JsonValue } from './output.ts';
export type { RouteFacts, RouteView } from './routes.ts';
export { OpenClawKit, type KitOptions, type RetainedLogin } from './kit.ts';
export type { AddKeyResult } from './keys.ts';
export { stateWords, toAccountView, words, type AccountView, type WordKey } from './words.ts';

export { AuthStoreUnreadableError } from './auth-store.ts';
export { EngineAlreadyRunningError } from './engine-status.ts';
export { readAgentDayUsage } from './day-usage.ts';
export type { AgentDayUsage, DayUsageClient, EngineStartedCharge, EngineStartedKind } from './day-usage.ts';
export { readAgentUsage, agentUsageOf } from './usage.ts';
export type { AgentUsageReading, LedgerUsageTotals, UsageCache, UsageClient, UsageWindow } from './usage.ts';
export type {
  LiveSource, BrowserState, SignInMethodHint, SignInReason, SignInChoice, SettledState, SettledReason,
  ResumeState, NeedSignIn, TakeoverLease, LiveViewState, LiveFrame, LiveInput, ThumbnailResult,
  SignInRefusedWhy, BrowserOptions, SiteVerifier, BrowserHost, BrowserDevice
} from './browser.ts';
