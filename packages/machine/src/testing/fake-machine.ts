// fakeMachine(): one in-memory Linux machine (docs/machine-kit.md 13.3). Files with modes
// and owners, users, units with their `show` fields, a journal, a passwordless-sudo flag and
// a Node version. M2's fake `ssh` and M4's fake server delegate `exec` to it through
// parseCommand(s), so all three benches run the same machine.
import type { ExecResult } from '../types.ts';
import { DELIVER_SHELL, PROBE_SHELL, WORKDIR_SHELL, WRITE_SHELL } from '../unit.ts';

export type RunOptions = { root?: boolean; input?: Uint8Array; asUser?: string };
export type RunResult = ExecResult;
export type ShowFields = { LoadState: string; ActiveState: string; SubState: string; NRestarts: number };
export type FakeUnit = { path: string; kind: 'system' | 'user'; bytes: string; show: ShowFields; enabled: boolean };
export type FakeFile = { bytes: Uint8Array; mode: number; owner: string };
export type RunRecord = { argv: readonly string[]; root: boolean; asUser: string | null; inputBytes: number };
export type FakeDir = { owner: string; mode: number };

const SYSTEMD_SYSTEM = '/etc/systemd/system';
const SYSTEM_NODE_ARGV = ['sh', '-c', 'command -v node && node --version'];

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
  /** `uname -m` line of the 8.3 step 2 probe (`x86_64` or `aarch64`). */
  arch = 'x86_64';
  /** `loginctl enable-linger` exits 0; false models the polkit refusal (8.3 step 9). */
  lingerOk = true;
  /** Exit code of the 8.3 step 4 node-install script (3 models a checksum mismatch). */
  nodeInstallCode = 0;
  /** Symlinks (`symlink(path, target)`), resolved on deliver writes. */
  symlinks = new Map<string, string>();
  /** Directories made by `mkdir -p` and `install -d`, with owners and modes. */
  dirs = new Map<string, FakeDir>();
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

  /** Record a symlink; `resolve` follows the longest matching prefix. */
  symlink(path: string, target: string): void {
    this.symlinks.set(path, target);
  }

  /** Follow symlinks on `path` (longest prefix wins). */
  resolve(path: string): string {
    const keys = [...this.symlinks.keys()].sort((a, b) => b.length - a.length);
    for (const from of keys) {
      if (path === from || path.startsWith(`${from}/`)) {
        return (this.symlinks.get(from) as string) + path.slice(from.length);
      }
    }
    return path;
  }

  run(argv: readonly string[], o: RunOptions = {}): RunResult {
    // 8.2: `runuser -u <user> --` arrives as part of the argv and sets `asUser`.
    let args = [...argv];
    let asUser = o.asUser ?? null;
    if (args[0] === 'runuser' && args[1] === '-u' && args[2] !== undefined && args[3] === '--') {
      asUser = args[2];
      args = args.slice(4);
    }
    this.runs.push({ argv: [...argv], root: o.root ?? false, asUser, inputBytes: o.input?.length ?? 0 });
    const writer = asUser ?? (o.root === true ? 'root' : this.user);
    const scripted = this.scripts.get(args[0]);
    if (scripted !== undefined) return { ...scripted };
    const [cmd, ...rest] = args;
    if (cmd === 'true' && rest.length === 0) {
      return this.sudo ? { code: 0, stdout: '', stderr: '', timedOut: false } : { code: 1, stdout: '', stderr: '', timedOut: false };
    }
    if (cmd === 'id' && rest.length === 2 && rest[0] === '-u') {
      const known = rest[1] === this.user || this.users.has(rest[1]);
      return { code: known ? 0 : 1, stdout: '', stderr: '', timedOut: false };
    }
    if (cmd === 'useradd') {
      this.users.add(args[args.length - 1]);
      return { code: 0, stdout: '', stderr: '', timedOut: false };
    }
    if (cmd === 'install' && rest[0] === '-d') {
      let mode = 0o755;
      let owner = writer;
      for (let i = 1; i < rest.length; i++) {
        if (rest[i] === '-m' && rest[i + 1] !== undefined) mode = Number.parseInt(rest[i + 1], 8);
        if (rest[i] === '-o' && rest[i + 1] !== undefined) owner = rest[i + 1];
      }
      this.dirs.set(args[args.length - 1], { owner, mode });
      return { code: 0, stdout: '', stderr: '', timedOut: false };
    }
    if (cmd === 'chmod') {
      return { code: 0, stdout: '', stderr: '', timedOut: false };
    }
    if (cmd === 'mkdir' && rest.includes('-p')) {
      let mode = 0o755;
      const at = rest.indexOf('-m');
      if (at >= 0 && rest[at + 1] !== undefined) mode = Number.parseInt(rest[at + 1], 8);
      this.dirs.set(args[args.length - 1], { owner: writer, mode });
      return { code: 0, stdout: '', stderr: '', timedOut: false };
    }
    if (cmd === 'touch' && rest.length === 1) {
      this.writeFile(rest[0], new Uint8Array(), 0o644, writer);
      return { code: 0, stdout: '', stderr: '', timedOut: false };
    }
    if (cmd === 'cat' && rest.length === 1) {
      const file = this.files.get(rest[0]);
      if (file === undefined) return { code: 1, stdout: '', stderr: `cat: ${rest[0]}: No such file`, timedOut: false };
      return { code: 0, stdout: Buffer.from(file.bytes).toString('utf8'), stderr: '', timedOut: false };
    }
    if (cmd === 'loginctl' && rest[0] === 'enable-linger') {
      return this.lingerOk
        ? { code: 0, stdout: '', stderr: '', timedOut: false }
        : { code: 1, stdout: '', stderr: 'polkit refused enable-linger', timedOut: false };
    }
    if (cmd === 'test' && rest.length === 2 && rest[0] === '-e') {
      const known = [...this.units.values()].some((u) => u.path === rest[1]) || this.files.has(rest[1]);
      return { code: known ? 0 : 1, stdout: '', stderr: '', timedOut: false };
    }
    if (cmd === 'systemctl') {
      const args = rest[0] === '--user' ? rest.slice(1) : rest;
      const [verb, ...vargs] = args;
      const unitArg = vargs.find((a) => a.startsWith('byokit-') && a.endsWith('.service')) ?? '';
      const unitName = unitArg.replace(/^byokit-(.+)\.service$/, '$1');
      if (verb === 'daemon-reload') return { code: 0, stdout: '', stderr: '', timedOut: false };
      if (verb === 'enable' && vargs[0] === '--now') {
        const systemBytes = this.files.get(`${SYSTEMD_SYSTEM}/byokit-${unitName}.service`)?.bytes;
        const userBytes = this.files.get(`${this.home}/.config/systemd/user/byokit-${unitName}.service`)?.bytes;
        const found = systemBytes !== undefined
          ? { kind: 'system' as const, path: `${SYSTEMD_SYSTEM}/byokit-${unitName}.service`, bytes: systemBytes }
          : userBytes !== undefined
            ? { kind: 'user' as const, path: `${this.home}/.config/systemd/user/byokit-${unitName}.service`, bytes: userBytes }
            : null;
        if (found === null) {
          return { code: 1, stdout: '', stderr: `Failed to enable unit: byokit-${unitName}.service not found`, timedOut: false };
        }
        this.units.set(unitName, {
          path: found.path,
          kind: found.kind,
          bytes: Buffer.from(found.bytes).toString('utf8'),
          show: { LoadState: 'loaded', ActiveState: 'active', SubState: 'running', NRestarts: 0 },
          enabled: true,
        });
        return { code: 0, stdout: '', stderr: '', timedOut: false };
      }
      if (verb === 'restart') {
        const entry = this.units.get(unitName);
        if (entry === undefined) {
          return { code: 1, stdout: '', stderr: `Failed to restart byokit-${unitName}.service: not found`, timedOut: false };
        }
        entry.show = { ...entry.show, ActiveState: 'active', SubState: 'running' };
        return { code: 0, stdout: '', stderr: '', timedOut: false };
      }
      if (verb === 'stop') {
        const entry = this.units.get(unitName);
        if (entry !== undefined) entry.show = { ...entry.show, ActiveState: 'inactive', SubState: 'dead' };
        return { code: 0, stdout: '', stderr: '', timedOut: false };
      }
      if (verb === 'show') {
        const entry = this.units.get(unitName);
        if (entry !== undefined) {
          const s = entry.show;
          return {
            code: 0,
            stdout: `LoadState=${s.LoadState}\nActiveState=${s.ActiveState}\nSubState=${s.SubState}\nNRestarts=${s.NRestarts}\n`,
            stderr: '', timedOut: false,
          };
        }
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
    if (cmd === 'sh' && rest[0] === '-c' && rest[1] === PROBE_SHELL) {
      return { code: 0, stdout: `Linux\n${this.arch}\nsystemd 1\n${this.user}\n${this.home}\n`, stderr: '', timedOut: false };
    }
    if (args.length === 2 && args[1] === '--version' && (args[0] as string).endsWith('/bin/node')) {
      return this.nodeVersion === null
        ? { code: 1, stdout: '', stderr: 'node: not found', timedOut: false }
        : { code: 0, stdout: `${this.nodeVersion}\n`, stderr: '', timedOut: false };
    }
    if (cmd === 'sh' && rest[0] === '-c' && rest[1] === SYSTEM_NODE_ARGV[2]) {
      return this.nodeVersion === null
        ? { code: 1, stdout: '', stderr: 'node: not found', timedOut: false }
        : { code: 0, stdout: `/usr/bin/node\n${this.nodeVersion}\n`, stderr: '', timedOut: false };
    }
    if (cmd === 'sh' && rest[0] === '-c' && rest[1].includes('sha256sum -c') && (rest[3] ?? '').startsWith('https://nodejs.org/')) {
      return this.nodeInstallCode === 0
        ? { code: 0, stdout: '', stderr: '', timedOut: false }
        : { code: this.nodeInstallCode, stdout: '', stderr: 'node install failed', timedOut: false };
    }
    // The 7.1 write shell through `exec` with `input` (8.3 steps 6 and 8).
    if (cmd === 'sh' && rest[0] === '-c' && rest[1] === WRITE_SHELL && rest[2] === 'sh' && args.length === 6) {
      const mode = Number.parseInt(args[5], 8);
      this.writeFile(args[4], o.input ?? new Uint8Array(), Number.isInteger(mode) ? mode : 0o600, writer);
      return { code: 0, stdout: '', stderr: '', timedOut: false };
    }
    // The 5.8 deliver shell through `exec` with `input`. A symlinked inbox
    // resolves first; a target the writer does not own refuses the write, so a
    // symlink planted by the run user can only redirect a write the run user
    // could make anyway.
    if (cmd === 'sh' && rest[0] === '-c' && rest[1] === DELIVER_SHELL && rest[2] === 'sh' && args.length === 6) {
      const inbox = this.resolve(args[4]);
      const dir = this.dirs.get(inbox);
      if (dir !== undefined && dir.owner !== writer) {
        return { code: 1, stdout: '', stderr: 'mktemp: permission denied', timedOut: false };
      }
      this.dirs.set(inbox, dir ?? { owner: writer, mode: 0o755 });
      this.writeFile(`${inbox}/${args[5]}`, o.input ?? new Uint8Array(), 0o600, writer);
      return { code: 0, stdout: '', stderr: '', timedOut: false };
    }
    // The 8.2 in-workDir wrapper: answer the inner argv, consulting `script`
    // registrations by the inner command first.
    if (cmd === 'sh' && rest[0] === '-c' && rest[1] === WORKDIR_SHELL && rest[2] === 'sh') {
      const inner = args.slice(6);
      const innerScripted = inner.length > 0 ? this.scripts.get(inner[0]) : undefined;
      if (innerScripted !== undefined) return { ...innerScripted };
      return { code: 0, stdout: '', stderr: '', timedOut: false };
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
