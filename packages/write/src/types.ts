// Public types, frozen by docs/capability-kits.md 4.3. BK-P2's generated types must match these both ways (D-I).

export type Rules = { never: string[]; noDashes: boolean; statementEndings: boolean; note: string };
/** `skipped`: never-say bullets too long to use. */
export type ParsedVoice = { rules: Rules; skipped: number };
export type PlatformKind = 'chat' | 'feed' | 'mail';
export type Platform = {
  /** 'x' | 'linkedin' | 'reddit' | 'slack' | 'whatsapp' | 'gmail' at protocol 1. */
  id: string;
  label: string;
  kind: PlatformKind;
  /** Characters; null = no limit worth checking (mail). */
  limit: number | null;
  /** The three reply slots. */
  slots?: [string, string, string];
  /** One extra polish rule, '' when none. */
  polish?: string;
};
export type BriefKind = 'reply' | 'polish' | 'post' | 'thread';
export type DraftCheck = {
  /** length <= limit, or limit null. */
  fits: boolean;
  /** Characters. */
  length: number;
  limit: number | null;
  /** Plain-word breaks of the person's rules, e.g. 'says “delve” from your never-say list'. */
  voice: string[];
  /** Stock phrasing found, plain words. */
  stock: string[];
  /** Numbers/times in the draft the original lacks ([] without original). */
  added: string[];
  /** Numbers/times in the original the draft lacks ([] without original). */
  dropped: string[];
  /** Lists and paragraphs kept (true without original). */
  layoutKept: boolean;
  /** The engine's verdict: 'Sounds natural' | 'A bit stock' | 'Sounds canned'. */
  words: string;
};
export type EngineHello = { protocol: number; version: string };
export type EngineVerbs = {
  hello: { params: Record<string, never>; result: EngineHello };
  'voice.parse': { params: { markdown: string }; result: ParsedVoice };
  'voice.guide': { params: { rules: Rules; post: boolean }; result: { line: string } };
  platforms: { params: Record<string, never>; result: Platform[] };
  brief: { params: { kind: BriefKind; platform: string; rules?: Rules }; result: { lines: string[] } };
  check: { params: { drafts: string[]; platform: string; rules?: Rules; original?: string }; result: DraftCheck[] };
  split: { params: { text: string; platform: string }; result: { posts: string[] } };
};
export type EngineVerb = keyof EngineVerbs;
export type EngineRequest = { [V in EngineVerb]: { verb: V; params: EngineVerbs[V]['params'] } }[EngineVerb];
export interface Engine {
  /** One request, one answer: the verb's result or `{ error: { code, message } }`. The kit validates the shape. */
  handle(request: EngineRequest): Promise<unknown>;
}
/** `engine` defaults to inProcessEngine(). */
export type ComposeOptions = { engine?: Engine };
/** Portable clients require the host to supply an engine; they never load the pinned Node engine. */
export type PortableComposeOptions = { engine: Engine };
export type ComposeErrorCode = 'missing' | 'needs-update' | 'engine' | 'invalid';
