// The fake engine (docs/capability-kits.md 4.7): its own small logic, no engine code copied.
import { PROTOCOL } from '../constants.ts';
import type { DraftCheck, Engine, EngineRequest, EngineVerb, ParsedVoice, Platform } from '../types.ts';

export type FakeEngineOptions = {
  /** Default PROTOCOL. */
  protocol?: number;
  /** Default '0.0.0-fake'. */
  version?: string;
  /** That verb answers the error envelope. */
  fail?: { verb: EngineVerb; code: string; message: string };
};
/** `requests`: every request, in order. */
export type FakeEngine = Engine & { requests: EngineRequest[] };

const SLOTS: [string, string, string] = [
  'Agree and add one concrete detail.',
  'Push back kindly, with one reason.',
  'Ask one sharp question.',
];

const PLATFORMS: Platform[] = [
  { id: 'x', label: 'X', kind: 'feed', limit: 280, slots: [...SLOTS] as [string, string, string], polish: 'The first line must stand alone.' },
  { id: 'linkedin', label: 'LinkedIn', kind: 'feed', limit: 3000, slots: [...SLOTS] as [string, string, string], polish: '' },
  { id: 'reddit', label: 'Reddit', kind: 'feed', limit: 10000, slots: [...SLOTS] as [string, string, string], polish: '' },
  { id: 'slack', label: 'Slack', kind: 'chat', limit: 40000, slots: [...SLOTS] as [string, string, string], polish: '' },
  { id: 'whatsapp', label: 'WhatsApp', kind: 'chat', limit: 65536, slots: [...SLOTS] as [string, string, string], polish: '' },
  { id: 'gmail', label: 'Gmail', kind: 'mail', limit: null, slots: [...SLOTS] as [string, string, string], polish: '' },
];

const STOCK = ['delve', 'game changer', 'seamless'];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A case-insensitive whole-word hit of the phrase in the text. */
function wholeWordHit(text: string, phrase: string): boolean {
  if (phrase === '') return false;
  return new RegExp(`\\b${escapeRegExp(phrase)}\\b`, 'i').test(text);
}

function platformOf(id: string): Platform | null {
  return PLATFORMS.find((platform) => platform.id === id) ?? null;
}

function unknownPlatform(id: string): { error: { code: string; message: string } } {
  return { error: { code: 'unknown-platform', message: `unknown platform "${id}"` } };
}

function parseVoice(markdown: string): ParsedVoice {
  const never: string[] = [];
  let skipped = 0;
  const noDashes = /em dash/i.test(markdown);
  let inNever = false;
  for (const line of markdown.split('\n')) {
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading !== null) {
      inNever = /never say/i.test(heading[1] ?? '');
      continue;
    }
    if (!inNever) continue;
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet === null) continue;
    let phrase = (bullet[1] ?? '').trim();
    const quoted = phrase.match(/["“](.+?)["”]/);
    phrase = (quoted?.[1] ?? phrase).trim();
    if (phrase === '' || phrase.length > 200) {
      skipped += 1;
      continue;
    }
    never.push(phrase);
  }
  return { rules: { never, noDashes, statementEndings: false, note: '' }, skipped };
}

function guideLine(rules: ParsedVoice['rules'], post: boolean): string {
  const parts: string[] = [];
  if (rules.noDashes) parts.push('No em dashes.');
  if (rules.statementEndings && post) parts.push('End on a statement, not a question.');
  if (rules.note !== '') parts.push(`How they write: ${rules.note}`);
  return parts.join(' ');
}

function digitRuns(text: string): string[] {
  return text.match(/\d+(?:[.,:]\d+)*/g) ?? [];
}

function listLines(text: string): number {
  return text.split('\n').filter((line) => /^\s*(?:[-*]|\d+\.)(\s|$)/.test(line)).length;
}

