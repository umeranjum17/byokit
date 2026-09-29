// fakeMachine(): one in-memory Linux machine (docs/machine-kit.md 13.3). Files with modes
// and owners, users, units with their `show` fields, a journal, a passwordless-sudo flag and
// a Node version. M2's fake `ssh` and M4's fake server delegate `exec` to it through
// parseCommand(s), so all three benches run the same machine.
import type { ExecResult } from '../types.ts';

export type RunOptions = { root?: boolean; input?: Uint8Array; asUser?: string };
export type RunResult = ExecResult;
export type ShowFields = { LoadState: string; ActiveState: string; SubState: string; NRestarts: number };
export type FakeUnit = { path: string; kind: 'system' | 'user'; bytes: string; show: ShowFields; enabled: boolean };
export type FakeFile = { bytes: Uint8Array; mode: number; owner: string };
export type RunRecord = { argv: readonly string[]; root: boolean; asUser: string | null; inputBytes: number };

const SYSTEMD_SYSTEM = '/etc/systemd/system';

export class FakeMachine {
  files = new Map<string, FakeFile>();
  users = new Set<string>();
  units = new Map<string, FakeUnit>();
  journal = new Map<string, string[]>();
  /** Passwordless sudo on the fake machine (fakeProvider `root` option, default true). */
  sudo = true;
  /** The machine login (8.3 step 2 line 4) and its home (line 5). */
  user = 'user';
  home = '/home/user';
  /** `node --version` output, e.g. 'v24.15.0'; null means node is missing. */
  nodeVersion: string | null = 'v24.15.0';
  runs: RunRecord[] = [];
  private scripts = new Map<string, RunResult>();

  /** Register `script(argv0, result)`: any argv starting with argv0 answers result. */
  script(argv0: string, result: RunResult): void {
    this.scripts.set(argv0, result);
  }

  writeFile(path: string, bytes: Uint8Array, mode: number, owner?: string): void {
    this.files.set(path, { bytes: bytes.slice(), mode, owner: owner ?? this.user });
  }

  readFile(path: string): Uint8Array | null {
    return this.files.get(path)?.bytes.slice() ?? null;
  }

  addUnit(name: string, unit: Omit<FakeUnit, 'path'> & { path?: string }): void {
    const path = unit.path ?? (unit.kind === 'system'
      ? `${SYSTEMD_SYSTEM}/byokit-${name}.service`
      : `${this.home}/.config/systemd/user/byokit-${name}.service`);
    this.units.set(name, { ...unit, path });
  }

  log(unit: string, line: string): void {
    const lines = this.journal.get(unit) ?? [];
    lines.push(line);
    this.journal.set(unit, lines);
  }

  /** Enabled units restart (a cold-boot wake starts them again). */
  reboot(): void {
    for (const unit of this.units.values()) {
      if (unit.enabled) unit.show = { ...unit.show, ActiveState: 'active', SubState: 'running' };
    }
  }

