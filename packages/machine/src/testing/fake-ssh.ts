// Fake `ssh`/`ssh-keyscan` bench (docs/machine-kit.md M2): two Node scripts in one
// scratch dir, run as the fake `ssh` and `ssh-keyscan` binaries. Each call records
// argv, env, stdin and the config file it was pointed at to a JSON log, and the
// remote command is answered through a `FakeMachine` persisted to a JSON file
// between calls, so every bench runs the same machine as the fake provider.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FakeMachine } from './fake-machine.ts';
import type { RunResult, RunRecord, ShowFields } from './fake-machine.ts';

export type FakeSshKeySet = { ed25519: string; ecdsa: string; rsa: string };

export type FakeSshOptions = {
  host?: string;
  user?: string;
  home?: string;
  sudo?: boolean;
  nodeVersion?: string | null;
  keys?: FakeSshKeySet;
};

export type FakeSshCall = {
  tool: 'ssh' | 'ssh-keyscan';
  argv: string[];
  env: Record<string, string>;
  /** Raw stdin, base64. */
  stdin: string;
  config: { path: string; bytes: string | null } | null;
};

export type SavedMachine = {
  files: Record<string, { bytes: string; mode: number; owner: string }>;
  users: string[];
  units: Record<string, { path: string; kind: 'system' | 'user'; bytes: string; show: ShowFields; enabled: boolean }>;
  journal: Record<string, string[]>;
  sudo: boolean;
  user: string;
  home: string;
  nodeVersion: string | null;
  runs: RunRecord[];
  scripts: Record<string, RunResult>;
};

type FakeSshState = {
  machine: SavedMachine;
  hostKeys: FakeSshKeySet;
  sshFail: { code: number; stderr: string } | null;
  hangSsh: boolean;
};

/** Deterministic fake host keys (base64 of fixed bytes; structure is never checked). */
function defaultKeys(): FakeSshKeySet {
  const seed = (name: string, n: number): string =>
    createHash('sha256').update(`byokit-fake-ssh:${name}`).digest().subarray(0, n).toString('base64');
  return { ed25519: seed('ed25519', 32), ecdsa: seed('ecdsa', 65), rsa: seed('rsa', 64) };
}

/** The `SHA256:` fingerprint of one base64 public key, as the adapter computes it. */
export function fakeKeyFingerprint(base64Key: string): string {
  const raw = Buffer.from(base64Key, 'base64');
  return `SHA256:${createHash('sha256').update(raw).digest('base64').replace(/=+$/, '')}`;
}

export function saveMachine(m: FakeMachine): SavedMachine {
  const files: SavedMachine['files'] = {};
  for (const [path, f] of m.files) files[path] = { bytes: Buffer.from(f.bytes).toString('base64'), mode: f.mode, owner: f.owner };
  const units: SavedMachine['units'] = {};
  for (const [name, u] of m.units) units[name] = { path: u.path, kind: u.kind, bytes: u.bytes, show: { ...u.show }, enabled: u.enabled };
  const journal: SavedMachine['journal'] = {};
  for (const [name, lines] of m.journal) journal[name] = [...lines];
  return {
    files,
    users: [...m.users],
    units,
    journal,
    sudo: m.sudo,
    user: m.user,
    home: m.home,
    nodeVersion: m.nodeVersion,
    runs: m.runs.map((r) => ({ argv: [...r.argv], root: r.root, asUser: r.asUser, inputBytes: r.inputBytes })),
    scripts: {},
  };
}

export function loadMachine(saved: SavedMachine): FakeMachine {
  const m = new FakeMachine();
  m.sudo = saved.sudo;
  m.user = saved.user;
  m.home = saved.home;
  m.nodeVersion = saved.nodeVersion;
  for (const [path, f] of Object.entries(saved.files)) {
    m.files.set(path, { bytes: Buffer.from(f.bytes, 'base64'), mode: f.mode, owner: f.owner });
  }
  for (const u of saved.users) m.users.add(u);
  for (const [name, u] of Object.entries(saved.units)) {
    m.units.set(name, { path: u.path, kind: u.kind, bytes: u.bytes, show: { ...u.show }, enabled: u.enabled });
  }
  for (const [name, lines] of Object.entries(saved.journal)) m.journal.set(name, [...lines]);
  for (const r of saved.runs) m.runs.push({ argv: [...r.argv], root: r.root, asUser: r.asUser, inputBytes: r.inputBytes });
  for (const [argv0, result] of Object.entries(saved.scripts)) m.script(argv0, { ...result });
  return m;
}

const fakeSshSource = fileURLToPath(new URL('./fake-machine.ts', import.meta.url));

