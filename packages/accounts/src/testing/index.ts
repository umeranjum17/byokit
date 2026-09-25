// The isolation harness every byokit package (and every app built on it) tests with: a throwaway HOME holding a decoy
// of each agent setup a person may already have signed in (Pi, Codex, Claude, shared agent skills), the environment a
// shell inside one of them hands down, and an fs tracer. A run must leave the decoys byte for byte as they were, never
// touch them at all, and never carry a canary into the app's own files.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CANARY = 'canary-byokit-7f3a9c';
/** Preload this with `node --import` to record touches under `TRACE_ROOTS` in `TRACE_LOG` (both set in `decoy().env`). */
export const traceFs = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './trace-fs.ts' : './trace-fs.js', import.meta.url));

const put = (p: string, text: string) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); };
const files = (dir: string): string[] => existsSync(dir)
  ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name)) : [];
const hashes = (dirs: string[]) => Object.fromEntries(dirs.flatMap(files).map((p) => [p, createHash('sha256').update(readFileSync(p)).digest('hex') + statSync(p).mtimeMs]));

export function decoy(root = mkdtempSync(join(tmpdir(), 'byokit-decoy-'))) {
  const home = join(root, 'home');
  const marks = join(root, 'marks');
  const trace = join(root, 'trace.log');
  const pi = join(home, '.pi'), codex = join(home, '.codex'), claude = join(home, '.claude'), agents = join(home, '.agents');
  const token = { type: 'oauth', access: `${CANARY}-access`, refresh: `${CANARY}-refresh`, expires: Date.now() + 86_400_000 };
  put(join(pi, 'agent', 'auth.json'), JSON.stringify({ 'openai-codex': token, xai: token }));
  put(join(pi, 'agent', 'settings.json'), JSON.stringify({ defaultProvider: 'openai-codex', defaultModel: 'gpt-6-sol', packages: ['npm:evil'] }));
  put(join(pi, 'agent', 'extensions', 'evil.ts'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(join(marks, 'extension'))}, 'loaded'); export default () => {};`);
  put(join(codex, 'auth.json'), JSON.stringify({ tokens: { access_token: `${CANARY}-codex`, refresh_token: `${CANARY}-codex-refresh` } }));
  put(join(claude, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: `${CANARY}-claude` } }));
  put(join(agents, 'skills', 'owner-skill', 'SKILL.md'), '---\nname: owner-skill\ndescription: the person\'s own skill\n---\n');
  mkdirSync(marks, { recursive: true });
  writeFileSync(trace, '');
  const roots = [pi, codex, claude, agents];
  const before = hashes(roots);
  return {
    root, home, roots, marks,
    /** For a child process: the decoy HOME, the tracer's settings, and what a shell inside someone's Pi inherits. */
    env: {
      HOME: home, TRACE_ROOTS: roots.join(':'), TRACE_LOG: trace,
      PI_CODING_AGENT_DIR: join(pi, 'agent'), PI_PROVIDER: 'openai-codex', PI_MODEL: 'gpt-6-sol', PI_CODING_AGENT: 'true', AI_AGENT: 'pi',
      OPENAI_API_KEY: `${CANARY}-key`, XAI_API_KEY: `${CANARY}-xai`, OPENROUTER_API_KEY: `${CANARY}-or`, GH_TOKEN: `${CANARY}-gh`,
    } as Record<string, string>,
    /** Paths the tracer saw touched, one per line; empty when nothing was. */
    touched: () => readFileSync(trace, 'utf8').trim(),
    /** Decoy files whose bytes or modification time changed, or that appeared or vanished. */
    changed: () => { const now = hashes(roots); return [...new Set([...Object.keys(before), ...Object.keys(now)])].filter((p) => before[p] !== now[p]); },
    /** Files under `dir` carrying a canary: a key or sign-in from the decoy leaked into the app's own storage. */
    leaks: (dir: string) => files(dir).filter((f) => readFileSync(f).includes(CANARY)),
    /** Marks left by the decoy's extension or CLIs: something ran code from someone else's setup. */
    ran: () => readdirSync(marks),
  };
}
export { mockJwt, mockOpenAI, type MockOpenAIOptions } from './mock-openai.ts';
