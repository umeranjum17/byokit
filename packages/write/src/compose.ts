// The typed client over the Engine seam (docs/capability-kits.md 4.4): version gate, validation before the engine,
// error mapping. No state beyond the memoized hello, no file access, no env.
import { PROTOCOL, PROTOCOL_FLOOR } from './constants.ts';
import { inProcessEngine } from './engine.ts';
import { ComposeError } from './errors.ts';
import type {
  BriefKind, ComposeOptions, DraftCheck, Engine, EngineHello, EngineRequest, ParsedVoice, Platform, Rules,
} from './types.ts';

const MAX_TEXT = 100_000;
const MAX_DRAFTS = 50;
const MAX_NOTE = 200;

const BRIEF_KINDS: readonly BriefKind[] = ['reply', 'polish', 'post', 'thread'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function checkText(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new ComposeError('invalid', `${what} must be a string`);
  if (value.includes('\0')) throw new ComposeError('invalid', `${what} must not contain NUL`);
  if (value.length > MAX_TEXT) throw new ComposeError('invalid', `${what} is over ${MAX_TEXT} characters`);
  return value;
}

function checkPlatform(value: unknown): string {
  const platform = checkText(value, 'platform');
  if (platform === '') throw new ComposeError('invalid', 'platform must not be empty');
  return platform;
}

function checkRules(value: unknown): Rules | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new ComposeError('invalid', 'rules must be an object');
  const { never, noDashes, statementEndings, note } = value;
  if (!Array.isArray(never) || never.some((entry) => typeof entry !== 'string')) {
    throw new ComposeError('invalid', 'rules.never must be a string array');
  }
  if (typeof noDashes !== 'boolean') throw new ComposeError('invalid', 'rules.noDashes must be a boolean');
  if (typeof statementEndings !== 'boolean') {
    throw new ComposeError('invalid', 'rules.statementEndings must be a boolean');
  }
  if (typeof note !== 'string') throw new ComposeError('invalid', 'rules.note must be a string');
  if (note.includes('\0')) throw new ComposeError('invalid', 'rules.note must not contain NUL');
  if (note.length > MAX_NOTE) throw new ComposeError('invalid', `rules.note is over ${MAX_NOTE} characters`);
  return { never: [...never] as string[], noDashes, statementEndings, note };
}

function checkRulesObject(value: unknown): Rules {
  const rules = checkRules(value);
  if (rules === undefined) throw new ComposeError('invalid', 'rules must be an object');
  return rules;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) return null;
  return [...value] as string[];
}

function asPlatform(value: unknown): Platform | null {
  if (!isRecord(value)) return null;
  const { id, label, kind, limit, slots, polish } = value;
  if (typeof id !== 'string' || id === '') return null;
  if (typeof label !== 'string' || label === '') return null;
  if (kind !== 'chat' && kind !== 'feed' && kind !== 'mail') return null;
  if (limit !== null && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0)) return null;
  const platform: Platform = { id, label, kind, limit };
  if (slots !== undefined) {
    if (!Array.isArray(slots) || slots.length !== 3 || slots.some((entry) => typeof entry !== 'string')) return null;
    platform.slots = [slots[0] as string, slots[1] as string, slots[2] as string];
  }
  if (polish !== undefined) {
    if (typeof polish !== 'string') return null;
    platform.polish = polish;
  }
  return platform;
}

function asDraftCheck(value: unknown): DraftCheck | null {
  if (!isRecord(value)) return null;
  const { fits, length, limit, voice, stock, added, dropped, layoutKept, words } = value;
  if (typeof fits !== 'boolean') return null;
  if (typeof length !== 'number' || !Number.isInteger(length) || length < 0) return null;
  if (limit !== null && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0)) return null;
  const stringArrays = { voice: asStringArray(voice), stock: asStringArray(stock), added: asStringArray(added), dropped: asStringArray(dropped) };
  if (Object.values(stringArrays).some((entry) => entry === null)) return null;
  if (typeof layoutKept !== 'boolean') return null;
  if (typeof words !== 'string') return null;
  return {
    fits, length, limit, voice: stringArrays.voice as string[], stock: stringArrays.stock as string[],
    added: stringArrays.added as string[], dropped: stringArrays.dropped as string[], layoutKept, words,
  };
}

function unexpectedShape(): ComposeError {
  return new ComposeError('engine', 'engine answered an unexpected shape');
}

export class Compose {
  private readonly options: ComposeOptions;
  private defaultEngine: Engine | null = null;
  private helloPromise: Promise<EngineHello> | null = null;
  private gateError: ComposeError | null = null;

  constructor(o: ComposeOptions = {}) {
    this.options = o;
  }

  private engine(): Engine {
    if (this.options.engine !== undefined) return this.options.engine;
    if (this.defaultEngine === null) this.defaultEngine = inProcessEngine();
    return this.defaultEngine;
  }

  private async request<V>(verb: EngineRequest['verb'], params: object): Promise<V> {
    const answer = await this.engine().handle({ verb, params } as EngineRequest);
    if (isRecord(answer) && isRecord(answer['error'])) {
      const { code, message } = answer['error'] as Record<string, unknown>;
      if (typeof code === 'string' && typeof message === 'string') {
        throw new ComposeError('engine', message, { engineCode: code });
      }
      throw unexpectedShape();
    }
    return answer as V;
  }

