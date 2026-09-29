// Recipe checks (docs/machine-kit.md 8.1, pure part) plus the range compare (G5a) and the
// FNV-1a marker hash (8.3 step 3). Failures throw MachineError('bad-recipe') naming the rule;
// machine.ts runs these before any machine call in install, update and deliver.
import { MachineError } from './errors.ts';
import type { HostRecipe } from './types.ts';

const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const WORKDIR = /^\/[A-Za-z0-9._/-]+$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const SECRET_ENV = /KEY|TOKEN|SECRET|PASSWORD/i;
const SECRET_ARGV = /(key|token|secret|password)\s*[=:]/i;
const SECRET_FLAG = /^--?[a-z-]*(key|token|secret|password)/i;
const VERSION = /^\d+\.\d+\.\d+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const USER = /^[a-z][a-z0-9-]{0,30}$/;
// One or more '||'-separated groups of space-separated comparators (>=, >, <=, <, = followed
// by a version). Versions may be partial (`<25` means `<25.0.0`); missing parts are zero.
const COMPARATOR = /^(>=|>|<=|<|=)(\d+(?:\.\d+){0,2})$/;

const hasControl = (s: string): boolean => /[\x00-\x1f\x7f]/.test(s);

/** Compare two versions after padding partial ones (`25` → `25.0.0`): negative, zero or positive. */
export function compareVersions(a: string, b: string): number {
  const pad = (v: string): [number, number, number] => {
    const parts = v.split('.').map(Number);
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  };
  const pa = pad(a);
  const pb = pad(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/** True when `version` satisfies `range` (G5a grammar). A malformed range satisfies nothing. */
export function satisfiesRange(version: string, range: string): boolean {
  if (!VERSION.test(version)) return false;
  const groups = range.split('||').map((g) => g.trim().split(/\s+/).filter((c) => c.length > 0));
  if (groups.length === 0 || groups.some((g) => g.length === 0)) return false;
  return groups.some((group) =>
    group.every((comp) => {
      const m = COMPARATOR.exec(comp);
      if (!m) return false;
      const cmp = compareVersions(version, m[2]);
      switch (m[1]) {
        case '>=': return cmp >= 0;
        case '>': return cmp > 0;
        case '<=': return cmp <= 0;
        case '<': return cmp < 0;
        default: return cmp === 0;
      }
    }),
  );
}

/** The default range for a recipe: the pinned version or newer. */
export function defaultRange(version: string): string {
  return `>=${version}`;
}

/**
 * FNV-1a 64-bit hash, lowercase hex, of JSON.stringify([user, installRoot]).
 * The 8.3 step 3 marker is `/var/lib/byokit/<name>-<h>`; equal recipes hash equal.
 */
export function markerHash(user: string | undefined, installRoot: readonly (readonly string[])[] | undefined): string {
  const bytes = new TextEncoder().encode(JSON.stringify([user ?? null, installRoot ?? []]));
  let h = 0xcbf29ce484222325n;
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

/** The 8.3 step 3 marker path for a recipe. */
export function markerPath(name: string, r: HostRecipe): string {
  return `/var/lib/byokit/${name}-${markerHash(r.user, r.installRoot)}`;
}

const bad = (rule: string, message: string): MachineError =>
  new MachineError('bad-recipe', `${rule}: ${message}`);

/**
 * The 8.1 pure checks. `refName` is the stored ref's name: `r.name` must equal it, so host,
 * logs and sleep find the unit as `byokit-<ref.name>.service`.
 */
export function checkRecipe(r: HostRecipe, refName: string): void {
  if (!NAME.test(r.name)) throw bad('name', `must match ^[a-z][a-z0-9-]{0,31}$, got ${JSON.stringify(r.name)}`);
  if (r.name !== refName) throw bad('name', `must equal the machine's name ${JSON.stringify(refName)}`);
  if (!WORKDIR.test(r.workDir)) {
    throw bad('workDir', `must match ^/[A-Za-z0-9._/-]+$, got ${JSON.stringify(r.workDir)}`);
  }
  if (r.workDir.split('/').includes('..')) throw bad('workDir', 'must not contain a .. segment');
  const lists: readonly (readonly (readonly string[])[] | undefined)[] = [r.installRoot, r.install, r.update];
  for (const [label, list] of [['installRoot', lists[0]], ['install', lists[1]], ['update', lists[2]]] as const) {
    if (list === undefined) continue;
    for (const argv of list) {
      if (argv.length === 0) throw bad(label, 'every argv list is non-empty');
      for (const el of argv) {
        if (hasControl(el)) throw bad(label, 'no element holds a control character');
      }
    }
  }
  if (r.run.argv.length === 0) throw bad('run.argv', 'is non-empty');
  for (const el of r.run.argv) {
    if (hasControl(el)) throw bad('run.argv', 'no element holds a control character (a newline would end the ExecStart= line)');
  }
  for (const el of r.run.argv) {
    if (SECRET_ARGV.test(el) || SECRET_FLAG.test(el)) {
      throw bad('run.argv', `must not carry a secret-looking argument, got ${JSON.stringify(el)}`);
    }
  }
  for (const name of Object.keys(r.run.env)) {
    if (!ENV_NAME.test(name) || SECRET_ENV.test(name)) {
      throw bad('run.env', `name ${JSON.stringify(name)} must match ^[A-Z_][A-Z0-9_]*$ and not /KEY|TOKEN|SECRET|PASSWORD/i`);
    }
  }
  for (const [name, value] of Object.entries(r.run.env)) {
    if (hasControl(value)) throw bad('run.env', `value for ${JSON.stringify(name)} holds a control character`);
  }
  if (!VERSION.test(r.node.version)) throw bad('node.version', `must be x.y.z, got ${JSON.stringify(r.node.version)}`);
  for (const arch of ['linux-x64', 'linux-arm64'] as const) {
    if (!SHA256.test(r.node.sha256[arch])) throw bad('node.sha256', `${arch} must be 64 lowercase hex characters`);
  }
  if (r.node.range !== undefined) {
    const groups = r.node.range.split('||').map((g) => g.trim().split(/\s+/).filter((c) => c.length > 0));
    const malformed = groups.length === 0 || groups.some((g) => g.length === 0 || g.some((c) => !COMPARATOR.test(c)));
    if (malformed) throw bad('node.range', `must be ||-separated groups of comparators, got ${JSON.stringify(r.node.range)}`);
    if (!satisfiesRange(r.node.version, r.node.range)) {
      throw bad('node.range', `pinned ${r.node.version} must satisfy ${JSON.stringify(r.node.range)}`);
    }
  }
  if (r.user !== undefined) {
    if (!USER.test(r.user)) throw bad('user', `must match ^[a-z][a-z0-9-]{0,30}$, got ${JSON.stringify(r.user)}`);
    if (r.user === 'root') throw bad('user', 'must not be root');
  }
}
