// `@byokit/herdr` — the Herdr runtime kit (Node host side). The phone and browser side lives in `./device`, the
// host-side link adapter in `./link`; the fake Herdr and contract suite arrive with H6 in `./testing`.

export { HERDR_VERSION, HERDR_PROTOCOL } from './constants.ts';
export { HerdrKit } from './kit.ts';
export { agentWords, stateWords, words, WORDS, type WordKey } from './words.ts';
export type {
  AgentRef, AgentStatus, BlockedAgent, HerdrEvent, HerdrEventName, HerdrEventOf, HerdrKitOptions, HerdrMethod,
  HerdrMethods, HerdrParams, HerdrResult, HerdrSnapshot, HerdrState, HerdrSubscription, HerdrTransport,
  PromptReceipt, StartAgent, TerminalSession,
} from './types.ts';
