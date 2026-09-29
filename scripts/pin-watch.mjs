#!/usr/bin/env node
// byk-pin-watch: upstream pin drift watch (gap G2).
//
// Compares the pinned upstream versions with what's published now:
// - the engine pin (packages/openclaw/engine/package.json) against the npm
//   dist-tags `extended-stable` and `latest`, diffing gateway method/event
//   names from the public protocol.schema.json (methods) and the engine
//   tarball's GATEWAY_EVENTS list (events, the same source scripts/gen-methods.ts reads);
// - the companion-app pin (HERDR_VERSION/HERDR_PROTOCOL in
//   packages/herdr/src/constants.ts) against https://herdr.dev/latest.json,
//   diffing request methods and subscription kinds from the new release's
//   `api schema` output when its asset can be fetched and verified.
//
// Usage:
//   node scripts/pin-watch.mjs [--format summary|issue-body|json] [--fixtures DIR]
//
// --fixtures DIR is the offline dry-run mode used by npm test (which blocks
// outbound network): DIR holds recorded docs (pins.json, openclaw-*.json,
// herdr-*.json) instead of any fetch. Live mode needs network and stays out
// of `npm test`; it runs in the weekly pin-watch workflow. Exit 0 always:
// drift is reported in the output, not as a failure.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const scriptDir = dirname(new URL(import.meta.url).pathname);
const repoDir = join(scriptDir, '..');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? '') : null;
};
const FORMAT = flag('--format') || 'summary';
const FIXTURES = flag('--fixtures');
if (!['summary', 'issue-body', 'json'].includes(FORMAT)) {
  console.error(`pin-watch: unknown --format ${FORMAT}`);
  process.exit(2);
}

function die(message) {
  console.error(`pin-watch: ${message}`);
  process.exit(1);
}

function diffLists(oldArr, newArr) {
  const oldSet = new Set(oldArr ?? []);
  const newSet = new Set(newArr ?? []);
  return {
    added: [...newSet].filter((m) => !oldSet.has(m)).sort(),
    removed: [...oldSet].filter((m) => !newSet.has(m)).sort(),
  };
}

// --- doc shapes -----------------------------------------------------------
// openclaw doc: { version, methods: string[], events?: string[] }
// herdr doc:    { version, protocol, methods: string[], events: string[] }

function summarizePair(label, oldDoc, newDoc) {
  const methods = diffLists(oldDoc.methods, newDoc.methods);
  const out = {
    label,
    from: oldDoc.version,
    to: newDoc.version,
    methods: {
      from: oldDoc.methods.length,
      to: newDoc.methods.length,
      added: methods.added,
      removed: methods.removed,
    },
    events: null,
  };
  if (oldDoc.events && newDoc.events) {
    const events = diffLists(oldDoc.events, newDoc.events);
    out.events = {
      from: oldDoc.events.length,
      to: newDoc.events.length,
      added: events.added,
      removed: events.removed,
    };
  }
  return out;
}

// --- fixtures (offline) mode ----------------------------------------------

function readFixtures(dir) {
  const read = (f) => JSON.parse(readFileSync(join(dir, f), 'utf8'));
  const pins = read('pins.json');
  return {
    pins,
    ocPinned: read('openclaw-pinned.json'),
    ocStable: read('openclaw-extended-stable.json'),
    ocLatest: read('openclaw-latest.json'),
    herdrPinned: read('herdr-pinned.json'),
    herdrLatest: read('herdr-latest.json'),
  };
}

// --- live mode ------------------------------------------------------------