  /** The memoized hello behind the version gate (4.4): out-of-range protocols fail every call closed. */
  private gatedHello(): Promise<EngineHello> {
    if (this.gateError !== null) return Promise.reject(this.gateError);
    if (this.helloPromise === null) {
      this.helloPromise = this.request<EngineHello>('hello', {}).then((hello) => {
        if (!isRecord(hello) || typeof hello['protocol'] !== 'number' || !Number.isInteger(hello['protocol']) ||
          typeof hello['version'] !== 'string' || hello['version'] === '') {
          throw unexpectedShape();
        }
        const protocol = hello['protocol'] as number;
        if (protocol < PROTOCOL_FLOOR || protocol > PROTOCOL) {
          this.gateError = new ComposeError('needs-update', `engine protocol ${protocol} is outside ${PROTOCOL_FLOOR}–${PROTOCOL}`, { protocol });
          throw this.gateError;
        }
        return { protocol, version: hello['version'] as string };
      }).catch((e: unknown) => {
        if (!(e instanceof ComposeError)) throw e;
        if (e.code === 'needs-update' && this.gateError === null) this.gateError = e;
        if (this.gateError !== null) throw this.gateError;
        // A hello that fails any other way is not memoized: the next call tries again.
        this.helloPromise = null;
        throw e;
      });
    }
    return this.helloPromise;
  }

  hello(): Promise<EngineHello> {
    return this.gatedHello();
  }

  readonly voice: {
    parse(markdown: string): Promise<ParsedVoice>;
    /** `post` defaults to false. */
    guide(rules: Rules, o?: { post?: boolean }): Promise<string>;
  } = {
    parse: async (markdown: string): Promise<ParsedVoice> => {
      const text = checkText(markdown, 'markdown');
      await this.gatedHello();
      const result = await this.request<unknown>('voice.parse', { markdown: text });
      if (!isRecord(result) || !isRecord(result['rules']) || typeof result['skipped'] !== 'number' ||
        !Number.isInteger(result['skipped'] as number) || (result['skipped'] as number) < 0) {
        throw unexpectedShape();
      }
      const rules = result['rules'] as Record<string, unknown>;
      const { never, noDashes, statementEndings, note } = rules;
      if (!Array.isArray(never) || never.some((entry) => typeof entry !== 'string') ||
        typeof noDashes !== 'boolean' || typeof statementEndings !== 'boolean' || typeof note !== 'string') {
        throw unexpectedShape();
      }
      return {
        rules: { never: [...never] as string[], noDashes, statementEndings, note },
        skipped: result['skipped'] as number,
      };
    },
    guide: async (rules: Rules, o?: { post?: boolean }): Promise<string> => {
      const checked = checkRulesObject(rules);
      const post = o?.post ?? false;
      if (typeof post !== 'boolean') throw new ComposeError('invalid', 'post must be a boolean');
      await this.gatedHello();
      const result = await this.request<unknown>('voice.guide', { rules: checked, post });
      if (!isRecord(result) || typeof result['line'] !== 'string') throw unexpectedShape();
      return result['line'] as string;
    },
  };

  async platforms(): Promise<Platform[]> {
    await this.gatedHello();
    const result = await this.request<unknown>('platforms', {});
    if (!Array.isArray(result)) throw unexpectedShape();
    const platforms: Platform[] = [];
    for (const entry of result) {
      const platform = asPlatform(entry);
      if (platform === null) throw unexpectedShape();
      platforms.push(platform);
    }
    return platforms;
  }

  async brief(o: { kind: BriefKind; platform: string; rules?: Rules }): Promise<string[]> {
    if (!isRecord(o)) throw new ComposeError('invalid', 'brief takes { kind, platform, rules? }');
    if (!BRIEF_KINDS.includes(o['kind'] as BriefKind)) {
      throw new ComposeError('invalid', 'kind must be reply, polish, post or thread');
    }
    const kind = o['kind'] as BriefKind;
    const platform = checkPlatform(o['platform']);
    const rules = checkRules(o['rules']);
    await this.gatedHello();
    const params = rules === undefined ? { kind, platform } : { kind, platform, rules };
    const result = await this.request<unknown>('brief', params);
    if (!isRecord(result) || !Array.isArray(result['lines']) ||
      result['lines'].some((entry) => typeof entry !== 'string')) {
      throw unexpectedShape();
    }
    return [...result['lines']] as string[];
  }

  async check(o: { drafts: string[]; platform: string; rules?: Rules; original?: string }): Promise<DraftCheck[]> {
    if (!isRecord(o)) throw new ComposeError('invalid', 'check takes { drafts, platform, rules?, original? }');
    if (!Array.isArray(o['drafts']) || o['drafts'].length < 1 || o['drafts'].length > MAX_DRAFTS) {
      throw new ComposeError('invalid', `drafts must have 1–${MAX_DRAFTS} entries`);
    }
    const drafts = (o['drafts'] as unknown[]).map((draft, i) => checkText(draft, `drafts[${i}]`));
    const platform = checkPlatform(o['platform']);
    const rules = checkRules(o['rules']);
    const original = o['original'] === undefined ? undefined : checkText(o['original'], 'original');
    await this.gatedHello();
    const params = { drafts, platform, ...(rules === undefined ? {} : { rules }), ...(original === undefined ? {} : { original }) };
    const result = await this.request<unknown>('check', params);
    if (!Array.isArray(result) || result.length !== drafts.length) throw unexpectedShape();
    return result.map((entry) => {
      const parsed = asDraftCheck(entry);
      if (parsed === null) throw unexpectedShape();
      return parsed;
    });
  }

  async split(o: { text: string; platform: string }): Promise<string[]> {
    if (!isRecord(o)) throw new ComposeError('invalid', 'split takes { text, platform }');
    const text = checkText(o['text'], 'text');
    const platform = checkPlatform(o['platform']);
    await this.gatedHello();
    const result = await this.request<unknown>('split', { text, platform });
    if (!isRecord(result) || !Array.isArray(result['posts']) ||
      result['posts'].some((entry) => typeof entry !== 'string')) {
      throw unexpectedShape();
    }
    return [...result['posts']] as string[];
  }
}
