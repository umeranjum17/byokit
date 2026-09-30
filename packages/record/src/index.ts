// `@byokit/record` — record a screen or a desktop through any recorder implementing recorder protocol v1
// (docs/capability-kits.md 5, 6). The fake recorder and contract suite live in `./testing`.

export { CONSENT_WINDOW_S, DISPLAY_VARS, PROTOCOL, PROTOCOL_FLOOR } from './constants.ts';
export { Capture } from './capture.ts';
export { CaptureError } from './errors.ts';
export { errorWords, eventWords, words, type WordKey } from './words.ts';
export type {
  Caption, CaptureErrorCode, CaptureOptions, DisplayVar, EventsMode, MakeOptions, MakeResult, RecordEvent,
  RecordOptions, RecorderHello, Source, SourceKind,
} from './types.ts';