function checkOne(draft: string, platform: Platform, rules?: ParsedVoice['rules'], original?: string): DraftCheck {
  const limit = platform.limit;
  const length = draft.length;
  const fits = limit === null || length <= limit;
  const voice: string[] = [];
  if (rules !== undefined) {
    for (const phrase of rules.never) {
      if (wholeWordHit(draft, phrase)) voice.push(`says “${phrase}” from your never-say list`);
    }
  }
  const stock = STOCK.filter((phrase) => wholeWordHit(draft, phrase));
  let added: string[] = [];
  let dropped: string[] = [];
  if (original !== undefined) {
    const draftRuns = digitRuns(draft);
    const originalRuns = digitRuns(original);
    added = [...new Set(draftRuns.filter((run) => !originalRuns.includes(run)))];
    dropped = [...new Set(originalRuns.filter((run) => !draftRuns.includes(run)))];
  }
  const layoutKept = original === undefined || listLines(draft) === listLines(original);
  return { fits, length, limit, voice, stock, added, dropped, layoutKept, words: stock.length === 0 ? 'Sounds natural' : 'A bit stock' };
}

function splitText(text: string, platform: Platform): string[] {
  if (platform.limit === null) return [text];
  const limit = platform.limit;
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed === '') return [''];
  const sentences = collapsed.split(/(?<=[.!?]) +/);
  const posts: string[] = [];
  let current = '';
  const push = (post: string): void => { if (post !== '') posts.push(post); };
  for (const sentence of sentences) {
    if (sentence.length > limit) {
      push(current);
      current = '';
      let rest = sentence;
      while (rest.length > limit) {
        const at = rest.lastIndexOf(' ', limit);
        const cut = at < 0 ? limit : at;
        push(rest.slice(0, cut));
        rest = rest.slice(cut).replace(/^ +/, '');
      }
      current = rest;
      continue;
    }
    const next = current === '' ? sentence : `${current} ${sentence}`;
    if (next.length <= limit) {
      current = next;
    } else {
      push(current);
      current = sentence;
    }
  }
  push(current);
  return posts.length === 0 ? [''] : posts;
}

export function fakeEngine(o?: FakeEngineOptions): FakeEngine {
  const protocol = o?.protocol ?? PROTOCOL;
  const version = o?.version ?? '0.0.0-fake';
  const fail = o?.fail;
  const requests: EngineRequest[] = [];

  const answer = (request: EngineRequest): unknown => {
    if (fail !== undefined && fail.verb === request.verb) {
      return { error: { code: fail.code, message: fail.message } };
    }
    switch (request.verb) {
      case 'hello':
        return { protocol, version };
      case 'voice.parse':
        return parseVoice((request.params as { markdown: string }).markdown);
      case 'voice.guide': {
        const params = request.params as { rules: ParsedVoice['rules']; post: boolean };
        return { line: guideLine(params.rules, params.post) };
      }
      case 'platforms':
        return PLATFORMS.map((platform) => ({ ...platform, slots: platform.slots === undefined ? undefined : [...platform.slots] as [string, string, string] }));
      case 'brief': {
        const params = request.params as { kind: string; platform: string };
        const platform = platformOf(params.platform);
        if (platform === null) return unknownPlatform(params.platform);
        if (params.kind === 'reply') return { lines: [...(platform.slots ?? [])] };
        if (params.kind === 'polish') return { lines: platform.polish !== undefined && platform.polish !== '' ? [platform.polish] : [] };
        return { lines: [`One post for ${platform.label}.`] };
      }
      case 'check': {
        const params = request.params as { drafts: string[]; platform: string; rules?: ParsedVoice['rules']; original?: string };
        const platform = platformOf(params.platform);
        if (platform === null) return unknownPlatform(params.platform);
        return params.drafts.map((draft) => checkOne(draft, platform, params.rules, params.original));
      }
      case 'split': {
        const params = request.params as { text: string; platform: string };
        const platform = platformOf(params.platform);
        if (platform === null) return unknownPlatform(params.platform);
        return { posts: splitText(params.text, platform) };
      }
    }
  };

  return {
    requests,
    handle: async (request: EngineRequest): Promise<unknown> => {
      requests.push(request);
      return answer(request);
    },
  };
}
