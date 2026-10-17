// The operator install policy (docs/runtime-kits.md 5.9): run as a command by OpenClaw's security.installPolicy,
// not imported. Reads one protocol-1 request on stdin, prints one protocol-1 envelope on stdout. Fail closed:
// anything unverifiable is a block.
//
// Inputs from the environment (set by the kit's installPolicy config):
//   BYOKIT_TRUSTED_SKILLS  path to the trusted-skills JSON file (Crewhouse's trusted-skills.json shape):
//                          either a list [{ id|name, version, sha256|hash }] or a map { "<id>": { version, sha256 } }.
//   BYOKIT_OWN_ROOTS        JSON array of own content roots; skills sourced under them are the app's own.
//   BYOKIT_PLUGIN_PINS      JSON array [{ spec: '<package>@<version>', integrity }] of the external plugins the kit
//                          installs (engine/plugins.json at the engine pin).
// Rules: any request kind containing 'depend' is blocked everywhere (own roots included);
// dependency installers (a skill installSpec carrying bins/formula/package/module/url/archive) are blocked;
// skill installs are allowed only from own roots or with an exact id + version + SKILL.md sha256 trusted match
// (the version is request.origin.version when present, else the SKILL.md frontmatter version);
// plugin installs are allowed only from the npm registry at exactly a pinned spec, with the pinned integrity.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const allow = (findings) => ({ protocolVersion: 1, decision: 'allow', ...(findings ? { findings } : {}) });
const block = (reason, findings) => ({
  protocolVersion: 1,
  decision: 'block',
  reason,
  ...(findings && findings.length > 0 ? { findings } : {}),
});

const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The trusted-skills file, tolerated in list or map shape with several key spellings. */
function loadTrusted() {
  const path = process.env.BYOKIT_TRUSTED_SKILLS;
  if (!path || !existsSync(path)) return [];
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
  const entries = [];
  const push = (id, entry) => {
    if (typeof id !== 'string' || !id) return;
    const version =
      isRecord(entry) && (typeof entry.version === 'string' ? entry.version : undefined);
    const sha =
      (isRecord(entry) && typeof entry.sha256 === 'string' && entry.sha256) ||
      (isRecord(entry) && typeof entry.hash === 'string' && entry.hash) ||
      (typeof entry === 'string' && entry) ||
      undefined;
    entries.push({ id, version, sha });
  };
  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      if (typeof entry === 'string') push(entry, undefined);
      else if (isRecord(entry)) push(entry.id ?? entry.name, entry);
    }
  } else if (isRecord(parsed)) {
    for (const [id, entry] of Object.entries(parsed)) push(id, entry);
  }
  return entries;
}

function ownRoots() {
  try {
    const roots = JSON.parse(process.env.BYOKIT_OWN_ROOTS ?? '[]');
    return Array.isArray(roots) ? roots.filter((r) => typeof r === 'string').map((r) => resolve(r)) : [];
  } catch {
    return [];
  }
}

const inside = (root, p) => {
  const rel = relative(root, resolve(p));
  return rel !== '' && !rel.startsWith('..');
};

/** First `name:`/`version:` scalars of the SKILL.md frontmatter, plus the sha256 of the file bytes. */
function skillIdentity(sourcePath) {
  let bytes;
  try {
    const file = resolve(sourcePath, 'SKILL.md');
    if (!statSync(file).isFile()) return undefined;
    bytes = readFileSync(file);
  } catch {
    return undefined;
  }
  const text = bytes.toString('utf8');
  let name;
  let version;
  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3);
    const front = text.slice(3, end < 0 ? 0 : end);
    for (const line of front.split('\n')) {
      const m = /^\s*(name|version)\s*:\s*(.+?)\s*$/.exec(line);
      if (m) {
        const value = m[2].replace(/^['"]|['"]$/g, '');
        if (m[1] === 'name') name = value;
        else version = value;
      }
    }
  }
  return { name, version, sha256: createHash('sha256').update(bytes).digest('hex') };
}

const INSTALLER_FIELDS = ['bins', 'formula', 'package', 'module', 'url', 'archive'];

