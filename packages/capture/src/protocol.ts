// Wire parsers for recorder protocol v1 (docs/capability-kits.md 6, BK-C1). Each throws CaptureError('protocol') on
// a shape violation; parseHello checks the protocol range first and throws needs-update outside it (9.3 BK-C1).
import { PROTOCOL, PROTOCOL_FLOOR } from './constants.ts';
import { CaptureError } from './errors.ts';
import type { MakeResult, RecordEvent, RecorderHello } from './types.ts';

export type RecorderErrorLine = { code: string; message: string; hint?: string; extra: Record<string, unknown> };

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SOURCES = ['screen', 'x11', 'android'];
const EVENT_MODES = ['own', 'none'];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonObject(line: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new CaptureError('protocol', 'the recorder answered a line that is not JSON');
  }
  if (!isObject(value)) throw new CaptureError('protocol', 'the recorder answered an unexpected shape');
  return value;
}

function isAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && value.length > 1;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

export function parseHello(line: string): RecorderHello {
  const value = parseJsonObject(line);
  const protocol = value['protocol'];
  if (typeof protocol !== 'number' || !Number.isInteger(protocol)) {
    throw new CaptureError('protocol', 'the recorder answered an unexpected hello shape');
  }
  if (protocol < PROTOCOL_FLOOR || protocol > PROTOCOL) {
    throw new CaptureError(
      'needs-update',
      protocol < PROTOCOL_FLOOR
        ? `the recorder speaks protocol ${protocol} and this app needs at least ${PROTOCOL_FLOOR}`
        : `the recorder speaks protocol ${protocol} and this app speaks up to ${PROTOCOL}`,
      { why: protocol < PROTOCOL_FLOOR ? 'recorder' : 'app', detail: { protocol } },
    );
  }
  const recorder = value['recorder'];
  if (!isObject(recorder)) throw new CaptureError('protocol', 'the recorder answered an unexpected hello shape');
  const name = recorder['name'];
  const version = recorder['version'];
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    throw new CaptureError('protocol', 'the recorder answered an unexpected hello shape');
  }
  if (typeof version !== 'string' || version.length < 1 || version.length > 64) {
    throw new CaptureError('protocol', 'the recorder answered an unexpected hello shape');
  }
  const sources = value['sources'];
  if (
    !Array.isArray(sources) ||
    sources.length === 0 ||
    !sources.every((entry) => typeof entry === 'string' && SOURCES.includes(entry)) ||
    new Set(sources).size !== sources.length
  ) {
    throw new CaptureError('protocol', 'the recorder answered an unexpected hello shape');
  }
  const android = value['android'];
  if (typeof android !== 'boolean' || android !== (sources as string[]).includes('android')) {
    throw new CaptureError('protocol', 'the recorder answered an unexpected hello shape');
  }
  const events = value['events'];
  if (
    !Array.isArray(events) ||
    events.length === 0 ||
    !events.every((entry) => typeof entry === 'string' && EVENT_MODES.includes(entry)) ||
    new Set(events).size !== events.length ||
    !(events as string[]).includes('none')
  ) {
    throw new CaptureError('protocol', 'the recorder answered an unexpected hello shape');
  }
  const planner = value['planner'];
  if (!isObject(planner)) throw new CaptureError('protocol', 'the recorder answered an unexpected hello shape');
  if (typeof planner['available'] !== 'boolean' || typeof planner['needsKey'] !== 'boolean') {
    throw new CaptureError('protocol', 'the recorder answered an unexpected hello shape');
  }
  return {
    protocol,
    recorder: { name, version },
    sources: [...(sources as string[])] as RecorderHello['sources'],
    android,
    events: [...(events as string[])] as RecorderHello['events'],
    planner: { available: planner['available'] as boolean, needsKey: planner['needsKey'] as boolean },
  };
}

/** null for unknown events. */
export function parseEvent(line: string): RecordEvent | null {
  const value = parseJsonObject(line);
  if (!('event' in value)) return null;
  const event = value['event'];
  if (typeof event !== 'string') throw new CaptureError('protocol', 'the recorder answered an unexpected event shape');
  if (event === 'consent-pending') return { event: 'consent-pending' };
  if (event === 'recording') {
    const take = value['take'];
    if (!isAbsolutePath(take)) throw new CaptureError('protocol', 'the recorder answered an unexpected event shape');
    return { event: 'recording', take };
  }
  if (event === 'done') {
    const take = value['take'];
    const seconds = value['seconds'];
    const warnings = value['warnings'];
    if (!isAbsolutePath(take)) throw new CaptureError('protocol', 'the recorder answered an unexpected event shape');
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
      throw new CaptureError('protocol', 'the recorder answered an unexpected event shape');
    }
    if (!isStringArray(warnings)) {
      throw new CaptureError('protocol', 'the recorder answered an unexpected event shape');
    }
    return { event: 'done', take, seconds, warnings: [...warnings] };
  }
  return null;
}

