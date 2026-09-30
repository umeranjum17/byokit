// App-owned deployment recipes. Nothing here chooses a machine provider or reads credentials.
import { checkRecipe } from '../../packages/cloud/src/recipe.ts';
import { machine } from '../../packages/cloud/src/machine.ts';
import { memoryStore } from '../../packages/cloud/src/testing/fake-provider.ts';
import type { HostRecipe, MachineRef, Provider } from '../../packages/cloud/src/types.ts';

export type RecipeInputs = {
  home: string;
  node: HostRecipe['node']; // verified Node tarball checksums supplied by the app
  archive: string; // release tarball already uploaded beneath home; no sign-ins in this archive
  archiveSha256: string;
};
export type AppRecipe = {
  host: HostRecipe;
  prerequisites: readonly HostRecipe[];
  dataDirs: readonly string[];
  exposure: { port: number; bind: '0.0.0.0'; trustProxy: false; path: string };
  health: readonly string[];
  doctor: readonly string[];
};
export type Child = { argv: readonly string[]; env: Readonly<Record<string, string>> };

/** Exit when either child exits; systemd restarts the entire cgroup (G6). */
export function wrapper(children: readonly Child[]): string {
  return `import { spawn } from 'node:child_process';
import { mkdirSync, appendFileSync } from 'node:fs';
const specs = ${JSON.stringify(children)};
const children = specs.map(s => spawn(s.argv[0] === 'node' ? process.execPath : s.argv[0], s.argv.slice(1), { stdio: 'inherit', env: { HOME: process.env.HOME, PATH: process.env.PATH, ...s.env } }));
let stopping = false;
function stop(code, signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  const timer = setTimeout(() => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); process.exit(code); }, 5000);
  Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve)))).then(() => { clearTimeout(timer); process.exit(code); });
}
for (const child of children) { child.once('error', () => stop(1)); child.once('exit', () => stop(1)); }
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { mkdirSync('.byokit',{recursive:true,mode:0o700}); appendFileSync('.byokit/m6-stop-events',Date.now()+' '+signal+String.fromCharCode(10),{mode:0o600}); console.error('M6 wrapper received '+signal); stop(0, signal); });
`;
}

function base(i: RecipeInputs, name: string, user: string): HostRecipe {
  if (!/^[a-f0-9]{64}$/.test(i.archiveSha256)) throw new Error('archiveSha256 must be a verified SHA-256');
  if (!i.archive.startsWith(`${i.home}/`) || i.archive.split('/').includes('..')) throw new Error('archive must be beneath the machine home');
  const workDir = `${i.home}/.users/${user}/app`;
  return {
    name, user, node: i.node, workDir,
    installRoot: [['apt-get', 'update'], ['apt-get', 'install', '-y', 'ca-certificates', 'curl', 'xz-utils', 'tar']],
    install: [
      ['node', '-e', "const f=require('node:fs'),c=require('node:crypto');if(c.createHash('sha256').update(f.readFileSync(process.argv[1])).digest('hex')!==process.argv[2])process.exit(3)", i.archive, i.archiveSha256],
      ['tar', '-xzf', i.archive, '--strip-components=1', '--no-same-owner'],
      ['npm', 'ci'],
    ],
    run: { argv: ['node', `${workDir}/machine-wrapper.mjs`], env: {} },
  };
}
function withWrapper(r: HostRecipe, children: readonly Child[]): HostRecipe {
  for (const child of children) checkRecipe({ ...r, run: child }, r.name);
  const source = wrapper(children);
  return { ...r, install: [...r.install, ['node', '-e', `require('node:fs').writeFileSync('machine-wrapper.mjs',${JSON.stringify(source)},{mode:0o600})`]] };
}

