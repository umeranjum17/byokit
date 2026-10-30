// Node-only seam: the host names the person's own unmodified, already signed-in Codex binary; it runs with their HOME.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Backend } from './index.ts';
import type { Generated, GenerationBackend, GenerationRequest } from './generate.ts';
import { parseUsage } from './http.ts';
import { outputSchema, type OutputSchema } from './schema.ts';
import { generationImages } from './generation-images.ts';
import { validateImageReferences } from './images.ts';
import { parsedAnswers, responsesInstructions, responsesSchema } from './responses-wire.ts';
import { runCli } from './cli-run.ts';
import { validOutputBudget } from './generation-budget.ts';

/** A Codex account's environment from `@byokit/accounts/cli` (`launch(id)` when ready, or `launchEnv(id)`): a managed
 * account sets its own `CODEX_HOME`; the installed one sets nothing, so the person's own sign-in answers. */
export type CodexAccount = { set: Record<string, string>; unset: readonly string[] };
export type CodexOptions = { bin: string; account?: CodexAccount; model?: string; timeoutMs: number };
export type CodexBackend = Backend & GenerationBackend & { readonly billing: 'subscription' };
type FailureCode = 'invalid_json' | 'invalid_output' | 'process' | 'subscription_required' | 'timeout' | 'aborted';
const messages: Record<FailureCode, string> = {
  invalid_json: 'The model returned invalid JSON.',
  invalid_output: 'The answer did not match the output schema.',
  process: 'The model could not answer. Check that Codex is signed in on this computer: run `codex` once.',
  subscription_required: 'Sign in to Codex with your ChatGPT plan on this computer: run `codex login` once.',
  timeout: 'The answer took too long.',
  aborted: 'The answer was cancelled.',
};
export class CodexError extends Error {
  readonly code: FailureCode;
  constructor(code: FailureCode) { super(messages[code]); this.name = 'CodexError'; this.code = code; }
}

const record = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);
const billingRoutes = new Set(['OPENAI_BASE_URL', 'CODEX_OSS_BASE_URL']);
// A judge, not an agent: no tools, plugins, hooks, skills, project docs or user config; ChatGPT sign-in only.
// ponytail: --ignore-user-config also drops a config.toml `cli_auth_credentials_store = "keyring"`, so a keyring-stored
// login fails as `process`; pass the store mode through when a host needs it.
const config = ['features.shell_tool=false', 'features.unified_exec=false', 'features.apps=false', 'features.plugins=false',
  'features.multi_agent=false', 'features.hooks=false', 'features.image_generation=false', 'web_search="disabled"',
  'approval_policy="never"', 'forced_login_method="chatgpt"', 'project_doc_max_bytes=0', 'skills.include_instructions=false',
  'include_permissions_instructions=false', 'include_apps_instructions=false', 'include_environment_context=false',
  'include_collaboration_mode_instructions=false'];