function sshScript(statePath: string, logPath: string): string {
  // The adapter spawns with an env built from nothing (`{ LANG: 'C.UTF-8' }`
  // only, 7.1), so the shebang cannot go through `/usr/bin/env` on PATH: it
  // names this Node binary absolutely.
  const lines = [
    `#!${process.execPath}`,
    "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';",
    "import { writeSync } from 'node:fs';",
    `const STATE = ${JSON.stringify(statePath)};`,
    `const LOG = ${JSON.stringify(logPath)};`,
    `const HELPERS = ${JSON.stringify(pathToFileURL(fileURLToPath(new URL('./fake-ssh.ts', import.meta.url))).href)};`,
    `const MACHINE = ${JSON.stringify(pathToFileURL(fakeSshSource).href)};`,
    'const argv = process.argv.slice(2);',
    'const chunks = [];',
    "process.stdin.on('data', (c) => chunks.push(c));",
    "process.stdin.on('end', () => { main(Buffer.concat(chunks)).catch((e) => { writeSync(2, String((e && e.stack) || e)); process.exit(1); }); });",
    'process.stdin.resume();',
    'function writeAll(fd, data) {',
    '  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);',
    '  const wait = new Int32Array(new SharedArrayBuffer(4));',
    '  let off = 0;',
    '  while (off < buf.length) {',
    '    let n = 0;',
    '    try {',
    '      n = writeSync(fd, buf, off);',
    '    } catch (e) {',
    "      if (e && e.code === 'EAGAIN') { Atomics.wait(wait, 0, 0, 1); continue; }",
    '      throw e;',
    '    }',
    "    if (n <= 0) throw new Error('short write on fd ' + fd);",
    '    off += n;',
    '  }',
    '}',
    'async function main(stdin) {',
    '  const helpers = await import(HELPERS);',
    '  const machineLib = await import(MACHINE);',
    '  let configPath = null;',
    "  const flag = argv.indexOf('-F');",
    '  if (flag >= 0) configPath = argv[flag + 1] || null;',
    '  let configBytes = null;',
    '  if (configPath !== null) {',
    "    try { configBytes = readFileSync(configPath, 'utf8'); } catch (e) { configBytes = null; }",
    '  }',
    '  appendFileSync(LOG, JSON.stringify({ tool: \'ssh\', argv, env: { ...process.env }, stdin: stdin.toString(\'base64\'), config: configPath === null ? null : { path: configPath, bytes: configBytes } }) + "\\n");',
    '  const load = () => JSON.parse(readFileSync(STATE, \'utf8\'));',
    '  const save = (s) => writeFileSync(STATE, JSON.stringify(s));',
    '  const state = load();',
    '  if (state.hangSsh === true) {',
    "    process.on('SIGTERM', () => {});",
    '    await new Promise((r) => setTimeout(r, 120000));',
    '    process.exit(0);',
    '  }',
    '  if (state.sshFail !== null && state.sshFail !== undefined) {',
    '    if (state.sshFail.stderr) writeSync(2, state.sshFail.stderr);',
    '    process.exit(state.sshFail.code);',
    '  }',
    '  let known = null;',
    '  if (configBytes !== null) {',
    '    const m = configBytes.match(/UserKnownHostsFile "([^"]*)"/);',
    '    if (m !== null) {',
    "      try { known = readFileSync(m[1], 'utf8'); } catch (e) { known = null; }",
    '    }',
    '  }',
    '  const keys = Object.values(state.hostKeys);',
    '  const confirmed = known !== null && keys.some((k) => known.includes(k));',
    '  if (!confirmed) {',
    "    if (known === null || known.trim() === '') {",
    "      writeSync(2, 'Host key verification failed.\\n');",
    '    } else {',
    "      writeSync(2, 'REMOTE HOST IDENTIFICATION HAS CHANGED!\\nIT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!\\n');",
    '    }',
    '    process.exit(255);',
    '  }',
    "  const sep = argv.indexOf('--');",
    "  const words = sep >= 0 ? argv.slice(sep + 2) : argv.slice();",
    "  const command = words.join(' ');",
    '  const machine = helpers.loadMachine(state.machine);',
    '  const parsed = machineLib.parseCommand(command, (p) => machine.readFile(p));',
    '  const input = stdin.length > 0 ? stdin : undefined;',
    '  const result = machine.run(parsed.argv, { root: parsed.root, input, asUser: parsed.asUser || undefined });',
    '  state.machine = helpers.saveMachine(machine);',
    '  state.machine.scripts = state.machine.scripts || {};',
    '  const keep = load();',
    '  state.machine.scripts = keep.machine.scripts;',
    '  save(state);',
    '  if (result.stdout) writeAll(1, result.stdout);',
    '  if (result.stderr) writeAll(2, result.stderr);',
    '  process.exit(result.code);',
    '}',
  ];
  return `${lines.join('\n')}\n`;
}

