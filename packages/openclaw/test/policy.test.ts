// The operator install policy (5.9, O5): trusted skills, own roots, installer blocking, plugin scope.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const policy = new URL('../policy/policy.mjs', import.meta.url);

function run(request: unknown, env: Record<string, string> = {}): Record<string, unknown> {
  const input = typeof request === 'string' ? request : JSON.stringify(request);
  const stdout = execFileSync(process.execPath, [policy.pathname], { input, encoding: 'utf8', env: { ...process.env, ...env } });
  return JSON.parse(stdout);
}

const skillRequest = (sourcePath: string, extra: Record<string, unknown> = {}) => ({
  protocolVersion: 1,
  targetType: 'skill',
  targetName: 'my-skill',
  sourcePath,
  sourcePathKind: 'directory',
  origin: { type: 'clawhub' },
  request: { kind: 'skill-install', mode: 'install' },
  skill: { installId: 'default' },
  ...extra,
});

const SKILL_MD = '---\nname: my-skill\nversion: 1.0.0\n---\n\n# My skill\n';

const scratch: string[] = [];

function skillDir(body: string = SKILL_MD): string {
  const dir = mkdtempSync(join(tmpdir(), 'byokit-o5-skill-'));
  scratch.push(dir);
  writeFileSync(join(dir, 'SKILL.md'), body);
  return dir;
}

function trustedFor(dir: string, body: string = SKILL_MD, shape: 'list' | 'map' = 'list'): string {
  const sha256 = createHash('sha256').update(body, 'utf8').digest('hex');
  const trustedDir = mkdtempSync(join(tmpdir(), 'byokit-o5-trusted-'));
  scratch.push(trustedDir);
  const file = join(trustedDir, 'trusted.json');
  writeFileSync(
    file,
    shape === 'list'
      ? JSON.stringify([{ id: 'my-skill', version: '1.0.0', sha256 }])
      : JSON.stringify({ 'my-skill': { version: '1.0.0', sha256 } }),
  );
  return file;
}

const npmSource = { kind: 'npm', authority: 'third-party', mutable: false, network: true };

const pluginRequest = (name: string, extra: Record<string, unknown> = {}) => ({
  protocolVersion: 1,
  targetType: 'plugin',
  targetName: name,
  sourcePathKind: 'archive',
  source: npmSource,
  origin: { type: 'plugin-npm' },
  request: { kind: 'plugin-npm', mode: 'install', requestedSpecifier: name },
  plugin: { contentType: 'package', pluginId: name, packageName: name },
  ...extra,
});

test('a trusted skill with exact id, version and sha256 is allowed', async () => {
  const dir = skillDir();
  const trusted = trustedFor(dir);
  assert.equal(run(skillRequest(dir), { BYOKIT_TRUSTED_SKILLS: trusted }).decision, 'allow');
});

test('the map-shaped trusted file is accepted too', async () => {
  const dir = skillDir();
  assert.equal(run(skillRequest(dir), { BYOKIT_TRUSTED_SKILLS: trustedFor(dir, SKILL_MD, 'map') }).decision, 'allow');
});

test('version or sha mismatch blocks', async () => {
  const dir = skillDir();
  const trusted = trustedFor(dir);
  const other = skillDir('---\nname: my-skill\nversion: 2.0.0\n---\n\n# Changed\n');
  assert.equal(run(skillRequest(other), { BYOKIT_TRUSTED_SKILLS: trusted }).decision, 'block');
  const sameVersionOtherBytes = skillDir('---\nname: my-skill\nversion: 1.0.0\n---\n\n# Changed\n');
  assert.equal(run(skillRequest(sameVersionOtherBytes), { BYOKIT_TRUSTED_SKILLS: trusted }).decision, 'block');
  assert.equal(run(skillRequest(skillDir('---\nname: other-skill\nversion: 1.0.0\n---\n')), { BYOKIT_TRUSTED_SKILLS: trusted }).decision, 'block');
});