function npmJson(cmdArgs, cwd) {
  const out = execFileSync('npm', cmdArgs, {
    cwd: cwd ?? repoDir,
    env: { ...process.env, HOME: process.env.HOME ?? tmpdir() },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;
}

// Pack one npm tarball into an isolated throwaway dir (isolated HOME and npm
// cache, same hygiene as packages/openclaw/scripts/gen-methods.ts) and return
// the extracted package dir.
function packTarball(spec) {
  const tmp = mkdtempSync(join(tmpdir(), 'byokit-pin-watch-'));
  try {
    const pack = spawnSync('npm', ['pack', spec, '--pack-destination', tmp], {
      cwd: tmp,
      env: { PATH: process.env.PATH ?? '', HOME: tmp, npm_config_cache: join(tmp, 'npm-cache') },
      encoding: 'utf8',
    });
    if (pack.status !== 0) die(`npm pack ${spec} failed: ${pack.stderr}`);
    const tgz = readdirSync(tmp).find((f) => f.endsWith('.tgz'));
    if (!tgz) die(`npm pack ${spec} produced no tarball`);
    const untar = spawnSync('tar', ['-xzf', join(tmp, tgz), '-C', tmp], { encoding: 'utf8' });
    if (untar.status !== 0) die(`tar extract failed for ${spec}`);
    return join(tmp, 'package');
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('pin-watch:')) throw e;
    die(`fetching ${spec}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Methods straight from the public protocol.schema.json of a protocol package version.
function protocolMethods(version) {
  const dir = packTarball(`@openclaw/gateway-protocol@${version}`);
  const schema = JSON.parse(readFileSync(join(dir, 'protocol.schema.json'), 'utf8'));
  return { version, methods: Object.keys(schema.methods ?? {}).sort() };
}

function walkFiles(dir, exts) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(p, exts));
    else if (exts.some((e) => p.endsWith(e))) out.push(p);
  }
  return out;
}

// The bracketed array literal after `const MARKER = [`, skipping string
// contents so brackets inside strings cannot unbalance the depth count.
function arrayLiteralAfter(src, marker) {
  const at = src.indexOf(`const ${marker} = [`);
  if (at < 0) return null;
  let open = src.indexOf('[', at);
  let depth = 0;
  let str = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (str) {
      if (c === '\\') i++;
      else if (c === str) str = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') str = c;
    else if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null;
}

// Event names from an engine tarball's GATEWAY_EVENTS list; named constants
// resolve from their `const X = "…"` definitions anywhere in dist.
function engineEvents(version) {
  const dir = packTarball(`openclaw@${version}`);
  const files = walkFiles(join(dir, 'dist'), ['.js', '.mjs']);
  const holder = files.map((f) => ({ f, src: readFileSync(f, 'utf8') })).find(({ src }) => src.includes('const GATEWAY_EVENTS = ['));
  if (!holder) die(`no GATEWAY_EVENTS in openclaw@${version} dist`);
  let lit = arrayLiteralAfter(holder.src, 'GATEWAY_EVENTS');
  if (!lit) die(`unterminated GATEWAY_EVENTS in openclaw@${version}`);
  const consts = new Map();
  for (const { src } of files.map((f) => ({ f, src: readFileSync(f, 'utf8') }))) {
    for (const m of src.matchAll(/const ([A-Z][A-Z0-9_]+) = "([^"]+)"/g)) consts.set(m[1], m[2]);
  }
  for (const [k, v] of consts) {
    lit = lit.replace(new RegExp(`(?<![\\w'"\`])${k}(?![\\w'"\`])`, 'g'), JSON.stringify(v));
  }
  return Function(`"use strict"; return (${lit});`)();
}

function readPins() {
  const engine = JSON.parse(readFileSync(join(repoDir, 'packages/openclaw/engine/package.json'), 'utf8'));
  const constants = readFileSync(join(repoDir, 'packages/herdr/src/constants.ts'), 'utf8');
  const herdrVersion = constants.match(/HERDR_VERSION = '([^']+)'/)?.[1];
  const herdrProtocol = Number(constants.match(/HERDR_PROTOCOL(?:: number)? = (\d+)/)?.[1]);
  if (!engine.dependencies?.openclaw || !herdrVersion || !Number.isFinite(herdrProtocol)) {
    die('could not read pins from engine/package.json and herdr constants.ts');
  }
  return { openclaw: engine.dependencies.openclaw, herdr: herdrVersion, herdrProtocol };
}

function curlJson(url) {
  const out = execFileSync('curl', ['-fsSL', '--max-time', '60', url], { encoding: 'utf8' });
  return JSON.parse(out);
}

function herdrMethodsAndEvents(schemaDoc) {
  const methods = new Set();
  const walk = (o) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (o && typeof o === 'object') {
      if (o.method && typeof o.method === 'object' && typeof o.method.const === 'string') {
        methods.add(o.method.const);
      }
      Object.values(o).forEach(walk);
    }
  };
  walk(schemaDoc.schemas);
  const sub = schemaDoc.schemas?.request?.$defs?.Subscription?.oneOf ?? [];
  const events = sub.map((v) => v?.properties?.type?.const).filter((e) => typeof e === 'string').sort();
  return { methods: [...methods].sort(), events };
}

// Best-effort: download the linux-x86_64 asset of a Herdr release, verify its
// sha256 against the manifest, and read its bundled `api schema`. Returns null
// when anything fails; the issue then carries the version/protocol drift note.
function herdrSchemaDoc(manifest) {
  try {
    const url = manifest.assets?.['linux-x86_64'];
    const want = manifest.sha256?.['linux-x86_64'];
    if (!url || !want || process.platform !== 'linux' || process.arch !== 'x64') return null;
    const tmp = mkdtempSync(join(tmpdir(), 'byokit-pin-herdr-'));
    const bin = join(tmp, 'herdr');
    execFileSync('curl', ['-fsSL', '--max-time', '300', '-o', bin, url]);
    const sum = createHash('sha256').update(readFileSync(bin)).digest('hex');
    if (sum !== want) {
      console.error(`pin-watch: herdr asset sha256 mismatch, skipping schema diff`);
      return null;
    }
    chmodSync(bin, 0o755);
    const out = join(tmp, 'schema.json');
    execFileSync(bin, ['api', 'schema', '--output', out], {
      env: { PATH: '/usr/bin:/bin', HOME: tmp },
      timeout: 120000,
    });
    const doc = JSON.parse(readFileSync(out, 'utf8'));
    const { methods, events } = herdrMethodsAndEvents(doc);
    return { version: manifest.version, protocol: doc.protocol, methods, events };
  } catch (e) {
    console.error(`pin-watch: herdr schema fetch skipped (${e instanceof Error ? e.message : String(e)})`);
    return null;
  }
}

function liveDocs() {
  const pins = readPins();
  const tags = npmJson(['view', 'openclaw', 'dist-tags', '--json']);
  const latest = tags.latest;
  const stable = tags['extended-stable'];
  if (!latest || !stable) die(`unexpected dist-tags: ${JSON.stringify(tags)}`);

  const ocPinned = { ...protocolMethods(pins.openclaw), events: undefined };
  // Pinned events are the committed generated table (built from this exact
  // tarball by gen-methods.ts); refetching the 60MB engine tarball weekly for
  // an identical list is waste.
  const genEvents = readFileSync(join(repoDir, 'packages/openclaw/src/generated/events.ts'), 'utf8');
  ocPinned.events = [...new Set([...genEvents.matchAll(/^  '([^']+)':/gm)].map((m) => m[1]))].sort();

  const ocStable = protocolMethods(stable);
  const ocLatest = protocolMethods(latest);
  // Event lists come from the engine tarballs; skip a second huge download
  // when a channel matches one already fetched.
  const eventCache = new Map();
  const withEvents = (doc) => {
    if (!eventCache.has(doc.version)) eventCache.set(doc.version, engineEvents(doc.version));
    return { ...doc, events: eventCache.get(doc.version) };
  };
  const ocLatestFull = withEvents(ocLatest);
  const ocStableFull = stable === latest ? ocLatestFull : { ...ocStable, events: undefined };

  const manifest = curlJson('https://herdr.dev/latest.json');
  const herdrReport = JSON.parse(readFileSync(join(repoDir, 'packages/herdr/src/generated/report.json'), 'utf8'));
  const herdrPinned = {
    version: pins.herdr,
    protocol: pins.herdrProtocol,
    methods: null, // counts only; the committed snapshot is the source of truth
    events: null,
    methodCount: herdrReport.methods,
    eventCount: herdrReport.events,
  };
  let herdrLatest = { version: manifest.version, protocol: manifest.protocol, methods: null, events: null };
  const schemaDoc = manifest.version !== pins.herdr || manifest.protocol !== pins.herdrProtocol
    ? herdrSchemaDoc(manifest)
    : null;
  if (schemaDoc) herdrLatest = schemaDoc;

  return { pins, ocPinned, ocStable: ocStableFull, ocLatest: ocLatestFull, herdrPinned, herdrLatest };
}

// --- report ---------------------------------------------------------------

function countOf(doc) {
  if (doc.methods) return doc.methods.length;
  return doc.methodCount ?? 0;
}

function buildReport(d) {
  const toLatest = summarizePair('latest', d.ocPinned, d.ocLatest);
  const toStable = summarizePair('extended-stable', d.ocPinned, d.ocStable);
  const herdrDrift = d.herdrLatest.version !== d.herdrPinned.version
    || d.herdrLatest.protocol !== d.herdrPinned.protocol;
  let herdrDiff = null;
  if (herdrDrift && d.herdrLatest.methods && d.herdrPinned.methods) {
    herdrDiff = {
      methods: diffLists(d.herdrPinned.methods, d.herdrLatest.methods),
      events: diffLists(d.herdrPinned.events ?? [], d.herdrLatest.events ?? []),
    };
  }
  const drift = toLatest.methods.added.length > 0 || toLatest.methods.removed.length > 0
    || (toLatest.events !== null && (toLatest.events.added.length > 0 || toLatest.events.removed.length > 0))
    || toStable.methods.added.length > 0 || toStable.methods.removed.length > 0
    || herdrDrift;
  return {
    pins: d.pins,
    openclaw: { pin: d.ocPinned.version, latest: d.ocLatest.version, extendedStable: d.ocStable.version, toLatest, toStable },
    herdr: {
      pin: d.herdrPinned.version,
      pinProtocol: d.herdrPinned.protocol ?? d.pins.herdrProtocol,
      latest: d.herdrLatest.version,
      latestProtocol: d.herdrLatest.protocol,
      pinnedMethods: countOf(d.herdrPinned),
      pinnedEvents: d.herdrPinned.events?.length ?? d.herdrPinned.eventCount ?? 0,
      latestMethods: d.herdrLatest.methods?.length ?? null,
      latestEvents: d.herdrLatest.events?.length ?? null,
      diff: herdrDiff,
      drift: herdrDrift,
    },
    drift,
  };
}

function fmtCount(from, to, added, removed) {
  return `+${added}/-${removed} (${from} -> ${to})`;
}

function renderSummary(r) {
  const lines = [];
  const t = r.openclaw.toLatest;
  lines.push(`openclaw pin ${t.from} -> latest ${t.to}: methods ${fmtCount(t.methods.from, t.methods.to, t.methods.added.length, t.methods.removed.length)}`
    + (t.events ? `, events ${fmtCount(t.events.from, t.events.to, t.events.added.length, t.events.removed.length)}` : ', events: n/a'));
  if (t.methods.removed.length) lines.push(`  removed methods: ${t.methods.removed.join(', ')}`);
  const s = r.openclaw.toStable;
  lines.push(`openclaw pin ${s.from} -> extended-stable ${s.to}: methods ${fmtCount(s.methods.from, s.methods.to, s.methods.added.length, s.methods.removed.length)}`);
  if (s.methods.added.length) lines.push(`  added methods: ${s.methods.added.join(', ')}`);
  const h = r.herdr;
  if (h.drift) {
    lines.push(`herdr pin ${h.pin} (protocol ${h.pinProtocol}) -> latest ${h.latest} (protocol ${h.latestProtocol}): DRIFT`);
    if (h.diff) {
      lines.push(`  methods +${h.diff.methods.added.length}/-${h.diff.methods.removed.length}, events +${h.diff.events.added.length}/-${h.diff.events.removed.length}`);
    } else {
      lines.push(`  schema diff unavailable (asset fetch or verify failed); regenerate from the release asset's api schema output`);
    }
  } else {
    lines.push(`herdr pin ${h.pin} (protocol ${h.pinProtocol}): up to date with latest.json`);
  }
  lines.push(`drift: ${r.drift ? 'yes' : 'no'}`);
  return lines.join('\n');
}

function renderIssueBody(r) {
  const t = r.openclaw.toLatest;
  const s = r.openclaw.toStable;
  const h = r.herdr;
  const list = (items) => items.length ? items.map((m) => `- \`${m}\``).join('\n') : '_none_';
  let body = `<!-- byk-pin-watch: upstream pin drift report. Updated by the weekly watch workflow; do not edit by hand. -->\n`
    + `# Upstream pin drift\n\n`
    + `Engine pin \`${t.from}\` vs \`latest\` \`${t.to}\` and \`extended-stable\` \`${s.to}\`; `
    + `companion-app pin \`${h.pin}\` (protocol ${h.pinProtocol}) vs latest \`${h.latest}\` (protocol ${h.latestProtocol}).\n\n`
    + `## Engine: ${t.from} -> ${t.to} (latest)\n\n`
    + `Methods ${fmtCount(t.methods.from, t.methods.to, t.methods.added.length, t.methods.removed.length)}`;
  body += t.events
    ? `, events ${fmtCount(t.events.from, t.events.to, t.events.added.length, t.events.removed.length)}.\n`
    : `, events not compared for this channel.\n`;
  body += `\n### Added methods (${t.methods.added.length})\n\n${list(t.methods.added)}\n\n### Removed methods (${t.methods.removed.length})\n\n${list(t.methods.removed)}\n`;
  if (t.events && (t.events.added.length || t.events.removed.length)) {
    body += `\n### Added events (${t.events.added.length})\n\n${list(t.events.added)}\n\n### Removed events (${t.events.removed.length})\n\n${list(t.events.removed)}\n`;
  }
  body += `\n## Engine: ${s.from} -> ${s.to} (extended-stable)\n\n`
    + `Methods ${fmtCount(s.methods.from, s.methods.to, s.methods.added.length, s.methods.removed.length)}.\n`
    + `\n### Added methods (${s.methods.added.length})\n\n${list(s.methods.added)}\n\n### Removed methods (${s.methods.removed.length})\n\n${list(s.methods.removed)}\n`;
  body += `\n## Companion app: ${h.pin} -> ${h.latest}\n\n`;
  if (!h.drift) {
    body += `Pin is current (${h.pinnedMethods} methods, ${h.pinnedEvents} events).\n`;
  } else if (h.diff) {
    body += `Methods +${h.diff.methods.added.length}/-${h.diff.methods.removed.length}, events +${h.diff.events.added.length}/-${h.diff.events.removed.length} `
      + `(from the new release asset's \`api schema\` output, sha256-verified against the release manifest).\n`
      + `\n### Added methods (${h.diff.methods.added.length})\n\n${list(h.diff.methods.added)}\n`
      + `\n### Removed methods (${h.diff.methods.removed.length})\n\n${list(h.diff.methods.removed)}\n`;
  } else {
    body += `Version/protocol drift, but the new schema could not be fetched in CI. `
      + `Download the release asset, verify its sha256 against the manifest, run \`api schema\`, and diff against the pinned snapshot.\n`;
  }
  body += `\n---\nNext step is the pin-advance procedure, not this report: regenerate the typed surface, re-verify, and bump the pin.\n`;
  return body;
}

// --- main -----------------------------------------------------------------

let docs;
if (FIXTURES) {
  if (!existsSync(FIXTURES)) die(`fixtures dir not found: ${FIXTURES}`);
  const f = readFixtures(FIXTURES);
  docs = {
    pins: f.pins,
    ocPinned: f.ocPinned,
    ocStable: f.ocStable,
    ocLatest: f.ocLatest,
    herdrPinned: f.herdrPinned,
    herdrLatest: f.herdrLatest,
  };
} else {
  docs = liveDocs();
}
const report = buildReport(docs);
if (FORMAT === 'json') {
  console.log(JSON.stringify(report, null, 1));
} else if (FORMAT === 'issue-body') {
  console.log(renderIssueBody(report));
} else {
  console.log(renderSummary(report));
}
