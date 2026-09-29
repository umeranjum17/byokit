// The typed client over the Engine seam (docs/capability-kits.md 4.4): version gate, validation before the engine,
// error mapping. No state beyond the memoized hello, no file access, no env. Bodies land in BK-P1.
import type { BriefKind, ComposeOptions, DraftCheck, Engine, EngineHello, ParsedVoice, Platform, Rules } from './types.ts';

const notBuilt = (): never => { throw new Error('not built: BK-P1'); };

export class Compose {
  private readonly engine?: Engine;
  constructor(o: ComposeOptions = {}) {
    this.engine = o.engine;
  }
  hello(): Promise<EngineHello> { return notBuilt(); }
  readonly voice: {
    parse(markdown: string): Promise<ParsedVoice>;
    /** `post` defaults to false. */
    guide(rules: Rules, o?: { post?: boolean }): Promise<string>;
  } = { parse: notBuilt, guide: notBuilt };
  platforms(): Promise<Platform[]> { return notBuilt(); }
  brief(o: { kind: BriefKind; platform: string; rules?: Rules }): Promise<string[]> { void o; return notBuilt(); }
  check(o: { drafts: string[]; platform: string; rules?: Rules; original?: string }): Promise<DraftCheck[]> { void o; return notBuilt(); }
  split(o: { text: string; platform: string }): Promise<string[]> { void o; return notBuilt(); }
}
