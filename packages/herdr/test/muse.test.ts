import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import { createAgents, agentInstallState } from '../src/agents.ts';
import { HerdrKit, installMuse, museReadiness, MUSE_INSTALL_URL } from '../src/index.ts';
import type { AgentStartEvent } from '../src/types.ts';
import { startFakeHerdr } from '../src/testing/index.ts';

const executable = (file: string, text: string): void => { writeFileSync(file, text); chmodSync(file, 0o700); };
const version = '1.2.3-R4';
const fixtureInstall = `#!/bin/bash
set -eu
# Verify isolation at the actual official-script execution boundary.
test "$MUSE_NO_MODIFY_PATH" = 1
test "$MUSE_LOGIN" = 0
test "$MUSE_NO_AUTO_UPDATE" = 1
test "$MUSE_AUTH_PATH" = "$XDG_CONFIG_HOME/muse/auth.json"
test ! -e "$MUSE_AUTH_PATH"
test "$XDG_CONFIG_HOME" = "$HOME/.config"
test "$XDG_CACHE_HOME" = "$HOME/.cache"
test "$XDG_STATE_HOME" = "$HOME/.local/state"
test -d "$TMPDIR"
test -z "\${MUSE_LAUNCHER_URL+x}"
test -z "\${MUSE_CHANNEL+x}"
test -z "\${BASH_ENV+x}"
test -z "\${ZDOTDIR+x}"
test -z "\${HTTPS_PROXY+x}"
test -z "\${OPENAI_API_KEY+x}"
case ":$PATH:" in *":$MUSE_INSTALL_DIR:"*) ;; *) exit 31 ;; esac
case "$MUSE_INSTALL_DIR" in "\${HOME%/home}/bin") ;; *) exit 32 ;; esac
mkdir -p "$MUSE_INSTALL_DIR"
printf '#!/bin/bash\\nMUSE_CHANNEL=muse-stable\\nexit 0\\n' > "$MUSE_INSTALL_DIR/muse"
printf '#!/bin/sh\\nexit 0\\n' > "$MUSE_INSTALL_DIR/muse-bin-${version}"
chmod 700 "$MUSE_INSTALL_DIR/muse" "$MUSE_INSTALL_DIR/muse-bin-${version}"
printf '${version}\\n' > "$MUSE_INSTALL_DIR/.muse-version"
`;

function fixture(script = fixtureInstall) {
  const root = scratchDir('muse-install');
  const home = join(root, 'private'); const tools = join(root, 'tools');
  mkdirSync(tools);
  const source = join(root, 'official-fixture.sh'); writeFileSync(source, script);
  const calls = join(root, 'curl-calls');
  executable(join(tools, 'curl'), `#!/bin/bash
set -eu
test "$1" = -q
printf '%s\\n' "$@" >> '${calls}'
dest=''
while [ "$#" -gt 0 ]; do
 case "$1" in --output) dest="$2"; shift ;; esac
 shift
done
/bin/cp '${source}' "$dest"
`);
  return { home, path: [tools, '/usr/bin', '/bin'], root, calls };
}
const agents = (calls: string[], env?: Record<string, string>) => createAgents({
  call: async (method, params) => { calls.push(method); return method.endsWith('.create')
    ? { root_pane: { pane_id: 'p1' } } : { params }; },
  snapshot: () => ({ revision: 0, connected: true, workspaces: [] }), reread: async () => {},
  launchEnv: () => env,
});

test('missing Muse is typed and refuses before every placement, with no installing event', async () => {
  assert.deepEqual(agentInstallState('muse', { path: [] }), { kind: 'muse', state: 'missing' });
  const personal = scratchDir('muse-controller-inventory');
  executable(join(personal, 'muse'), '#!/bin/sh\nexit 0\n');
  assert.equal(agentInstallState('muse', { path: [personal] }).state, 'installed');
  const statusCalls: string[] = [];
  const [status] = await agents(statusCalls, { PATH: '/missing' }).agentStatus(['muse']);
  assert.equal(status?.installed, false); assert.equal(status?.installState, 'missing');
  assert.equal(status?.signedIn, 'unknown'); assert.deepEqual(statusCalls, []);
  for (const place of [{ workspace: 'new' }, { tab: 'new', workspaceId: 'w1' }, { split: 'p1', direction: 'right' }] as const) {
    const calls: string[] = []; const events: AgentStartEvent[] = [];
    const api = agents(calls, { HOME: '/private', PATH: '/missing' });
    await assert.rejects(api.startAgent({ kind: 'muse', cwd: '/fixture', place,
      // A personal/global probe must not override the real private PATH.
      installProbe: { path: [personal] }, onEvent: (e) => events.push(e) }), { code: 'agent_not_installed' });
    assert.deepEqual(calls, []);
    assert.deepEqual(events.map((e) => e.phase === 'launchFailed' ? e.reason : e.phase), ['not-installed']);
  }
  const own = new HerdrKit({ mode: 'own', bin: '/unused', stateDir: scratchDir('muse-own'), path: ['/missing'] });
  await assert.rejects(own.startAgent({ kind: 'muse', cwd: '/fixture', place: { workspace: 'new' } }), { code: 'agent_not_installed' });
  const calls: string[] = [];
  await assert.rejects(agents(calls).startAgent({ kind: 'muse', cwd: '/fixture', place: { pane: 'p1' },
    env: { env: { HOME: '/private', PATH: '/missing' }, unset: [] } }), { code: 'agent_not_installed' });
  assert.deepEqual(calls, []);
  await assert.rejects(agents(calls).startAgent({ kind: 'muse', cwd: '/fixture', place: { workspace: 'new' },
    worktree: {}, env: { PATH: '/missing' } }), { code: 'agent_not_installed' });
  assert.deepEqual(calls, []);
});

