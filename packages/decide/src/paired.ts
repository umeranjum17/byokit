import type { DeviceLink, Grant, LinkRequest } from '@byokit/link';
import type { Backend, Question, Raw } from './index.ts';
import { jev } from './jev.ts';
import { UnsupportedImagesError } from './images.ts';
import { parseUsage, type RetryOptions } from './http.ts';
import { hostProblem, PairedHostError, type PairedHostProblem } from './paired-errors.ts';

export const PAIRED_JEV_OP = 'decide.jev';
export type PairedJevLink = Pick<DeviceLink, 'status' | 'request'>;
type Via = 'typesafe' | 'openrouter';
type Reply = { v: 1; ok: true; answers: Record<string, Raw | undefined> } | { v: 1; ok: false; error: PairedHostProblem };
const fail = (error: PairedHostProblem): Reply => ({ v: 1, ok: false, error });

/** Host-owned lookup; an app can adapt its sealed secrets store or accounts member key route here. */
export type JevHostKeys = {
  get(device: Grant, via: Via): string | null | undefined | Promise<string | null | undefined>;
};

function timeout(value: number | undefined, fallback: number): number {
  const ms = value ?? fallback;
  if (!Number.isSafeInteger(ms) || ms <= 0 || ms > 2 ** 31 - 1) throw new RangeError('Decision timeout must be a positive timer duration.');
  return ms;
}

/** Phone backend: no credential or provider configuration is accepted from the device. */
export function pairedJev(opts: { link: PairedJevLink | null; timeoutMs?: number }): Backend {
  const ms = timeout(opts.timeoutMs, 30_000);
  return {
    name: 'jev-paired', leaves: true,
    async ask(state, questions, signal, images = []) {
      if (images.length) throw new UnsupportedImagesError('jev-paired');
      const link = opts.link;
      if (!link || link.status === 'removed') throw new PairedHostError('not-paired');
      if (link.status === 'refused') throw new PairedHostError('not-allowed');
      if (link.status !== 'online') throw new PairedHostError('host-offline');
      if (signal.aborted) throw new PairedHostError('cancelled');
      let onAbort!: () => void;
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => reject(new PairedHostError('cancelled'));
        signal.addEventListener('abort', onAbort, { once: true });
      });
      try {
        const response = await Promise.race([
          link.request(PAIRED_JEV_OP, { v: 1, state, questions }, { timeoutMs: ms, notValidAfter: Date.now() + ms }),
          cancelled,
        ]);
        if (!record(response) || response.v !== 1) throw new PairedHostError('request-failed');
        if (response.ok === false) throw new PairedHostError(hostProblem(response.error) ? response.error : 'request-failed');
        if (response.ok !== true || !record(response.answers)) throw new PairedHostError('request-failed');
        return cleanAnswers(response.answers, questions);
      } catch (e) {
        if (e instanceof PairedHostError) throw e;
        const code = record(e) ? e.code : undefined;
        if (code === 'removed' || code === 'not-paired' || code === 'ended') throw new PairedHostError('not-paired');
        if (code === 'not-allowed' || code === 'view-only' || code === 'wrong-host') throw new PairedHostError('not-allowed');
        if (code === 'unreachable' || code === 'timeout' || code === 'stopped' || code === 'too-late') throw new PairedHostError('host-offline');
        throw new PairedHostError('request-failed');
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    },
  };
}