/** No credential access, login implementation, own sign-in folder, or API-key fallback. */
export function codex(options: CodexOptions): CodexBackend {
  const { account } = options;
  if (account !== undefined && (!record(account) || !record(account.set) || !Array.isArray(account.unset)
      || Object.keys(account.set).some((k) => k !== 'CODEX_HOME') || account.unset.some((k) => typeof k !== 'string'))) {
    throw new Error('Pass a Codex account from @byokit/accounts.');
  }
  const home = account?.set.CODEX_HOME;
  if (!isAbsolute(options.bin) || (home !== undefined && !isAbsolute(home))) throw new Error('Supply an absolute binary path and account folder.');
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 2_147_483_647 ||
      (options.model !== undefined && (typeof options.model !== 'string' || !options.model.trim()))) {
    throw new Error('The model or timeout is invalid.');
  }
  const o = { ...options };
  const unset = new Set(account?.unset);
  const run = async (input: GenerationRequest): Promise<Generated> => {
    const validator = outputSchema(input.schema);
    const images = generationImages(input.images);
    if (input.signal?.aborted) throw new CodexError('aborted');
    const maxOutputTokens = input.maxOutputTokens ?? 16_384;
    // ponytail: validated like the Claude seam, but codex exec has no output cap flag; add it when Codex ships one.
    if (!validOutputBudget(maxOutputTokens)) throw new Error('The output budget is invalid.');
    let scratch: string;
    try { scratch = await mkdtemp(join(tmpdir(), 'byokit-codex-')); } catch { throw new CodexError('process'); }
    try {
      const schemaFile = join(scratch, 'schema.json');
      const files = images.map((image, i) => join(scratch, `image-${i}.${image.mime === 'image/png' ? 'png' : 'jpg'}`));
      try {
        await writeFile(schemaFile, validator.json);
        await Promise.all(images.map((image, i) => writeFile(files[i], Buffer.from(image.dataUrl.slice(image.dataUrl.indexOf(',') + 1), 'base64'))));
      } catch { throw new CodexError('process'); }
      // TOML basic string: JSON's escapes are valid TOML, plus DEL, which JSON leaves raw.
      const system = input.system ? [`developer_instructions=${JSON.stringify(input.system).replaceAll('\x7f', '\\u007f')}`] : [];
      const args = ['exec', '--json', '--output-schema', schemaFile, '--ephemeral', '--skip-git-repo-check', '--ignore-user-config',
        '--ignore-rules', '--sandbox', 'read-only', '--cd', scratch, ...(o.model ? ['--model', o.model] : []),
        ...files.map((file) => `--image=${file}`), ...[...config, ...system].flatMap((c) => ['-c', c]), '-'];
      const deadline = Date.now() + o.timeoutMs;
      // The person's own environment so their installed Codex answers with its own sign-in; minus API keys, billing-route and preload variables.
      const env = {
        ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !unset.has(k) && !/KEY|TOKEN|SECRET|^NODE_OPTIONS$/i.test(k) && !billingRoutes.has(k))),
        ...(home !== undefined && { CODEX_HOME: home }),
      };
      const execute = (args: string[], stdin?: string) =>
        runCli(o.bin, args, { cwd: scratch, env, deadline, signal: input.signal, stdin }, (code) => new CodexError(code));
      // Ask the binary for its own sign-in method; never inspect its credential files. Its status text may name a masked key, so it is never shown.
      const auth = await execute(['login', 'status']);
      if (auth.code !== 0 && auth.code !== 1) throw new CodexError('process');
      if (auth.code !== 0 || !/^Logged in using ChatGPT\b/m.test(auth.stdout + auth.stderr)) throw new CodexError('subscription_required');
      const prompt = (images.length ? `Images, in attachment order: ${images.map((image) => image.id).join(', ')}\n\n` : '') + input.prompt;
      const out = await execute(args, prompt);
      if (out.code !== 0) throw new CodexError('process');
      // JSONL events; the turn's last agent message carries the answer.
      let text: string | undefined;
      let done: Record<string, any> | undefined;
      for (const line of out.stdout.split('\n')) {
        if (!line.trim()) continue;
        let event: unknown;
        try { event = JSON.parse(line); } catch { throw new CodexError('invalid_json'); }
        if (!record(event)) throw new CodexError('invalid_json');
        if (event.type === 'turn.failed') throw new CodexError('process');
        if (event.type === 'item.completed' && record(event.item) && event.item.type === 'agent_message' && typeof event.item.text === 'string') text = event.item.text;
        if (event.type === 'turn.completed') done = event;
      }
      if (!done) throw new CodexError('process');
      if (text === undefined) throw new CodexError('invalid_json');
      const validated = validator.parse(text);
      if (!validated) throw new CodexError('invalid_output');
      return { data: validated.data, text, usage: parseUsage(done.usage), raw: done };
    } finally { await rm(scratch, { recursive: true, force: true }); }
  };
  return {
    name: 'codex', model: o.model ?? 'subscription-default', leaves: true, billing: 'subscription', supportsImages: true,
    cacheIdentity: JSON.stringify({ bin: o.bin, codexHome: home }),
    generate: run,
    async ask(state, questions, signal, inputImages) {
      const images = generationImages(inputImages);
      validateImageReferences(questions, images);
      const result = await run({ schema: responsesSchema(questions) as OutputSchema, signal, images,
        system: responsesInstructions(questions), prompt: JSON.stringify({ state, questions }) });
      return parsedAnswers(questions, result.data, result.usage, result.raw);
    },
  };
}