export function crewhouseRecipe(i: RecipeInputs): AppRecipe {
  const r = base(i, 'crewhouse', 'crewbot');
  const home = `${i.home}/.users/crewbot`;
  const data = `${home}/data`;
  const hostEnv = {
    HOME: home, CREWHOUSE_HOST: '127.0.0.1', CREWHOUSE_PORT: '7711',
    CREWHOUSE_LINK_HOST: '127.0.0.1', CREWHOUSE_LINK_PORT: '7712',
    CREWHOUSE_STATE_DIR: `${data}/state`, CREWHOUSE_CREW_DIR: `${data}/crew`,
    CREWHOUSE_TOOLS_DIR: `${data}/tools`, CREWHOUSE_RELAY: 'ws://127.0.0.1:7300',
  };
  const host = withWrapper({ ...r,
    run: { ...r.run, env: hostEnv },
    node: { ...i.node, range: '>=22.22.3' },
    installRoot: [...r.installRoot!, ['apt-get', 'install', '-y', 'bubblewrap', 'xvfb', 'chromium', 'ffmpeg', 'git', 'python3-venv']],
    install: [...r.install, ['npm', 'run', 'build:web']],
  }, [
    { argv: ['node', 'relay/main.ts'], env: { HOME: home, HOST: '0.0.0.0', PORT: '7300', RELAY_DATA: `${data}/relay`, RELAY_TRUST_PROXY: '0' } },
    { argv: ['node', 'src/main.ts'], env: hostEnv },
  ]);
  return {
    host, prerequisites: [], dataDirs: [`${data}/state`, `${data}/crew`, `${data}/tools`, `${data}/relay`],
    exposure: { port: 7300, bind: '0.0.0.0', trustProxy: false, path: '/health' },
    health: ['curl', '--fail', '--silent', 'http://127.0.0.1:7300/health'],
    doctor: ['node', `${r.workDir}/src/doctor.ts`],
  };
}

export function muxrRecipe(i: RecipeInputs & { runtime: HostRecipe }): AppRecipe {
  const r = base(i, 'muxr', 'muxrbot');
  const home = `${i.home}/.users/muxrbot`;
  // The app supplies its pinned Herdr installer, binary and isolated socket configuration.
  // This lane declares those steps; it never runs them against a real server.
  if (!i.runtime.run.argv[0]?.startsWith('/') || i.runtime.name === r.name) throw new Error('runtime needs a separate unit and an absolute binary');
  if (i.runtime.user !== 'muxrbot' || !i.runtime.run.env.HERDR_SOCKET_PATH?.startsWith(`${i.runtime.workDir}/`)) throw new Error('runtime must use muxrbot and its isolated socket');
  const host = withWrapper(r, [
    { argv: ['node', 'relay.js'], env: { HOME: home, MUXR_RELAY_HOST: '0.0.0.0', MUXR_RELAY_PORT: '8792', MUXR_RELAY_DATA_DIR: `${home}/data/relay`, MUXR_RELAY_MDNS: '0', MUXR_TRUST_PROXY: '0' } },
    { argv: ['node', 'host.js'], env: { HOME: home, MUXR_HOME: `${home}/data`, MUXR_MODE: 'selfhost', HERDR_BIN: i.runtime.run.argv[0], ...i.runtime.run.env } },
  ]);
  return {
    host, prerequisites: [i.runtime], dataDirs: [`${home}/data`, i.runtime.workDir],
    exposure: { port: 8792, bind: '0.0.0.0', trustProxy: false, path: '/health' },
    health: ['curl', '--fail', '--silent', 'http://127.0.0.1:8792/health'],
    doctor: ['node', `${r.workDir}/scripts/diagnostics/presentation/doctor.mjs`],
  };
}

export function studioRecipe(i: RecipeInputs): AppRecipe {
  const r = base(i, 'studio', 'studiobot');
  const home = `${i.home}/.users/studiobot`;
  return {
    host: { ...r, run: { argv: ['node', '--import', 'tsx', `${r.workDir}/bin/engine.mjs`], env: { HOME: home, PORT: '8787' } } },
    prerequisites: [], dataDirs: [`${home}/data`],
    // Current engine is HTTP/SSE/MCP, not a link host. This exposes its own authenticated ingress.
    exposure: { port: 8787, bind: '0.0.0.0', trustProxy: false, path: '/health' },
    health: ['curl', '--fail', '--silent', 'http://127.0.0.1:8787/health'],
    doctor: ['node', '--import', 'tsx', '-e', "fetch('http://127.0.0.1:8787/health').then(r=>{if(!r.ok)process.exit(1)})"],
  };
}

/** Every unit goes through M3's installer/writer; prerequisite units start before the host. */
export async function installApp(provider: Provider, ref: MachineRef, app: AppRecipe): Promise<void> {
  for (const recipe of [...app.prerequisites, app.host]) {
    const scoped = { ...ref, name: recipe.name };
    const m = machine({ provider, store: memoryStore({ ref: scoped, providerKey: '' }) });
    await m.install(recipe);
  }
}
