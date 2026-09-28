// O2 generator (docs/runtime-kits.md 5.10): builds src/generated/methods.ts, events.ts and report.json from the
// pinned openclaw@2026.8.1 tarball (npm pack + extract; network at generation time only) and the installed
// @openclaw/gateway-protocol types. Run with `npm run gen:openclaw`. Output is committed and deterministic
// (sorted); it is never hand-edited. Environment: explicit env only, a throwaway HOME and npm cache (D13) —
// the person's ~, credentials and caches are never touched.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';

const ENGINE_VERSION = '2026.8.1';
const PROTOCOL_VERSION = 4;
const PACKAGE = 'openclaw';

const scriptDir = dirname(new URL(import.meta.url).pathname);
const pkgDir = dirname(scriptDir); // packages/openclaw
const repoDir = dirname(dirname(pkgDir));

function die(message: string): never {
  console.error(`gen-methods: ${message}`);
  process.exit(1);
}

// --- tarball fetch + extract (isolated HOME and npm cache) ---

const tmp = mkdtempSync(join(tmpdir(), 'byokit-gen-'));
try {
  const pack = spawnSync('npm', ['pack', `${PACKAGE}@${ENGINE_VERSION}`, '--pack-destination', tmp], {
    cwd: tmp,
    env: { PATH: process.env.PATH ?? '', HOME: tmp, npm_config_cache: join(tmp, 'npm-cache') },
    encoding: 'utf8',
  });
  if (pack.status !== 0) die(`npm pack ${PACKAGE}@${ENGINE_VERSION} failed: ${pack.stderr}`);
  const tgz = readdirSync(tmp).find((f) => f.endsWith('.tgz'));
  if (!tgz) die('npm pack produced no tarball');
  const untar = spawnSync('tar', ['-xzf', join(tmp, tgz), '-C', tmp], { encoding: 'utf8' });
  if (untar.status !== 0) die(`tar extract failed: ${untar.stderr}`);
  const distDir = join(tmp, 'package', 'dist');

  // --- locate the spec lists by content (hashed file names change per release, 3.1) ---

  const jsFiles: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.js')) jsFiles.push(p);
    }
  };
  walk(distDir);

  // Extract the array literal following a `const NAME = [` marker, skipping string contents so brackets inside
  // strings cannot unbalance the depth count. Only the literal is taken; the module is never imported or run.
  function arrayLiteralAfter(src: string, marker: string): string {
    const at = src.indexOf(marker);
    if (at < 0) die(`marker not found in tarball: ${marker}`);
    const open = src.indexOf('[', at); // the marker itself ends with '[', so this finds its bracket
    let depth = 0;
    let inString: string | null = null;
    for (let i = open; i < src.length; i++) {
      const c = src[i]!;
      if (inString) {
        if (c === '\\') i++;
        else if (c === inString) inString = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') inString = c;
      else if (c === '[') depth++;
      else if (c === ']') {
        depth--;
        if (depth === 0) return src.slice(open, i + 1);
      }
    }
    die(`unterminated array for ${marker}`);
  }

  function readDist(name: string): string {
    const file = jsFiles.find((f) => {
      const src = readFileSync(f, 'utf8');
      return src.includes(name);
    });
    if (!file) die(`no dist file contains ${name}`);
    return readFileSync(file, 'utf8');
  }

  const coreList = eval(arrayLiteralAfter(readDist('const CORE_GATEWAY_METHOD_SPEC_LIST = ['), 'const CORE_GATEWAY_METHOD_SPEC_LIST = [')) as unknown[][];
  const auxMethods = eval(arrayLiteralAfter(readDist('const GATEWAY_AUX_METHODS = ['), 'const GATEWAY_AUX_METHODS = [')) as string[];
  const eventsSrc = readDist('const GATEWAY_EVENTS = [');
  let eventsLiteral = arrayLiteralAfter(eventsSrc, 'const GATEWAY_EVENTS = [');
  // Named constants (e.g. GATEWAY_EVENT_UPDATE_AVAILABLE) resolve from their `const X = "…"` definitions (5.10).
  for (const m of new Set(eventsLiteral.match(/(?<![\w.'"`])[A-Z][A-Z0-9_]+(?![\w.'"`])/g) ?? [])) {
    const def = jsFiles.map((f) => readFileSync(f, 'utf8')).find((src) => src.includes(`const ${m} = "`));
    const edge = "'`\""; // chars that end a token: single quote, backtick, double quote
    eventsLiteral = eventsLiteral.replace(new RegExp("(?<![\\w" + edge + "])" + m + "(?![\\w" + edge + "])", "g"), JSON.stringify(def.match(new RegExp(`const ${m} = "(.*)"`))[1]!));
  }
  const eventNames = eval(eventsLiteral) as string[];

  // --- methods ---

  const aux = new Set(auxMethods);
  const missing = auxMethods.filter((m) => !coreList.some((e) => e[0] === m));
  if (missing.length) die(`aux methods missing from the core list: ${missing.join(', ')}`);
  if (aux.size !== auxMethods.length) die('duplicate aux methods');

  interface Row {
    name: string;
    group: string | null;
    scope: string;
    role: 'operator' | 'node';
  }
  const rows: Row[] = coreList.map((e) => {
    const [name, group, scope] = e as [string, string | null, string];
    if (typeof name !== 'string' || typeof scope !== 'string') die(`malformed core entry for ${String(name)}`);
    return { name, group, scope, role: scope === 'node' ? 'node' : 'operator' };
  });
  const names = rows.map((r) => r.name);
  if (new Set(names).size !== names.length) die('duplicate methods in the core list');

  const pascal = (s: string): string =>
    s.split(/[._-]+/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join('');

  // Overrides (scripts/method-types.json): mechanical finds from searching exported names for methods the
  // Pascal rules miss — singular/plural spellings and the SystemAgent setup family. Verified against the
  // pinned tarball's own handler validators while filling the map (5.10, "fill mechanically").
  const overrides = JSON.parse(readFileSync(join(scriptDir, 'method-types.json'), 'utf8')) as Record<string, { params?: string; result?: string }>;

  function ruleBases(row: Row): string[] {
    const candidates = [pascal(row.name)];
    if (row.group) candidates.push(pascal(row.group) + pascal(row.name.split('.').at(-1)!));
    return [...new Set(candidates)];
  }

  // Overrides carry full exported type names; the Pascal rules produce bases that take the suffix.
  function overrideName(row: Row, slot: 'params' | 'result'): string | null {
    const o = overrides[row.name]?.[slot];
    return typeof o === 'string' ? o : null;
  }

  // --- probe compile: accept only names the installed @openclaw/gateway-protocol really exports as types ---

  const require = createRequire(import.meta.url);
  const tsc = require.resolve('typescript/bin/tsc');

  function compileProbe(candidateNames: string[]): Set<string> {
    // Returns the subset that compile as type exports; named members are tried in one probe file and the
    // "has no exported member" errors are removed (then re-checked) until the probe is clean.
    let live = [...new Set(candidateNames)];
    const probeDir = join(pkgDir, '.gen-probe');
    mkdirSync(probeDir, { recursive: true });
    const probeFile = join(probeDir, 'probe.ts');
    try {
      for (let round = 0; round < 5 && live.length > 0; round++) {
        writeFileSync(
          probeFile,
          `import type { ${live.join(', ')} } from '@openclaw/gateway-protocol';\nexport type Probe = [${live.join(', ')}];\n`,
        );
        const run = spawnSync(process.execPath, [tsc, '--noEmit', '--skipLibCheck', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--target', 'es2022', probeFile], {
          cwd: pkgDir, // node_modules resolution from the package, never from the throwaway dir
          encoding: 'utf8',
        });
        if (run.status === 0) return new Set(live);
        const dropped = new Set<string>();
        for (const m of (run.stdout + run.stderr).matchAll(/has no exported member (?:named )?'([^']+)'/g)) dropped.add(m[1]!);
        for (const m of (run.stdout + run.stderr).matchAll(/'(?:[^']+)'.*'([^']+)' cannot be used as a value/g)) dropped.add(m[1]!);
        if (dropped.size === 0) die(`probe compile failed for a non-export reason:\n${run.stdout}${run.stderr}`);
        live = live.filter((n) => !dropped.has(n));
      }
      return new Set(live);
    } finally {
      rmSync(probeDir, { recursive: true, force: true });
    }
  }

  const exported = compileProbe([
    ...new Set(rows.flatMap((r) => ruleBases(r).flatMap((b) => [`${b}Params`, `${b}Result`]))),
    ...new Set(rows.flatMap((r) => [overrideName(r, 'params'), overrideName(r, 'result')]).filter((x): x is string => x !== null)),
    ...new Set(eventNames.map((e) => `${pascal(e)}Event`)),
  ]);

  function matchSlot(row: Row, slot: 'params' | 'result'): string | null {
    const overridden = overrideName(row, slot);
    if (overridden && exported.has(overridden)) return overridden;
    for (const base of ruleBases(row)) {
      const name = base + (slot === 'params' ? 'Params' : 'Result');
      if (exported.has(name)) return name;
    }
    return null;
  }

  interface Entry {
    name: string;
    params: string | null;
    result: string | null;
    scope: string;
    role: 'operator' | 'node';
  }
  const entries: Entry[] = rows.map((r) => ({
    name: r.name,
    params: matchSlot(r, 'params'),
    result: matchSlot(r, 'result'),
    scope: r.scope,
    role: r.role,
  }));
  const operator = entries.filter((e) => e.role === 'operator').sort((a, b) => (a.name < b.name ? -1 : 1));
  const node = entries.filter((e) => e.role === 'node').sort((a, b) => (a.name < b.name ? -1 : 1));

  interface EventEntry {
    name: string;
    payload: string | null;
  }
  const eventEntries: EventEntry[] = [...new Set(eventNames)]
    .sort((a, b) => (a < b ? -1 : 1))
    .map((name) => {
      const override = overrides[name]?.params; // events use the same override file; `params` holds the payload type
      const base = override ?? `${pascal(name)}Event`;
      const matched = exported.has(base) ? base : override && exported.has(override) ? override : null;
      return { name, payload: matched };
    });

  // --- emit ---

  const header = `// Generated by scripts/gen-methods.ts from the pinned openclaw@${ENGINE_VERSION} tarball (docs/runtime-kits.md 5.10). Regenerated with \`npm run gen:openclaw\`, never hand-edited.`;
  const importedTypes = [...new Set([...entries.flatMap((e) => [e.params, e.result]), ...eventEntries.map((e) => e.payload)])].filter((x): x is string => x !== null).sort();

  const entryLine = (e: Entry): string =>
    `  '${e.name}': { params: ${e.params ?? 'unknown'}; result: ${e.result ?? 'unknown'}; scope: '${e.scope}'; role: '${e.role}' };`;

  const methodsTs = [
    header,
    `import type { ${importedTypes.join(', ')} } from '@openclaw/gateway-protocol';`,
    '',
    'export interface GatewayMethods {',
    ...operator.map(entryLine),
    '}',
    '',
    `// The node protocol's methods (D6): listed with role 'node', never part of GatewayMethod, so typed \`call\``,
    '// cannot send them; they are the other side of the node connection.',
    'export interface GatewayNodeMethods {',
    ...node.map(entryLine),
    '}',
    '',
    'export type GatewayMethod = keyof GatewayMethods;',
    'export type GatewayNodeMethod = keyof GatewayNodeMethods;',
    'export type GatewayParams<M extends GatewayMethod> = GatewayMethods[M][\'params\'];',
    'export type GatewayResult<M extends GatewayMethod> = GatewayMethods[M][\'result\'];',
    '',
  ].join('\n');

  const eventsTs = [
    header,
    `import type { ${eventEntries.map((e) => e.payload).filter((x): x is string => x !== null).sort().join(', ')} } from '@openclaw/gateway-protocol';`,
    '',
    'export interface GatewayEvents {',
    ...eventEntries.map((e) => `  '${e.name}': ${e.payload ?? 'unknown'};`),
    '}',
    '',
    'export type GatewayEventName = keyof GatewayEvents;',
    'export type GatewayEventPayload<E extends GatewayEventName> = GatewayEvents[E];',
    '',
  ].join('\n');

  const unmatched = [
    ...entries.flatMap((e) => [
      ...e.params ? [] : [{ method: e.name, slot: 'params' }],
      ...e.result ? [] : [{ method: e.name, slot: 'result' }],
    ]),
    ...eventEntries.filter((e) => e.payload === null).map((e) => ({ event: e.name, slot: 'payload' })),
  ].sort((a, b) => ('method' in a ? a.method : a.event).localeCompare('method' in b ? b.method : b.event));

  const report = {
    engine: ENGINE_VERSION,
    protocol: PROTOCOL_VERSION,
    package: PACKAGE,
    methods: entries.length,
    operatorMethods: operator.length,
    nodeMethods: node.length,
    events: eventEntries.length,
    matchedParams: entries.filter((e) => e.params).length,
    matchedResults: entries.filter((e) => e.result).length,
    matchedEvents: eventEntries.filter((e) => e.payload).length,
    unmatched,
  };

  const generatedDir = join(pkgDir, 'src', 'generated');
  mkdirSync(generatedDir, { recursive: true });
  writeFileSync(join(generatedDir, 'methods.ts'), methodsTs);
  writeFileSync(join(generatedDir, 'events.ts'), eventsTs);
  writeFileSync(join(generatedDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');

  console.log(`methods: ${entries.length} (${operator.length} operator, ${node.length} node), events: ${eventEntries.length}`);
  console.log(`matched params: ${report.matchedParams}, results: ${report.matchedResults}, event payloads: ${report.matchedEvents}`);
  console.log(`wrote ${relative(repoDir, join(generatedDir, 'methods.ts'))}, events.ts, report.json`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
