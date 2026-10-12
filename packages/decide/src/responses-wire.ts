// Shared OpenAI Responses wire format for decision backends (OpenAI itself and OpenCode Go subscription
// plans served over the same Responses shape): prompt assembly, the JSON schema for typed answers, and
// answer parsing with reported usage. Backends differ only in endpoint, credential, and catalogue handling.
import type { Question, Raw } from './core.ts';
import { parseUsage } from './http.ts';
import type { DecisionImage } from './images.ts';
import { STATE_INSTRUCTIONS } from './prompt.ts';

export const isJsonRecord = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);

export function responsesInstructions(questions: Record<string, Question>, extraInstructions?: string): string {
  return STATE_INSTRUCTIONS +
    'Give every answer key a self-reported probability between 0 and 1, summing to 1 per question, and pick one key. ' +
    'Include a short rationale for choice, yesno and score questions. These are your estimates, not calibrated confidence scores.' +
    (Object.values(questions).some((q) => q.kind === 'rank') ?
      ' For rank questions, order every candidate id exactly once, best first, and estimate your confidence in the whole ordering. ' +
      'Scores are optional: use null if you did not assign scores; otherwise provide a number for each candidate on your chosen scale.' : '') +
    (Object.values(questions).some((q) => q.personReason) ?
      ' For questions requesting personReason, give one short plain sentence (at most 160 characters), safe to show a person. ' +
      'Do not include secrets, diagnostics or markup.' : '') + (extraInstructions ? `\n${extraInstructions}` : '');
}

export function responsesInput(state: unknown, questions: Record<string, Question>, images: readonly DecisionImage[]) {
  return [{ role: 'user' as const, content: images.length ? [
    { type: 'input_text', text: JSON.stringify({ state, questions, images: images.map(({ id, mime }) => ({ id, mime })) }) },
    ...images.flatMap((image) => [
      { type: 'input_text', text: `Image: ${image.id}` },
      { type: 'input_image', image_url: image.dataUrl, detail: 'auto' },
    ]),
  ] : JSON.stringify({ state, questions }) }];
}

export function responsesSchema(questions: Record<string, Question>) {
  const properties = Object.fromEntries(Object.entries(questions).map(([name, q]) => {
    const explanation = q.personReason ? { personReason: { type: 'string' } } : {};
    const reasonKeys = q.personReason ? ['personReason'] : [];
    if (q.kind === 'rank') {
      const keys = Object.keys(q.candidates);
      return [name, { type: 'object', additionalProperties: false, required: ['ranking', 'confidence', 'scores', ...reasonKeys],
        properties: {
          ranking: { type: 'array', items: { type: 'string', enum: keys }, minItems: keys.length, maxItems: keys.length },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          scores: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, required: keys,
            properties: Object.fromEntries(keys.map((k) => [k, { type: 'number' }])) }] },
          ...explanation,
        } }];
    }
    const keys = q.kind === 'choice' ? Object.keys(q.options) : q.kind === 'yesno' ? ['true', 'false'] : q.levels.map((_, i) => String(i));
    return [name, { type: 'object', additionalProperties: false, required: ['probabilities', 'pick', 'rationale', ...reasonKeys],
      properties: {
        probabilities: { type: 'object', additionalProperties: false, required: keys,
          properties: Object.fromEntries(keys.map((k) => [k, { type: 'number', minimum: 0, maximum: 1 }])) },
        pick: { type: 'string', enum: keys },
        rationale: { type: 'string' },
        ...explanation,
      },
    }];
  }));
  return { type: 'object', additionalProperties: false, required: Object.keys(questions), properties };
}

export function responsesAnswers(questions: Record<string, Question>, json: unknown, outputText?: string): Record<string, Raw> {
  const usage = parseUsage(isJsonRecord(json) ? json.usage : undefined);
  let parsed: unknown;
  if (isJsonRecord(json) && json.status === 'completed' && Array.isArray(json.output) && !json.error) {
    const contents = json.output.filter((item: unknown) => isJsonRecord(item) && item.type === 'message')
      .flatMap((item: any) => Array.isArray(item.content) ? item.content : []);
    if (!contents.some((c: unknown) => isJsonRecord(c) && c.type === 'refusal')) {
      const text = outputText ?? contents.filter((c: unknown) => isJsonRecord(c) && c.type === 'output_text' && typeof c.text === 'string')
        .map((c: any) => c.text).join('');
      try { parsed = JSON.parse(text); } catch { /* malformed text abstains, carrying the response */ }
    }
  }
  return Object.fromEntries(Object.entries(questions).map(([k, q]) => {
    const a = isJsonRecord(parsed) && Object.hasOwn(parsed, k) ? parsed[k] : undefined;
    const carried = { confidenceSource: 'self-reported' as const, ...(usage && { usage }), raw: json,
      ...(typeof a?.rationale === 'string' && { rationale: a.rationale }) };
    if (q.kind === 'rank') return [k, { probabilities: {},
      ...(isJsonRecord(a) && { ranking: a.ranking, confidence: a.confidence,
        ...(a.scores !== null && a.scores !== undefined && { scores: a.scores }),
        ...(q.personReason && { personReason: a.personReason }) }), ...carried } satisfies Raw];
    const valid = isJsonRecord(a) && isJsonRecord(a.probabilities) && typeof a.pick === 'string';
    return [k, { probabilities: valid ? a.probabilities : {}, ...(valid && { pick: a.pick }),
      ...(valid && q.personReason && { personReason: a.personReason }), ...carried } satisfies Raw];
  }));
}

/** Keep the completed full response (including usage), never infer success from text deltas. Handles chunk
 * boundaries, CRLF, multiline data and the non-streaming fetch fallback used on phones. */
export async function readResponsesStream(res: Response): Promise<unknown> {
  const events: unknown[] = [];
  let terminal: Record<string, any> | undefined;
  let last: Record<string, any> | undefined;
  let malformed = false;
  const event = (frame: string) => {
    const data = frame.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    let e: unknown;
    try { e = JSON.parse(data); } catch { malformed = true; return; }
    events.push(e);
    if (!isJsonRecord(e)) { malformed = true; return; }
    if (isJsonRecord(e.response)) last = e.response;
    if (['response.completed', 'response.failed', 'response.incomplete'].includes(e.type)) {
      if (terminal || !isJsonRecord(e.response)) malformed = true;
      else terminal = { ...e.response, status: e.type === 'response.completed' ? e.response.status : e.type.slice(9) };
    }
    if (e.type === 'error') malformed = true;
  };
  let pending = '';
  const push = (chunk: string) => {
    pending += chunk;
    let match: RegExpExecArray | null;
    while ((match = /\r?\n\r?\n/.exec(pending))) {
      event(pending.slice(0, match.index));
      pending = pending.slice(match.index + match[0].length);
    }
  };
  if (res.body?.getReader) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        push(decoder.decode(part.value, { stream: true }));
      }
      push(decoder.decode());
    } finally { reader.releaseLock(); }
  } else push(await res.text());
  if (pending.trim()) event(pending);
  if (terminal && !malformed) return terminal;
  return { status: 'incomplete', ...(last?.usage && { usage: last.usage }), events };
}
