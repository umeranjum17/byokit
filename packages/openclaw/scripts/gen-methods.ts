// O2 generator (docs/runtime-kits.md 5.10): builds src/generated/methods.ts, events.ts and report.json from the
// pinned openclaw@2026.8.1 tarball (npm pack + extract; network at generation time only) and the installed
// @openclaw/gateway-protocol types. Run with `npm run gen:openclaw`. Output is committed and deterministic
// (sorted); it is never hand-edited. Environment: explicit env only, a throwaway HOME and npm cache (D13) —
// the person's ~, credentials and caches are never touched.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
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
// An interrupted generation (SIGINT/SIGTERM) must not leave the tarball behind:
// the finally at the end covers success and failure, this covers abort.
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  rmSync(tmp, { recursive: true, force: true });
  process.removeAllListeners(signal);
  process.kill(process.pid, signal);
});
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

  // --- union patch-ups (Gap 6): protocol.schema.json is the authority for params shapes, but the
  // published .d.mts declarations drop properties from anyOf/oneOf branches (e.g. CronRunParams loses
  // mode and expectedProcessInstanceId, so kit.call('cron.run', { id, mode: 'force' }) fails tsc while
  // the gateway accepts it). Every matched type whose schema carries a top-level anyOf/oneOf is
  // re-emitted locally into src/generated/params.ts with each branch's full property set: a branch keeps
  // its own properties plus the properties declared beside the union on the parent schema, and required
  // is the union of the parent and branch required lists. Presence-exclusions (`not: {required: [...]}`,
  // possibly nested under anyOf/oneOf) spell as `prop?: never`, so oneOf discrimination survives; any
  // other `not` shape fails loudly below. Validation-only keywords (lengths, ranges, formats,
  // additionalProperties) are not spelled, as with the protocol's own types. A future pin shape outside
  // this subset fails loudly here, never silently.
  type Schema = Record<string, any>;
  const isSchema = (o: unknown): o is Schema => typeof o === 'object' && o !== null && !Array.isArray(o);

  const protocolEntry = require.resolve('@openclaw/gateway-protocol');
  let protocolDir = dirname(protocolEntry);
  for (let i = 0; i < 5 && !existsSync(join(protocolDir, 'protocol.schema.json')); i++) protocolDir = dirname(protocolDir);
  const schemaPath = join(protocolDir, 'protocol.schema.json');
  if (!existsSync(schemaPath)) die(`protocol.schema.json not found above ${protocolEntry}`);
  const definitions = (JSON.parse(readFileSync(schemaPath, 'utf8')) as { definitions?: Record<string, Schema> }).definitions ?? {};

  const tsLiteral = (v: unknown): string => {
    if (typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (v === null) return 'null';
    die(`unsupported literal in protocol.schema.json: ${JSON.stringify(v)}`);
  };
  const quoteKey = (k: string): string => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k));

  interface Frag { text: string; union: boolean }
  const prim = (t: string): Frag => ({ text: t, union: false });

  function objectToTs(props: Schema, required: Set<string>, neverProps: Set<string>, indexSig: Frag | null, indent: string, where: string): Frag {
    const pad = indent + '  ';
    const lines = Object.keys(props).map((k) => {
      if (neverProps.has(k)) return `${pad}${quoteKey(k)}?: never;`;
      const t = schemaToTs(props[k], pad, `${where}.${k}`);
      return `${pad}${quoteKey(k)}${required.has(k) ? '' : '?'}: ${t.text};`;
    });
    if (indexSig) lines.push(`${pad}[k: string]: ${indexSig.text};`);
    if (lines.length === 0) die(`object with no properties and no index signature at ${where}`);
    return { text: `{\n${lines.join('\n')}\n${indent}}`, union: false };
  }

  function indexSigOf(s: Schema, where: string): Frag | null {
    const pats = isSchema(s.patternProperties) ? Object.keys(s.patternProperties) : [];
    const extra = 'additionalProperties' in s && isSchema(s.additionalProperties) ? [s.additionalProperties] : [];
    const values: Frag[] = [
      ...pats.map((p) => schemaToTs((s.patternProperties as Schema)[p], '', `${where}[${p}]`)),
      ...extra.map((v) => schemaToTs(v, '', `${where}#additional`)),
    ];
    if (values.length === 0) return null;
    const seen = [...new Set(values.map((v) => v.text))].sort();
    return { text: seen.length === 1 ? seen[0]! : `(${seen.join(' | ')})`, union: seen.length > 1 };
  }

  // Presence-exclusions from `not: {required: [...]}` or `not: {anyOf/oneOf: [{required: [...]},
  // ...]}` spell as `prop?: never` in TS. Any other `not` shape fails loudly (see schemaToTs).
  const NOT_ANNOTATIONS = new Set(['description', 'title', 'default', 'deprecated', 'examples', 'readOnly', 'writeOnly']);
  function forbiddenProps(node: Schema, where: string): Set<string> {
    const out = new Set<string>();
    const n = node.not;
    if (n === undefined) return out;
    if (!isSchema(n)) die(`unsupported 'not' at ${where}`);
    if ((n.anyOf !== undefined && !Array.isArray(n.anyOf)) || (n.oneOf !== undefined && !Array.isArray(n.oneOf))) {
      die(`non-array union in 'not' at ${where}`);
    }
    const subs: unknown[] = Array.isArray(n.anyOf) ? n.anyOf : Array.isArray(n.oneOf) ? n.oneOf : [n];
    for (const sub of subs) {
      if (!isSchema(sub)) die(`unsupported 'not' branch at ${where}`);
      const keys = Object.keys(sub).filter((k) => !NOT_ANNOTATIONS.has(k));
      if (keys.length !== 1 || keys[0] !== 'required' || !Array.isArray(sub.required)) die(`unsupported 'not' shape at ${where}`);
      for (const r of sub.required as unknown[]) {
        if (typeof r !== 'string') die(`non-string required in 'not' at ${where}`);
        out.add(r);
      }
    }
    const topKeys = Object.keys(n).filter((k) => !NOT_ANNOTATIONS.has(k) && k !== 'anyOf' && k !== 'oneOf' && k !== 'required');
    if (topKeys.length > 0) die(`unsupported 'not' shape at ${where}`);
    return out;
  }

  function branchIsObject(b: Schema): boolean {
    // A branch beside parent properties takes the parent's object shape unless it is definitely not
    // an object: a literal, a nested union (ambiguous: which level do the parent properties join?), or
    // a scalar/array type. Bare constraint nodes ({required}, {not}, {}) inherit the parent shape.
    if (b.const !== undefined || b.enum !== undefined) return false;
    if (Array.isArray(b.anyOf) || Array.isArray(b.oneOf)) return false;
    if (typeof b.type === 'string') return b.type === 'object';
    if (Array.isArray(b.type)) return (b.type as unknown[]).includes('object');
    return true;
  }

  function schemaToTs(s: unknown, indent: string, where: string): Frag {
    if (s === true) return prim('unknown');
    if (s === false) return prim('never');
    if (!isSchema(s)) die(`unsupported schema at ${where}`);
    if (s.const !== undefined) return prim(tsLiteral(s.const));
    if (Array.isArray(s.enum)) {
      if (s.enum.length === 0) die(`empty enum at ${where}`);
      return { text: s.enum.length === 1 ? tsLiteral(s.enum[0]) : `(${s.enum.map(tsLiteral).join(' | ')})`, union: s.enum.length > 1 };
    }
    const union = Array.isArray(s.anyOf) ? s.anyOf as unknown[] : Array.isArray(s.oneOf) ? s.oneOf as unknown[] : null;
    if (s.anyOf !== undefined && !Array.isArray(s.anyOf)) die(`non-array anyOf at ${where}`);
    if (s.oneOf !== undefined && !Array.isArray(s.oneOf)) die(`non-array oneOf at ${where}`);
    const parentProps: Schema = isSchema(s.properties) ? s.properties as Schema : {};
    const parentRequired: string[] = Array.isArray(s.required) ? (s.required as unknown[]).filter((r): r is string => typeof r === 'string') : [];
    if (union !== null) {
      if (s.not !== undefined) die(`union-level 'not' at ${where}`);
      const members = union.map((b, i) => {
        const branch: Schema = isSchema(b) ? b : die(`non-object union branch at ${where}[${i}]`);
        if (Object.keys(parentProps).length > 0 || parentRequired.length > 0) {
          if (!branchIsObject(branch)) die(`union branch beside parent properties is not an object at ${where}[${i}]`);
          const props: Schema = { ...parentProps, ...(isSchema(branch.properties) ? branch.properties as Schema : {}) };
          const branchRequired: string[] = Array.isArray(branch.required)
            ? (branch.required as unknown[]).filter((r): r is string => typeof r === 'string')
            : [];
          const required = new Set([...parentRequired, ...branchRequired].filter((r) => r in props));
          const forbidden = forbiddenProps(branch, `${where}[${i}]`);
          const clash = [...forbidden].filter((f) => required.has(f));
          if (clash.length > 0) die(`'not' forbids required properties (${clash.join(', ')}) at ${where}[${i}]`);
          const unknown = [...forbidden].filter((f) => !(f in props));
          if (unknown.length > 0) die(`'not' forbids unknown properties (${unknown.join(', ')}) at ${where}[${i}]`);
          const merged: Schema = {
            patternProperties: branch.patternProperties ?? s.patternProperties,
            additionalProperties: branch.additionalProperties ?? s.additionalProperties,
          };
          return objectToTs(props, required, forbidden, indexSigOf(merged, `${where}[${i}]`), indent, `${where}[${i}]`);
        }
        if (branch.not !== undefined) die(`branch-level 'not' without parent properties at ${where}[${i}]`);
        return schemaToTs(branch, indent, `${where}[${i}]`);
      });
      const flat: string[] = [];
      for (const m of members) flat.push(m.text);
      return { text: flat.length === 1 ? flat[0]! : flat.join(' | '), union: flat.length > 1 };
    }
    if (s.not !== undefined) die(`unsupported 'not' at ${where}`);
    if (s.properties !== undefined || s.patternProperties !== undefined || s.type === 'object') {
      const props: Schema = isSchema(s.properties) ? s.properties as Schema : {};
      const required = new Set(parentRequired.filter((r) => r in props));
      if (Object.keys(props).length === 0) {
        const sig = indexSigOf(s, where);
        if (sig) return { text: `Record<string, ${sig.union ? `(${sig.text})` : sig.text}>`, union: false };
        return prim('Record<string, unknown>');
      }
      const sig = indexSigOf(s, where);
      return objectToTs(props, required, new Set(), sig, indent, where);
    }
    const types: string[] = Array.isArray(s.type) ? s.type as string[] : typeof s.type === 'string' ? [s.type] : [];
    if (types.length > 0) {
      const frags = types.map((t): Frag => {
        switch (t) {
          case 'string': return prim('string');
          case 'integer':
          case 'number': return prim('number');
          case 'boolean': return prim('boolean');
          case 'null': return prim('null');
          case 'array': {
            const items = (s as Schema).items;
            if (Array.isArray(items)) {
              const els = (items as unknown[]).map((el, i) => schemaToTs(el, indent, `${where}#${i}`).text);
              return prim(`[${els.join(', ')}]`);
            }
            const el = schemaToTs(isSchema(items) || Array.isArray(items) ? items : true, indent, `${where}[]`);
            return { text: el.union ? `(${el.text})[]` : `${el.text}[]`, union: false };
          }
          case 'object': return prim('Record<string, unknown>'); // properties-bearing objects are handled above
          default: die(`unsupported type '${t}' at ${where}`);
        }
      });
      return { text: frags.length === 1 ? frags[0]!.text : frags.map((f) => f.text).join(' | '), union: frags.length > 1 };
    }
    if (s.anyOf !== undefined || s.oneOf !== undefined) die(`non-array union at ${where}`);
    for (const k of ['allOf', '$ref', 'if', 'then', 'else', 'contains', 'prefixItems', 'propertyNames', 'dependentRequired']) {
      if (s[k] !== undefined) die(`unsupported keyword '${k}' at ${where}`);
    }
    return prim('unknown'); // annotation-only nodes (description, default, ...) carry no type
  }

  const needsPatch = (name: string): boolean => {
    const d = definitions[name];
    return isSchema(d) && (Array.isArray(d.anyOf) || Array.isArray(d.oneOf));
  };

  // --- emit ---

  const header = `// Generated by scripts/gen-methods.ts from the pinned openclaw@${ENGINE_VERSION} tarball (docs/runtime-kits.md 5.10). Regenerated with \`npm run gen:openclaw\`, never hand-edited.`;
  const importedTypes = [...new Set([...entries.flatMap((e) => [e.params, e.result]), ...eventEntries.map((e) => e.payload)])].filter((x): x is string => x !== null).sort();
  const patchedTypes = importedTypes.filter(needsPatch);
  const patched = new Set(patchedTypes);
  const protocolTypes = importedTypes.filter((n) => !patched.has(n));
  const eventPayloads = eventEntries.map((e) => e.payload).filter((x): x is string => x !== null).sort();
  const paramsHeader = `${header}\n// Union patch-ups (Gap 6): these mirror the protocol.schema.json definitions of the same\n// name, with every anyOf/oneOf branch carrying its full property set (see the generator). The\n// gateway validates against the same schemas, so the kit accepts exactly what the gateway accepts.`;

  const paramsTs = [
    paramsHeader,
    '',
    ...patchedTypes.map((n) => `export type ${n} = ${schemaToTs(definitions[n], '', n).text};`),
    '',
  ].join('\n');

  const methodsImports = [
    protocolTypes.length > 0 ? `import type { ${protocolTypes.join(', ')} } from '@openclaw/gateway-protocol';` : null,
    patchedTypes.length > 0 ? `import type { ${patchedTypes.join(', ')} } from './params.ts';` : null,
  ].filter((l): l is string => l !== null);

  const entryLine = (e: Entry): string =>
    `  '${e.name}': { params: ${e.params ?? 'unknown'}; result: ${e.result ?? 'unknown'}; scope: '${e.scope}'; role: '${e.role}' };`;

  const methodsTs = [
    header,
    ...methodsImports,
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

  const eventsImports = [
    eventPayloads.filter((n) => !patched.has(n)).length > 0 ? `import type { ${eventPayloads.filter((n) => !patched.has(n)).join(', ')} } from '@openclaw/gateway-protocol';` : null,
    eventPayloads.filter((n) => patched.has(n)).length > 0 ? `import type { ${eventPayloads.filter((n) => patched.has(n)).join(', ')} } from './params.ts';` : null,
  ].filter((l): l is string => l !== null);

  const eventsTs = [
    header,
    ...eventsImports,
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
    patchedTypes,
    unmatched,
  };

  const generatedDir = join(pkgDir, 'src', 'generated');
  mkdirSync(generatedDir, { recursive: true });
  writeFileSync(join(generatedDir, 'methods.ts'), methodsTs);
  writeFileSync(join(generatedDir, 'events.ts'), eventsTs);
  writeFileSync(join(generatedDir, 'params.ts'), paramsTs);
  writeFileSync(join(generatedDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');

  console.log(`methods: ${entries.length} (${operator.length} operator, ${node.length} node), events: ${eventEntries.length}`);
  console.log(`matched params: ${report.matchedParams}, results: ${report.matchedResults}, event payloads: ${report.matchedEvents}`);
  console.log(`patched union types: ${patchedTypes.length}${patchedTypes.length > 0 ? ` (${patchedTypes.join(', ')})` : ''}`);
  console.log(`wrote ${relative(repoDir, join(generatedDir, 'methods.ts'))}, events.ts, params.ts, report.json`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
