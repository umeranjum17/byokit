// Node-only seam: the host names the person's own installed pi binary; it runs with their HOME and its own provider keys.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Backend } from './index.ts';
import type { Generated, GenerationBackend, GenerationRequest } from './generate.ts';
import { parseUsage } from './http.ts';
import { outputSchema, type OutputSchema } from './schema.ts';
import { parsedAnswers, responsesInstructions, responsesSchema } from './responses-wire.ts';
import { runCli } from './cli-run.ts';

export type PiOptions = { bin: string; model?: string; timeoutMs: number };
export type PiBackend = Backend & GenerationBackend;
type FailureCode = 'invalid_json' | 'invalid_output' | 'process' | 'timeout' | 'aborted';
const messages: Record<FailureCode, string> = {
  invalid_json: 'The model returned invalid JSON.',
  invalid_output: 'The answer did not match the output schema.',
  process: 'The model could not answer. Check that pi is set up on this computer, with a key for the chosen model: run `pi` once.',
  timeout: 'The answer took too long.',
  aborted: 'The answer was cancelled.',
};
export class PiError extends Error {
  readonly code: FailureCode;
  constructor(code: FailureCode) { super(messages[code]); this.name = 'PiError'; this.code = code; }
}

const record = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The installed pi runs once in JSON mode with no tools, extensions, skills, context files or session; its own key answers. */
export function pi(options: PiOptions): PiBackend {
  if (!isAbsolute(options.bin)) throw new Error('Supply an absolute binary path.');
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 2_147_483_647 ||
      (options.model !== undefined && (typeof options.model !== 'string' || !options.model.trim()))) {
    throw new Error('The model or timeout is invalid.');
  }
  const o = { ...options };
  const run = async (input: GenerationRequest): Promise<Generated> => {
    const validator = outputSchema(input.schema);
    if (input.signal?.aborted) throw new PiError('aborted');
    const maxOutputTokens = input.maxOutputTokens ?? 16_384;
    // ponytail: validated like the other seams, but pi has no output cap flag; add it when pi ships one.
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 16_384) throw new Error('The output budget is invalid.');
    let scratch: string;
    try { scratch = await mkdtemp(join(tmpdir(), 'byokit-pi-')); } catch { throw new PiError('process'); }
    try {
      const systemFile = join(scratch, 'system.md');
      const system = [input.system, validator.prompt].filter(Boolean).join('\n\n');
      try { await writeFile(systemFile, system); } catch { throw new PiError('process'); }
      const args = ['--mode', 'json', '--no-session', '--no-tools', '--no-extensions', '--no-skills', '--no-prompt-templates',
        '--no-context-files', '--no-approve', '--system-prompt', systemFile, ...(o.model ? ['--model', o.model] : [])];
      const deadline = Date.now() + o.timeoutMs;
      // The person's own environment so their installed pi answers with its own provider keys; only preload variables are dropped.
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_OPTIONS'));
      const out = await runCli(o.bin, args, { cwd: scratch, env, deadline, signal: input.signal, stdin: input.prompt },
        (code) => new PiError(code));
      if (out.code !== 0) throw new PiError('process');
      // JSONL events; the last assistant message is the answer, and agent_settled ends the run.
      let assistant: Record<string, any> | undefined;
      let done: Record<string, any> | undefined;
      for (const line of out.stdout.split('\n')) {
        if (!line.trim()) continue;
        let event: unknown;
        try { event = JSON.parse(line); } catch { throw new PiError('invalid_json'); }
        if (!record(event)) throw new PiError('invalid_json');
        if (event.type === 'message_end' && record(event.message) && event.message.role === 'assistant') assistant = event.message;
        if (event.type === 'agent_settled') done = event;
      }
      if (!done || !assistant) throw new PiError('process');
      if (assistant.stopReason === 'error' || assistant.stopReason === 'aborted') throw new PiError('process');
      const text = (Array.isArray(assistant.content) ? assistant.content : [])
        .filter((part: unknown) => record(part) && part.type === 'text' && typeof part.text === 'string')
        .map((part: Record<string, any>) => part.text).join('');
      const validated = validator.parse(text);
      if (!validated) throw new PiError('invalid_output');
      const usage = record(assistant.usage) ? parseUsage({ input_tokens: assistant.usage.input, output_tokens: assistant.usage.output }) : undefined;
      return { data: validated.data, text, usage, raw: assistant };
    } finally { await rm(scratch, { recursive: true, force: true }); }
  };
  return {
    name: 'pi', model: o.model ?? 'pi-default', leaves: true, supportsImages: false,
    cacheIdentity: JSON.stringify({ bin: o.bin }),
    generate: run,
    async ask(state, questions, signal) {
      const result = await run({ schema: responsesSchema(questions) as OutputSchema, signal,
        system: responsesInstructions(questions), prompt: JSON.stringify({ state, questions }) });
      return parsedAnswers(questions, result.data, result.usage, result.raw);
    },
  };
}
