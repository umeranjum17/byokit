// `@byokit/write` — drafting in a person's voice over the pinned writing engine (docs/capability-kits.md 4).
// The fake engine and contract suite live in `./testing`; the agent CLI is the `write` bin.

export { ENGINE_PACKAGE, ENGINE_VERSION, PROTOCOL, PROTOCOL_FLOOR } from './constants.ts';
export { Compose } from './compose.ts';
export { ComposeError } from './errors.ts';
export { binEngine, inProcessEngine } from './engine.ts';
export { checkLines, errorWords, words, type WordKey } from './words.ts';
export type {
  BriefKind, ComposeErrorCode, ComposeOptions, DraftCheck, Engine, EngineHello, EngineRequest, EngineVerb, EngineVerbs,
  ParsedVoice, Platform, PlatformKind, PortableComposeOptions, Rules,
} from './types.ts';