/** Compose into Host.handle, behind Host.allow. Merely pairing never opts the host into billing. */
export function jevHost(opts: RetryOptions & {
  billing: 'api-key-billed-per-use';
  keys: JevHostKeys;
  via?: Via;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Allows the host app to withdraw billing consent without rebuilding the handler. */
  enabled?: (device: Grant) => boolean | Promise<boolean>;
}): (request: LinkRequest, device: Grant) => Promise<Reply> {
  if (opts.billing !== 'api-key-billed-per-use') throw new PairedHostError('disabled');
  const ms = timeout(opts.timeoutMs, 20_000);
  const via = opts.via ?? 'typesafe';
  if (via !== 'typesafe' && via !== 'openrouter') throw new PairedHostError('invalid-request');
  return async (request, device) => {
    if (request.op !== PAIRED_JEV_OP || !record(request.args) || request.args.v !== 1 ||
        Object.keys(request.args).some((k) => !['v', 'state', 'questions'].includes(k)) || !validQuestions(request.args.questions)) {
      return fail('invalid-request');
    }
    // Link authenticates and authorizes the grant before calling this handler. Keep all local errors in the
    // value envelope: Host.onError must never receive a key-bearing storage or provider exception.
    try {
      if (opts.enabled && await opts.enabled(device) !== true) return fail('disabled');
      const key = await opts.keys.get(device, via);
      if (typeof key !== 'string' || !key.trim()) return fail('key-missing');
      const controller = new AbortController();
      let timer!: ReturnType<typeof setTimeout>;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new PairedHostError('request-failed')); }, ms);
      });
      try {
        const answers = await Promise.race([
          jev({ ...opts, key, via }).ask(request.args.state, request.args.questions, controller.signal), deadline,
        ]);
        return { v: 1, ok: true, answers: cleanAnswers(answers, request.args.questions) };
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return fail('request-failed');
    }
  };
}

function record(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Bound the paid batch and validate every shape before looking up a key or invoking the provider. */
function validQuestions(value: unknown): value is Record<string, Question> {
  if (!record(value)) return false;
  const qs = Object.values(value);
  if (!qs.length || qs.length > 100) return false;
  return qs.every((q) => {
    if (!record(q)) return false;
    const common = ['kind', 'floor', 'images'];
    if (q.images !== undefined && (!Array.isArray(q.images) || q.images.length !== 0)) return false;
    const fields = q.kind === 'choice' ? [...common, 'options', 'instructions', 'floors']
      : q.kind === 'yesno' ? [...common, 'question', 'yes', 'no'] : [...common, 'levels', 'instructions'];
    if (Object.keys(q).some((k) => !fields.includes(k))) return false;
    if (q.floor !== undefined && !probability(q.floor)) return false;
    if (q.instructions !== undefined && typeof q.instructions !== 'string') return false;
    if (q.kind === 'yesno') return typeof q.question === 'string' &&
      (q.yes === undefined || typeof q.yes === 'string') && (q.no === undefined || typeof q.no === 'string');
    if (q.kind === 'score') return Array.isArray(q.levels) && q.levels.length > 0 && q.levels.length <= 100 && q.levels.every((l) => typeof l === 'string');
    if (q.kind !== 'choice' || !record(q.options)) return false;
    const options = Object.values(q.options);
    return options.length > 0 && options.length <= 100 && options.every((o) => typeof o === 'string') &&
      (q.floors === undefined || (record(q.floors) && Object.values(q.floors).every(probability)));
  });
}

function probability(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
}

/** Allowlist numeric decision fields only. Never return raw provider JSON, error text or arbitrary picks. */
function cleanAnswers(answers: Record<string, unknown>, questions: Record<string, Question>): Record<string, Raw | undefined> {
  return Object.fromEntries(Object.entries(questions).map(([name, q]) => {
    const a = Object.hasOwn(answers, name) ? answers[name] : undefined;
    if (!record(a)) return [name, undefined];
    const labels = q.kind === 'yesno' ? ['true', 'false'] : q.kind === 'choice' ? Object.keys(q.options) : q.levels.map((_, i) => String(i));
    const p = record(a.probabilities) ? a.probabilities : {};
    const valid = Object.keys(p).every((l) => labels.includes(l) && probability(p[l])) &&
      (a.confidence === undefined || probability(a.confidence)) &&
      (a.pick === undefined || (typeof a.pick === 'string' && labels.includes(a.pick)));
    const probabilities: Record<string, number> = valid ? Object.fromEntries(labels.flatMap((l) => {
      const v = Object.hasOwn(p, l) ? p[l] : undefined;
      return probability(v) ? [[l, v]] : [];
    })) : {};
    const usage = parseUsage(a.usage);
    return [name, { probabilities,
      ...(probability(a.confidence) && { confidence: a.confidence }),
      ...(typeof a.pick === 'string' && labels.includes(a.pick) && { pick: a.pick }),
      ...(usage && { usage }),
    }];
  }));
}