function keyscanScript(statePath: string, logPath: string): string {
  const lines = [
    `#!${process.execPath}`,
    "import { appendFileSync, readFileSync } from 'node:fs';",
    `const STATE = ${JSON.stringify(statePath)};`,
    `const LOG = ${JSON.stringify(logPath)};`,
    'const argv = process.argv.slice(2);',
    'appendFileSync(LOG, JSON.stringify({ tool: \'ssh-keyscan\', argv, env: { ...process.env }, stdin: \'\', config: null }) + "\\n");',
    'const state = JSON.parse(readFileSync(STATE, \'utf8\'));',
    'const host = argv[argv.length - 1];',
    "const t = argv.indexOf('-t');",
    "const want = t >= 0 && argv[t + 1] ? argv[t + 1].split(',') : ['ed25519', 'ecdsa', 'rsa'];",
    "const names = { ed25519: 'ssh-ed25519', ecdsa: 'ecdsa-sha2-nistp256', rsa: 'ssh-rsa' };",
    "let out = '';",
    "for (const k of ['ed25519', 'ecdsa', 'rsa']) {",
    '  if (want.includes(k) && state.hostKeys[k]) out += host + \' \' + names[k] + \' \' + state.hostKeys[k] + "\\n";',
    '}',
    'process.stdout.write(out);',
  ];
  return `${lines.join('\n')}\n`;
}

export type FakeSshBench = {
  dir: string;
  ssh: string;
  keyscan: string;
  host: string;
  hostKeys: FakeSshKeySet;
  calls(): FakeSshCall[];
  /** Register `script(argv0, result)` on the persisted machine (13.3). */
  script(argv0: string, result: RunResult): void;
  setFail(f: { code: number; stderr: string } | null): void;
  setHang(hang: boolean): void;
  readMachine(): FakeMachine;
  writeMachine(m: FakeMachine): void;
};

/** Read one bench's JSON log without holding the bench. */
export function readFakeSshCalls(dir: string): FakeSshCall[] {
  const logPath = join(dir, 'log.jsonl');
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as FakeSshCall);
}

/** Set up the fake `ssh` + `ssh-keyscan` pair in `dir` (created when missing). */
export function setupFakeSsh(dir: string, o: FakeSshOptions = {}): FakeSshBench {
  mkdirSync(dir, { recursive: true });
  const statePath = join(dir, 'state.json');
  const logPath = join(dir, 'log.jsonl');
  const sshPath = join(dir, 'ssh');
  const keyscanPath = join(dir, 'ssh-keyscan');
  const machine = new FakeMachine();
  if (o.user !== undefined) machine.user = o.user;
  if (o.home !== undefined) machine.home = o.home;
  if (o.sudo !== undefined) machine.sudo = o.sudo;
  if (o.nodeVersion !== undefined) machine.nodeVersion = o.nodeVersion;
  const state: FakeSshState = {
    machine: saveMachine(machine),
    hostKeys: o.keys ?? defaultKeys(),
    sshFail: null,
    hangSsh: false,
  };
  writeFileSync(statePath, JSON.stringify(state));
  writeFileSync(logPath, '');
  writeFileSync(sshPath, sshScript(statePath, logPath));
  writeFileSync(keyscanPath, keyscanScript(statePath, logPath));
  chmodSync(sshPath, 0o755);
  chmodSync(keyscanPath, 0o755);

  const load = (): FakeSshState => JSON.parse(readFileSync(statePath, 'utf8')) as FakeSshState;
  const save = (s: FakeSshState): void => {
    writeFileSync(statePath, JSON.stringify(s));
  };
  const bench: FakeSshBench = {
    dir,
    ssh: sshPath,
    keyscan: keyscanPath,
    host: o.host ?? 'vm.test',
    hostKeys: load().hostKeys,
    calls: () => readFakeSshCalls(dir),
    script: (argv0: string, result: RunResult) => {
      const s = load();
      s.machine.scripts[argv0] = { ...result };
      save(s);
    },
    setFail: (f: { code: number; stderr: string } | null) => {
      const s = load();
      s.sshFail = f === null ? null : { ...f };
      save(s);
    },
    setHang: (hang: boolean) => {
      const s = load();
      s.hangSsh = hang;
      save(s);
    },
    readMachine: () => loadMachine(load().machine),
    writeMachine: (m: FakeMachine) => {
      const s = load();
      const saved = saveMachine(m);
      saved.scripts = s.machine.scripts;
      s.machine = saved;
      save(s);
    },
  };
  return bench;
}
