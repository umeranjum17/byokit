#!/usr/bin/env node
// `write` — the agent CLI (docs/capability-kits.md 4.6): TOON or `key: value` output, `error:` lines on stderr,
// exit 0 pass / 1 a draft fails / 2 usage / 3 engine missing or needs-update / 4 other engine failure.
// Reads only the files named on its command line; no env, no writes, no network.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Compose } from './compose.ts';
import { inProcessEngine } from './engine.ts';
import { ComposeError } from './errors.ts';
import type { BriefKind, Engine, Rules } from './types.ts';
import { draftPasses, words } from './words.ts';

export type CliIo = {
  engine?: Engine;
  stdout(s: string): void;
  stderr(s: string): void;
  readFile(path: string): string;
};

const USAGE: Record<string, string> = {
  hello: 'write hello',
  platforms: 'write platforms',
  'voice parse': "write voice parse <file>",
  'voice guide': "write voice guide --voice '<rules json>' [--post]",
  brief: "write brief --kind reply|polish|post|thread --platform <id> [--voice '<rules json>']",
  check: "write check --platform <id> [--voice '<rules json>'] [--original <file>] <draft file>...",
  split: 'write split --platform <id> <file>',
};
const TOP_HELP = 'write <hello|platforms|voice parse|voice guide|brief|check|split>';

class UsageError extends Error {
  readonly help: string;
  constructor(message: string, help: string) {
    super(message);
    this.name = 'UsageError';
    this.help = help;
  }
}

/** A value printed bare, unless it needs quoting to survive a paste back. */
function cell(value: string): string {
  if (value === '' || value !== value.trim() || /[,"\n:]/.test(value)) return JSON.stringify(value);
  return value;
}

function readVoice(raw: string | undefined, help: string): Rules | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new UsageError('--voice is not valid rules JSON', help);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new UsageError('--voice is not valid rules JSON', help);
  }
  return parsed as Rules;
}

function readFile(io: CliIo, path: string, help: string): string {
  try {
    return io.readFile(path);
  } catch {
    throw new UsageError(`cannot read "${path}"`, help);
  }
}

type ParsedFlags = { kind?: string; platform?: string; voice?: string; original?: string; post: boolean; rest: string[] };

function parseFlags(args: string[], help: string, flagKinds: Record<string, 'value' | 'bool'>): ParsedFlags {
  const flags: ParsedFlags = { post: false, rest: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (!arg.startsWith('--')) {
      flags.rest.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const kind = flagKinds[name];
    if (kind === undefined) throw new UsageError(`unknown flag "--${name}"`, help);
    if (kind === 'bool') {
      if (name === 'post') flags.post = true;
      continue;
    }
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`--${name} needs a value`, help);
    i += 1;
    if (name === 'kind') flags.kind = value;
    else if (name === 'platform') flags.platform = value;
    else if (name === 'voice') flags.voice = value;
    else if (name === 'original') flags.original = value;
  }
  return flags;
}

function needPlatformId(flags: ParsedFlags, help: string): string {
  if (flags.platform === undefined) throw new UsageError('--platform is required', help);
  return flags.platform;
}

/** The platform id, checked against the engine's own list before the verb runs. */
async function knownPlatform(compose: Compose, id: string, help: string): Promise<{ label: string }> {
  const platforms = await compose.platforms();
  const found = platforms.find((platform) => platform.id === id);
  if (found === undefined) {
    throw new UsageError(
      `unknown platform "${id}". Pick one of: ${platforms.map((platform) => platform.id).join(', ')}`, help,
    );
  }
  return { label: found.label };
}