test('unobserved pane/adopt env stays unknown; existing env replacement guard is preserved', async () => {
  assert.equal(museReadiness().state, 'unknown');
  const calls: string[] = [];
  await agents(calls, { PATH: '/missing' }).startAgent({ kind: 'muse', cwd: '/fixture',
    place: { pane: 'p1' }, installProbe: { path: [] } });
  assert.deepEqual(calls, ['agent.start']);
  calls.length = 0;
  await assert.rejects(agents(calls).startAgent({ kind: 'muse', cwd: '/fixture', place: { pane: 'p1' },
    env: { HOME: '/private', PATH: '/missing' } }), { code: 'env_mismatch' });
  assert.deepEqual(calls, []);
});

test('explicit official install receives private env and returns a launchable selected release', async () => {
  const f = fixture();
  const inherited = { MUSE_LAUNCHER_URL: 'https://untrusted.invalid', MUSE_CHANNEL: 'muse-canary',
    BASH_ENV: '/untrusted/profile', ZDOTDIR: '/untrusted/home', HTTPS_PROXY: 'http://untrusted.invalid', OPENAI_API_KEY: 'fixture-only-canary' };
  const saved = Object.fromEntries(Object.keys(inherited).map((k) => [k, process.env[k]]));
  let result: Awaited<ReturnType<typeof installMuse>>;
  try { Object.assign(process.env, inherited); result = await installMuse(f); }
  finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const r = result.receipt;
  assert.equal(r.version, version);
  assert.equal(r.source, MUSE_INSTALL_URL);
  assert.equal(readFileSync(r.native, 'utf8'), '#!/bin/sh\nexit 0\n');
  assert.match(r.installerSha256!, /^[a-f0-9]{64}$/);
  assert.match(r.nativeSha256, /^[a-f0-9]{64}$/);
  assert.match(r.launcherSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(museReadiness(r.env), { state: 'installed', signedIn: 'unknown', bin: r.bin, version });
  assert.equal(agentInstallState('muse', { path: r.path }).state, 'installed');
  assert.equal(r.env.PATH, r.path.join(':'));
  assert.equal(r.path[0], join(f.home, '.local/bin'));
  const policy = readFileSync(f.calls, 'utf8');
  for (const option of ['-q', '--max-redirs\n3', '--connect-timeout\n10', '--max-time\n60', '--max-filesize\n536870912', "--proto\n=https", MUSE_INSTALL_URL]) assert.ok(policy.includes(option), option);
  for (const profile of ['.profile', '.bashrc', '.zshrc']) assert.equal(existsSync(join(f.home, profile)), false);
  assert.ok(!readdirSync(f.home).some((n) => n.startsWith('.muse-install-')));
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const api = createAgents({ call: async (method, params) => { calls.push({ method, params });
    return { root_pane: { pane_id: 'p1' } }; }, snapshot: () => ({ revision: 0, connected: true, workspaces: [] }), reread: async () => {} });
  await api.startAgent({ kind: 'muse', cwd: '/fixture', place: { tab: 'new', workspaceId: 'w1' }, env: r.env });
  assert.deepEqual(calls.map((c) => c.method), ['tab.create', 'agent.start']);
  assert.equal((calls[0]!.params.env as Record<string, string>).PATH, r.env.PATH);
  assert.equal('env' in calls[1]!.params, false, 'agent.start has no upstream env param');
  // Reuse an existing working install without downloads or updates, even if installer now fails.
  writeFileSync(join(f.root, 'official-fixture.sh'), '#!/bin/bash\nexit 42\n');
  const reused = await installMuse(f); assert.equal(reused.ok, true);
  assert.equal(readFileSync(f.calls, 'utf8'), policy);
  assert.equal(readFileSync(r.native, 'utf8'), '#!/bin/sh\nexit 0\n');
  const abort = new AbortController(); abort.abort();
  const cancelled = await installMuse({ ...f, signal: abort.signal });
  assert.equal(cancelled.ok, false); if (!cancelled.ok) assert.equal(cancelled.code, 'cancelled');
  assert.equal(readFileSync(r.native, 'utf8'), '#!/bin/sh\nexit 0\n');
});

test('receipt launch PATH reaches the actual prepared shell; exact typed RPC remains bypassable', async () => {
  const result = await installMuse(fixture()); assert.ok(result.ok);
  if (!result.ok) return;
  const fake = await startFakeHerdr({ dir: scratchDir('muse-shell-env') });
  const kit = new HerdrKit({ mode: 'adopt', bin: '/unused', socketPath: fake.socketPath });
  try {
    await kit.start();
    fake.world.panes.find((p) => p.pane_id === 'w1:p1')!.env = { PATH: '/controller-only', PERSONAL_TOKEN: 'fixture-only' };
    const ref = await kit.startAgent({ kind: 'muse', cwd: '/fixture', place: { tab: 'new', workspaceId: 'w1' },
      env: { env: result.receipt.env, unset: [] } });
    const actual = fake.world.panes.find((p) => p.pane_id === ref.paneId)!.env!;
    assert.equal(actual.PATH, result.receipt.env.PATH);
    assert.equal(actual.HOME, result.receipt.env.HOME);
    assert.equal(actual.MUSE_NO_AUTO_UPDATE, '1');
    assert.equal(actual.MUSE_LOGIN, '0');
    assert.equal('PERSONAL_TOKEN' in actual, false);
    // Public generated typing and params stay exact; only the composable helper preflights.
    await kit.call('agent.start', { pane_id: 'w1:p1', kind: 'muse', name: 'typed', timeout_ms: 1 });
  } finally { await kit.stop(); await fake.stop(); }
});

test('launcher-only, protected/failing downloads and cancellation never become installed', async () => {
  for (const [script, code] of [
    ['#!/bin/bash\nprintf "muse: download refused (HTTP 403)" >&2\nexit 1\n', 'protected_download'],
    ['#!/bin/bash\nexit 42\n', 'install_failed'],
    ['#!/bin/bash\nmkdir -p "$MUSE_INSTALL_DIR"\nprintf "#!/bin/bash\\nMUSE_CHANNEL=muse-stable\\n" > "$MUSE_INSTALL_DIR/muse"\nchmod 700 "$MUSE_INSTALL_DIR/muse"\n', 'incomplete_install'],
  ] as const) {
    const f = fixture(script); const result = await installMuse(f);
    assert.equal(result.ok, false); if (!result.ok) assert.equal(result.code, code);
    assert.equal(existsSync(join(f.home, '.local/bin/muse')), false);
    assert.ok(!readdirSync(f.home).some((n) => n.startsWith('.muse-install-')));
  }
  const f = fixture('#!/bin/bash\nsleep 30 &\nwait\n');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 150);
  const started = Date.now();
  const result = await installMuse({ ...f, signal: controller.signal }); clearTimeout(timer);
  assert.equal(result.ok, false); if (!result.ok) assert.equal(result.code, 'cancelled');
  assert.ok(Date.now() - started < 5000);
  assert.ok(!readdirSync(f.home).some((n) => n.startsWith('.muse-install-')));
  const expired = await installMuse({ ...fixture('#!/bin/bash\nsleep 30\n'), timeoutMs: 100 });
  assert.equal(expired.ok, false); if (!expired.ok) assert.equal(expired.code, 'timeout');
});

