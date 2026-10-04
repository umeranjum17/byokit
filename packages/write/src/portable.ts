// React Native/Hermes: an app-supplied protocol engine, with no Node or pinned-engine imports.
export { ENGINE_PACKAGE, ENGINE_VERSION, PROTOCOL, PROTOCOL_FLOOR } from './constants.ts';
export { Compose } from './compose-core.ts';
export { ComposeError } from './errors.ts';
export { checkLines, errorWords, words, type WordKey } from './words.ts';
export type {
  PortableComposeOptions as ComposeOptions,
  BriefKind, ComposeErrorCode, DraftCheck, Engine, EngineHello, EngineRequest, EngineVerb, EngineVerbs,
  ParsedVoice, Platform, PlatformKind, PortableComposeOptions, Rules,
} from './types.ts';