export async function main(argv: string[], io: CliIo): Promise<number> {
  const out: string[] = [];
  const emit = (): void => { io.stdout(out.join('')); out.length = 0; };
  const run = async (): Promise<number> => {
    const [verb, ...rest] = argv;
    if (verb === undefined) throw new UsageError('no command', TOP_HELP);
    if (verb === 'hello' || verb === 'platforms') {
      if (rest.length > 0) throw new UsageError(`too many arguments`, USAGE[verb] as string);
      const compose = new Compose(io.engine === undefined ? { engine: inProcessEngine() } : { engine: io.engine });
      if (verb === 'hello') {
        const hello = await compose.hello();
        out.push(`protocol: ${cell(String(hello.protocol))}\nversion: ${cell(hello.version)}\n`);
        return 0;
      }
      const platforms = await compose.platforms();
      out.push(`platforms[${platforms.length}]{id,label,kind,limit}:\n`);
      for (const platform of platforms) {
        out.push(`  ${cell(platform.id)},${cell(platform.label)},${cell(platform.kind)},${cell(platform.limit === null ? 'none' : String(platform.limit))}\n`);
      }
      return 0;
    }
    if (verb === 'voice') {
      const [sub, ...subRest] = rest;
      if (sub === 'parse') {
        const help = USAGE['voice parse'] as string;
        const flags = parseFlags(subRest, help, {});
        if (flags.rest.length !== 1) throw new UsageError('voice parse takes one file', help);
        const markdown = readFile(io, flags.rest[0] as string, help);
        const compose = new Compose(io.engine === undefined ? { engine: inProcessEngine() } : { engine: io.engine });
        const parsed = await compose.voice.parse(markdown);
        out.push(`rules: ${JSON.stringify(parsed.rules)}\nskipped: ${cell(String(parsed.skipped))}\n`);
        return 0;
      }
      if (sub === 'guide') {
        const help = USAGE['voice guide'] as string;
        const flags = parseFlags(subRest, help, { voice: 'value', post: 'bool' });
        if (flags.rest.length !== 0) throw new UsageError('voice guide takes no files', help);
        const rules = readVoice(flags.voice, help);
        if (rules === undefined) throw new UsageError('--voice is required', help);
        const compose = new Compose(io.engine === undefined ? { engine: inProcessEngine() } : { engine: io.engine });
        const line = await compose.voice.guide(rules, { post: flags.post });
        out.push(`line: ${cell(line)}\n`);
        return 0;
      }
      throw new UsageError('voice takes parse or guide', `write voice parse <file> | write voice guide --voice '<rules json>' [--post]`);
    }
    if (verb === 'brief') {
      const help = USAGE['brief'] as string;
      const flags = parseFlags(rest, help, { kind: 'value', platform: 'value', voice: 'value' });
      if (flags.rest.length !== 0) throw new UsageError('brief takes no files', help);
      if (flags.kind === undefined) throw new UsageError('--kind is required', help);
      const kinds: BriefKind[] = ['reply', 'polish', 'post', 'thread'];
      if (!kinds.includes(flags.kind as BriefKind)) throw new UsageError('--kind must be reply, polish, post or thread', help);
      const platformId = needPlatformId(flags, help);
      const rules = readVoice(flags.voice, help);
      const compose = new Compose(io.engine === undefined ? { engine: inProcessEngine() } : { engine: io.engine });
      await knownPlatform(compose, platformId, help);
      const lines = await compose.brief({ kind: flags.kind as BriefKind, platform: platformId, ...(rules === undefined ? {} : { rules }) });
      out.push(`lines[${lines.length}]:\n`);
      for (const line of lines) out.push(`  ${JSON.stringify(line)}\n`);
      return 0;
    }
    if (verb === 'check') {
      const help = USAGE['check'] as string;
      const flags = parseFlags(rest, help, { platform: 'value', voice: 'value', original: 'value' });
      const platformId = needPlatformId(flags, help);
      if (flags.rest.length < 1) throw new UsageError('check takes at least one draft file', help);
      const rules = readVoice(flags.voice, help);
      const original = flags.original === undefined ? undefined : readFile(io, flags.original, help);
      const files = flags.rest;
      const drafts = files.map((file) => readFile(io, file, help));
      const compose = new Compose(io.engine === undefined ? { engine: inProcessEngine() } : { engine: io.engine });
      const known = await knownPlatform(compose, platformId, help);
      const results = await compose.check({
        drafts, platform: platformId, ...(rules === undefined ? {} : { rules }), ...(original === undefined ? {} : { original }),
      });
      const withOriginal = original !== undefined;
      out.push(`drafts[${results.length}]{file,fits,length,limit,verdict}:\n`);
      let passed = 0;
      results.forEach((result, i) => {
        if (draftPasses(result, { original: withOriginal })) passed += 1;
        out.push(`  ${cell(files[i] as string)},${result.fits ? 'yes' : 'no'},${result.length},${result.limit === null ? 'none' : String(result.limit)},${cell(result.words)}\n`);
      });
      const issues: Array<[string, string, string]> = [];
      results.forEach((result, i) => {
        const file = files[i] as string;
        for (const entry of result.voice) issues.push([file, 'voice', entry]);
        for (const entry of result.stock) issues.push([file, 'stock', entry]);
        for (const entry of result.added) issues.push([file, 'added', entry]);
        for (const entry of result.dropped) issues.push([file, 'dropped', entry]);
        if (withOriginal && !result.layoutKept) issues.push([file, 'layout', 'lists or paragraphs changed']);
      });
      if (issues.length === 0) {
        out.push('issues: none\n');
      } else {
        out.push(`issues[${issues.length}]{file,kind,detail}:\n`);
        for (const [file, kind, detail] of issues) out.push(`  ${cell(file)},${kind},${cell(detail)}\n`);
      }
      out.push(`result: ${passed} of ${results.length} drafts pass\n`);
      void known;
      return passed === results.length ? 0 : 1;
    }
    if (verb === 'split') {
      const help = USAGE['split'] as string;
      const flags = parseFlags(rest, help, { platform: 'value' });
      const platformId = needPlatformId(flags, help);
      if (flags.rest.length !== 1) throw new UsageError('split takes one file', help);
      const text = readFile(io, flags.rest[0] as string, help);
      const compose = new Compose(io.engine === undefined ? { engine: inProcessEngine() } : { engine: io.engine });
      await knownPlatform(compose, platformId, help);
      const posts = await compose.split({ text, platform: platformId });
      out.push(`posts[${posts.length}]:\n`);
      for (const post of posts) out.push(`  ${JSON.stringify(post)}\n`);
      return 0;
    }
    throw new UsageError(`unknown command "${verb}"`, TOP_HELP);
  };
  try {
    const code = await run();
    emit();
    return code;
  } catch (e: unknown) {
    if (e instanceof UsageError) {
      io.stderr(`error: ${e.message}\n`);
      io.stderr(`help: ${e.help === '' ? TOP_HELP : e.help}\n`);
      return 2;
    }
    if (e instanceof ComposeError && e.code === 'invalid') {
      io.stderr(`error: ${e.message}\n`);
      io.stderr(`help: ${TOP_HELP}\n`);
      return 2;
    }
    if (e instanceof ComposeError && (e.code === 'missing' || e.code === 'needs-update')) {
      io.stderr(`error: ${words(e.code === 'missing' ? 'compose.missing' : 'compose.needsUpdate', {})}\n`);
      return 3;
    }
    if (e instanceof ComposeError) {
      io.stderr(`error: ${words('compose.failed', {})}\n`);
      return 4;
    }
    throw e;
  }
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === self) {
  const io: CliIo = {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    readFile: (path) => readFileSync(path, 'utf8'),
  };
  main(process.argv.slice(2), io).then((code) => { process.exitCode = code; });
}