test('unsafe/symlink/escape targets are refused and existing files are preserved', async () => {
  const f = fixture(); mkdirSync(f.home);
  const outside = join(f.root, 'outside'); mkdirSync(outside);
  symlinkSync(outside, join(f.home, 'escape'));
  for (const installDir of [outside, join(f.home, 'escape/bin')]) {
    const result = await installMuse({ ...f, installDir });
    assert.equal(result.ok, false); if (!result.ok) assert.equal(result.code, 'unsafe_path');
  }
  const installDir = join(f.home, 'existing'); mkdirSync(installDir);
  writeFileSync(join(installDir, 'keep'), 'preserve');
  const result = await installMuse({ ...f, installDir });
  assert.equal(result.ok, false); if (!result.ok) assert.equal(result.code, 'incomplete_install');
  assert.equal(readFileSync(join(installDir, 'keep'), 'utf8'), 'preserve');
  assert.equal(existsSync(f.calls), false);
  executable(join(installDir, 'muse'), '#!/bin/bash\nMUSE_CHANNEL=muse-stable\nexit 0\n');
  assert.equal(museReadiness({ PATH: installDir }).state, 'launcher-only');
  assert.equal(agentInstallState('muse', { path: [installDir] }).state, 'missing');
  assert.deepEqual(readdirSync(outside), []);
  executable(join(installDir, 'muse'), '#!/bin/sh\nexec mise x -- muse "$@"\n');
  assert.equal(museReadiness({ PATH: installDir }).state, 'launcher-only');
  assert.equal(agentInstallState('muse', { path: [installDir] }).state, 'missing', 'a shim is not an installed native Muse');
});