  run(argv: readonly string[], o: RunOptions = {}): RunResult {
    this.runs.push({ argv: [...argv], root: o.root ?? false, asUser: o.asUser ?? null, inputBytes: o.input?.length ?? 0 });
    const scripted = this.scripts.get(argv[0]);
    if (scripted !== undefined) return { ...scripted };
    const [cmd, ...rest] = argv;
    if (cmd === 'true' && rest.length === 0) {
      return this.sudo ? { code: 0, stdout: '', stderr: '', timedOut: false } : { code: 1, stdout: '', stderr: '', timedOut: false };
    }
    if (cmd === 'test' && rest.length === 2 && rest[0] === '-e') {
      const known = [...this.units.values()].some((u) => u.path === rest[1]) || this.files.has(rest[1]);
      return { code: known ? 0 : 1, stdout: '', stderr: '', timedOut: false };
    }
    if (cmd === 'systemctl') {
      const args = rest[0] === '--user' ? rest.slice(1) : rest;
      const [verb, unit] = args;
      const name = unit?.replace(/^byokit-(.+)\.service$/, '$1');
      const entry = name !== undefined ? this.units.get(name) : undefined;
      if (verb === 'stop') return { code: 0, stdout: '', stderr: '', timedOut: false };
      if (verb === 'show' && entry !== undefined) {
        const s = entry.show;
        return {
          code: 0,
          stdout: `LoadState=${s.LoadState}\nActiveState=${s.ActiveState}\nSubState=${s.SubState}\nNRestarts=${s.NRestarts}\n`,
          stderr: '', timedOut: false,
        };
      }
      if (verb === 'show') {
        return { code: 0, stdout: 'LoadState=not-found\nActiveState=inactive\nSubState=dead\nNRestarts=0\n', stderr: '', timedOut: false };
      }
      return { code: 0, stdout: '', stderr: '', timedOut: false };
    }
    if (cmd === 'journalctl') {
      const unitFlag = rest.indexOf('-u');
      const unit = unitFlag >= 0 ? rest[unitFlag + 1] : '';
      const name = unit.replace(/^byokit-(.+)\.service$/, '$1');
      const nFlag = rest.indexOf('-n');
      const n = nFlag >= 0 ? Math.min(Number.parseInt(rest[nFlag + 1], 10), 500) : 500;
      const lines = (this.journal.get(name) ?? []).slice(-n);
      return { code: 0, stdout: lines.length > 0 ? `${lines.join('\n')}\n` : '', stderr: '', timedOut: false };
    }
    if (cmd === 'sh' && rest[0] === '-c' && rest[1] === 'uname -s; uname -m; systemctl --version | head -n 1; id -un; getent passwd "$(id -un)" | cut -d: -f6') {
      return { code: 0, stdout: `Linux\nx86_64\nsystemd 1\n${this.user}\n${this.home}\n`, stderr: '', timedOut: false };
    }
    return { code: 127, stdout: '', stderr: `fake-machine: no answer for ${JSON.stringify(argv)}`, timedOut: false };
  }
}

export type ParsedCommand = {
  argv: string[];
  root: boolean;
  timeoutS: number | null;
  asUser: string | null;
  input: Uint8Array | null;
};

/** Split a shell string on whitespace, honouring POSIX single quotes (`'\''` = `'`). */
export function splitCommand(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  let started = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === "'") {
        if (s.startsWith("'\\''", i)) { cur += "'"; i += 3; }
        else quoted = false;
      } else cur += c;
    } else if (c === "'") {
      quoted = true;
      started = true;
    } else if (c === ' ' || c === '\t' || c === '\n') {
      if (started || cur.length > 0) { out.push(cur); cur = ''; started = false; }
    } else {
      cur += c;
      started = true;
    }
  }
  if (started || cur.length > 0) out.push(cur);
  return out;
}

/**
 * Turn an adapter command string back into a call (13.3): POSIX single-quote unquoting,
 * then a leading `sudo -n` sets `root`, a leading `timeout -k 10 <s>` sets the timeout,
 * `runuser -u <user> --` sets `asUser`, and the 6.4 stdin wrapper
 * (`<command> < <path>; r=$?; rm -f <path>; exit $r`) is recognised exactly and turned
 * into `input` through `readFile`.
 */
export function parseCommand(s: string, readFile?: (path: string) => Uint8Array | null): ParsedCommand {
  let argv = splitCommand(s);
  let root = false;
  let timeoutS: number | null = null;
  let asUser: string | null = null;
  if (argv[0] === 'sudo' && argv[1] === '-n') {
    root = true;
    argv = argv.slice(2);
  }
  if (argv[0] === 'timeout' && argv[1] === '-k' && argv[2] === '10' && argv[3] !== undefined) {
    timeoutS = Number.parseInt(argv[3], 10);
    argv = argv.slice(4);
  }
  if (argv[0] === 'runuser' && argv[1] === '-u' && argv[2] !== undefined && argv[3] === '--') {
    asUser = argv[2];
    argv = argv.slice(4);
  }
  let input: Uint8Array | null = null;
  const redir = argv.indexOf('<');
  if (redir >= 0) {
    const path = argv[redir + 1];
    const tail = argv.slice(redir + 2);
    const wrapper = [';', 'r=$?;', 'rm', '-f', `${path};`, 'exit', 'r'];
    if (path !== undefined && tail.length === wrapper.length && tail.every((t, i) => t === wrapper[i])) {
      input = readFile?.(path) ?? null;
      argv = argv.slice(0, redir);
    }
  }
  return { argv, root, timeoutS, asUser, input };
}

export function fakeMachine(): FakeMachine {
  return new FakeMachine();
}