test('an unlisted skill and a missing source block', async () => {
  const dir = skillDir();
  assert.equal(run(skillRequest(dir)).decision, 'block');
  assert.equal(run(skillRequest(join(dir, 'missing')), { BYOKIT_TRUSTED_SKILLS: trustedFor(dir) }).decision, 'block');
});

test('own roots are allowed without a trusted entry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'byokit-o5-own-'));
  scratch.push(root);
  const dir = join(root, 'skills', 'mine');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: mine\nversion: 9.9.9\n---\n');
  assert.equal(run(skillRequest(dir), { BYOKIT_OWN_ROOTS: JSON.stringify([root]) }).decision, 'allow');
  assert.equal(run(skillRequest(skillDir()), { BYOKIT_OWN_ROOTS: JSON.stringify([root]) }).decision, 'block');
});

test('dependency installers block even for trusted skills', async () => {
  const dir = skillDir();
  const env = { BYOKIT_TRUSTED_SKILLS: trustedFor(dir) };
  for (const field of ['bins', 'formula', 'package', 'module', 'url', 'archive']) {
    const decision = run(
      skillRequest(dir, { skill: { installId: 'default', installSpec: { kind: 'install', [field]: ['x'] } } }),
      env,
    );
    assert.equal(decision.decision, 'block', field);
  }
});

test('only the @openclaw/ plugin scope is allowed', async () => {
  assert.equal(run(pluginRequest('@openclaw/weather')).decision, 'allow');
  assert.equal(run(pluginRequest('someone-weather')).decision, 'block');
  assert.equal(run(pluginRequest('@openclaw/weather'), {}).decision, 'allow');
});

test('a self-declared @openclaw/ name without registry source proof blocks (N4)', async () => {
  // Request shapes verified against the pinned engine: source is engine-derived
  // from the install kind, requestedSpecifier is the operator's spec, while
  // plugin.packageName is the candidate manifest's own name.
  const spoof = (source: unknown, requestedSpecifier?: string, kind = 'plugin-npm') =>
    run(pluginRequest('@openclaw/weather', {
      source,
      request: { kind, mode: 'install', ...(requestedSpecifier === undefined ? {} : { requestedSpecifier }) },
    })).decision;
  assert.equal(
    spoof({ kind: 'local-path', authority: 'user', mutable: true, network: false }, '/tmp/evil', 'plugin-dir'),
    'block',
  );
  assert.equal(
    spoof({ kind: 'archive', authority: 'third-party', mutable: true, network: false }, '/tmp/evil.tgz', 'plugin-archive'),
    'block',
  );
  assert.equal(
    spoof({ kind: 'git', authority: 'third-party', mutable: true, network: true }, 'git:https://evil.example/x.git', 'plugin-git'),
    'block',
  );
  const bare = pluginRequest('@openclaw/weather') as Record<string, unknown>;
  delete bare.source;
  assert.equal(run(bare).decision, 'block');
  // npm source but a non-scope specifier: the specifier governs, not the manifest name.
  assert.equal(spoof(npmSource, 'someone-else'), 'block');
  // A versioned registry specifier still allows.
  assert.equal(spoof(npmSource, '@openclaw/weather@1.2.3'), 'allow');
});

test('garbage fails closed with a block envelope', async () => {
  assert.equal(run('not json').decision, 'block');
  assert.equal(run({ protocolVersion: 2, targetType: 'skill' }).decision, 'block');
  assert.equal(run({ protocolVersion: 1, targetType: 'mystery' }).decision, 'block');
  for (const envelope of [
    run('not json'),
    run({ protocolVersion: 1, targetType: 'mystery' }),
  ]) {
    assert.equal(envelope.protocolVersion, 1);
    assert.equal(typeof envelope.reason, 'string');
  }
});

test('scratch temp dirs are removed', async () => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});