/** Maps the wire's snake_case planner fields. */
export function parseMake(line: string): MakeResult {
  const value = parseJsonObject(line);
  const out = value['out'];
  if (out !== null && !isAbsolutePath(out)) {
    throw new CaptureError('protocol', 'the recorder answered an unexpected make shape');
  }
  const seconds = value['seconds'];
  const beats = value['beats'];
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    throw new CaptureError('protocol', 'the recorder answered an unexpected make shape');
  }
  if (typeof beats !== 'number' || !Number.isInteger(beats) || beats < 0) {
    throw new CaptureError('protocol', 'the recorder answered an unexpected make shape');
  }
  const planner = value['planner'];
  if (!isObject(planner)) throw new CaptureError('protocol', 'the recorder answered an unexpected make shape');
  const plannedTokens = planner['planned_tokens'];
  const inputTokens = planner['input_tokens'];
  const usd = planner['usd'];
  const failed = planner['failed'];
  if (typeof plannedTokens !== 'number' || !Number.isInteger(plannedTokens) || plannedTokens < 0) {
    throw new CaptureError('protocol', 'the recorder answered an unexpected make shape');
  }
  if (typeof inputTokens !== 'number' || !Number.isInteger(inputTokens) || inputTokens < 0) {
    throw new CaptureError('protocol', 'the recorder answered an unexpected make shape');
  }
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) {
    throw new CaptureError('protocol', 'the recorder answered an unexpected make shape');
  }
  if (typeof failed !== 'boolean') {
    throw new CaptureError('protocol', 'the recorder answered an unexpected make shape');
  }
  const warnings = value['warnings'];
  if (!isStringArray(warnings)) {
    throw new CaptureError('protocol', 'the recorder answered an unexpected make shape');
  }
  return {
    out,
    seconds,
    beats,
    planner: { plannedTokens, inputTokens, usd, failed },
    warnings: [...warnings],
  };
}

/** null when the line is not an error envelope. */
export function parseError(line: string): RecorderErrorLine | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObject(value)) return null;
  const error = value['error'];
  if (!isObject(error)) return null;
  if (typeof error['code'] !== 'string' || typeof error['message'] !== 'string') return null;
  const code = error['code'] as string;
  const message = error['message'] as string;
  if (code.length === 0) return null;
  const out: RecorderErrorLine = { code, message, extra: {} };
  if (typeof error['hint'] === 'string') out.hint = error['hint'] as string;
  for (const [key, entry] of Object.entries(error)) {
    if (key === 'code' || key === 'message' || key === 'hint') continue;
    (out.extra as Record<string, unknown>)[key] = entry;
  }
  return out;
}

/** The 6.7 table. */
export function toCaptureError(e: RecorderErrorLine): CaptureError {
  const hint = e.hint;
  const withHint = hint === undefined ? {} : { hint };
  switch (e.code) {
    case 'invalid-arguments':
      return new CaptureError('protocol', e.message, { ...withHint, detail: { recorderCode: e.code } });
    case 'unsupported-source':
      return new CaptureError('unsupported', e.message, withHint);
    case 'consent-cancelled':
      return new CaptureError('consent-cancelled', e.message, withHint);
    case 'consent-timeout':
      return new CaptureError('consent-timeout', e.message, withHint);
    case 'capture-stopped':
      return new CaptureError('stopped', e.message, withHint);
    case 'already-recording':
      return new CaptureError('already-recording', e.message, withHint);
    case 'preflight-refused': {
      const planned = e.extra['planned'];
      const cap = e.extra['cap'];
      const detail: Record<string, unknown> = {};
      if (typeof planned === 'number') detail['planned'] = planned;
      if (typeof cap === 'number') detail['cap'] = cap;
      return new CaptureError('preflight-refused', e.message, {
        ...withHint,
        ...(Object.keys(detail).length > 0 ? { detail } : {}),
      });
    }
    case 'take-input':
      return new CaptureError('take-input', e.message, withHint);
    case 'render-failed':
      return new CaptureError('render-failed', e.message, withHint);
    default:
      return new CaptureError('failed', e.message, { ...withHint, detail: { recorderCode: e.code } });
  }
}