function decideSkill(request, trusted, roots) {
  const kind =
    isRecord(request.request) && typeof request.request.kind === 'string' ? request.request.kind : undefined;
  if (kind !== undefined && /depend/i.test(kind)) {
    return block(`dependency installs are not allowed: ${kind}`, [
      { ruleId: 'dependency-installer', severity: 'critical', message: `request kind ${kind} fetches dependencies` },
    ]);
  }
  const spec = isRecord(request.skill) && isRecord(request.skill.installSpec) ? request.skill.installSpec : {};
  for (const field of INSTALLER_FIELDS) {
    if (spec[field] !== undefined) {
      return block(`skill installs that fetch ${field} are not allowed`, [
        { ruleId: 'dependency-installer', severity: 'critical', message: `installSpec carries ${field}` },
      ]);
    }
  }
  const sourcePath = typeof request.sourcePath === 'string' ? request.sourcePath : undefined;
  if (!sourcePath) return block('skill source is not verifiable');
  if (roots.some((root) => inside(root, sourcePath) || resolve(sourcePath) === root)) return allow();
  const identity = skillIdentity(sourcePath);
  if (!identity) return block('skill SKILL.md is not verifiable');
  // Bundled skills carry no frontmatter version; the reviewed version travels on request.origin.version.
  const originVersion =
    isRecord(request.origin) && typeof request.origin.version === 'string' ? request.origin.version : undefined;
  const candidateVersion = originVersion ?? identity.version;
  const ids = [spec.id, request.targetName, identity.name].filter((v) => typeof v === 'string');
  const hit = trusted.find(
    (entry) =>
      ids.includes(entry.id) &&
      (entry.version === undefined && candidateVersion === undefined || entry.version === candidateVersion) &&
      entry.sha !== undefined &&
      entry.sha.toLowerCase() === identity.sha256.toLowerCase(),
  );
  if (!hit) return block(`skill ${ids[0] ?? request.targetName} is not a trusted skill`);
  return allow();
}

function pins() {
  try {
    const list = JSON.parse(process.env.BYOKIT_PLUGIN_PINS ?? '[]');
    return Array.isArray(list) ? list.filter((p) => isRecord(p) && typeof p.spec === 'string' && typeof p.integrity === 'string') : [];
  } catch {
    return [];
  }
}

function decidePlugin(request) {
  const plugin = isRecord(request.plugin) ? request.plugin : {};
  // N4: the names in `plugin` are self-declared (the candidate manifest's own `name`, or only its id for the
  // dependency tree). Only engine proof of registry origin on the pinned engine counts: source.kind 'npm'
  // (engine-derived from the install request kind) plus the operator-requested specifier. Anything else is a
  // local/archive/git/file candidate spoofing the name. Fail closed.
  const source = isRecord(request.source) ? request.source : undefined;
  const specifier =
    isRecord(request.request) && typeof request.request.requestedSpecifier === 'string'
      ? request.request.requestedSpecifier
      : undefined;
  const npm = source?.kind === 'npm' && specifier !== undefined;
  const scope = npm ? specifier : [plugin.packageName, plugin.pluginId, request.targetName].find((v) => typeof v === 'string');
  if (!scope || !scope.startsWith('@openclaw/')) {
    return block(`only the @openclaw/ plugin scope is allowed, not ${scope ?? request.targetName}`);
  }
  if (!npm) {
    return block(`@openclaw/ plugin install is not from the npm registry: ${specifier ?? request.targetName}`, [
      { ruleId: 'plugin-source', severity: 'critical', message: 'self-declared @openclaw/ name without registry source proof' },
    ]);
  }
  // B7: exactly a pinned spec (`<package>@<engine version>`), never a range, tag or latest.
  const pin = pins().find((p) => p.spec === specifier);
  if (!pin) return block(`not a pinned plugin version: ${specifier}`);
  // The preflight carries the registry's resolution as a file; the engine then checks the installed package
  // against that resolution's integrity, so a matching pin here holds for the bytes installed.
  if (request.sourcePathKind === 'file') {
    let resolution;
    try {
      resolution = JSON.parse(readFileSync(request.sourcePath, 'utf8')).resolution;
    } catch {
      return block(`pinned plugin integrity unreadable: ${specifier}`);
    }
    if (!isRecord(resolution) || `${resolution.name}@${resolution.version}` !== pin.spec) {
      return block(`not a pinned plugin version: ${specifier}`);
    }
    if (resolution.integrity !== pin.integrity) return block(`pinned plugin integrity mismatch: ${specifier}`);
  }
  return allow();
}

function decide(request) {
  if (!isRecord(request) || request.protocolVersion !== 1) return block('unknown policy protocol');
  if (request.targetType === 'plugin') return decidePlugin(request);
  if (request.targetType === 'skill') return decideSkill(request, loadTrusted(), ownRoots());
  return block(`unknown install target ${String(request.targetType)}`);
}

function main() {
  let input = '';
  const fail = (reason) => {
    process.stdout.write(JSON.stringify(block(reason)) + '\n');
  };
  try {
    input = readFileSync(0, 'utf8');
  } catch {
    fail('policy could not read its request');
    return;
  }
  if (Buffer.byteLength(input, 'utf8') > 1024 * 1024) {
    fail('policy request too large');
    return;
  }
  let request;
  try {
    request = JSON.parse(input);
  } catch {
    fail('policy request is not JSON');
    return;
  }
  process.stdout.write(JSON.stringify(decide(request)) + '\n');
}

main();
