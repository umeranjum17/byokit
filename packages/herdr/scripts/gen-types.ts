// Generate the pinned Herdr typed surface (docs/runtime-kits.md 6.7, work package H2).
//
// Input:  schema/herdr-api-0.9.1.json — captured from `herdr api schema` of the
//         v0.9.1 release (provenance in schema/SOURCE.md).
// Output: src/generated/methods.ts, src/generated/events.ts, src/generated/report.json.
//
// Deterministic: same snapshot in, byte-identical files out. test/generated.test.ts
// regenerates and compares against the committed output. Run via `npm run gen:herdr`.
import { compile } from 'json-schema-to-typescript';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

type Json = { [k: string]: Json | string | number | boolean | null | Json[] } | Json[] | string | number | boolean | null;
type Schema = Record<string, unknown> & { $defs?: Record<string, Json> };

// Methods muxr calls (docs/runtime-kits.md 3.2); the H2 acceptance inventory.
export const MUXR_METHODS = [
  'pane.close', 'pane.get', 'pane.read', 'pane.split', 'pane.send_keys', 'pane.report_metadata',
  'pane.focus_direction', 'pane.focus', 'pane.zoom', 'pane.layout',
  'workspace.list', 'workspace.get', 'workspace.close', 'workspace.focus', 'workspace.create',
  'tab.get', 'tab.close', 'tab.list', 'tab.focus', 'tab.create',
  'plugin.list', 'plugin.log.list', 'plugin.action.invoke',
  'session.snapshot', 'layout.export', 'layout.apply',
  'agent.start', 'agent.prompt', 'agent.send_keys', 'agent.wait',
  'worktree.create', 'server.agent_manifests', 'events.subscribe', 'ping',
];

// Result types the snapshot's naming rules cannot derive mechanically. Every entry is
// anchored to a `type` const of the snapshot's ResponseResult union (validated below).
// provenance — probed: invoked against the isolated v0.9.1 lab server (schema/SOURCE.md);
// docs: herdr.dev/docs/socket-api; pattern: uniform across probed sibling methods.
const RESULT_OVERRIDES: Record<string, string> = {
  // docs
  ping: 'pong',
  'client.window_title.set': 'client_window_title',
  'client.window_title.clear': 'client_window_title',
  'server.agent_manifests': 'agent_manifest_status',
  'server.reload_agent_manifests': 'agent_manifest_reload',
  'server.reload_config': 'config_reload',
  'agent.view.set': 'agent_view',
  'agent.view.clear': 'agent_view',
  // probed
  'workspace.get': 'workspace_info',
  'workspace.focus': 'workspace_info',
  'workspace.rename': 'workspace_info',
  'workspace.move': 'workspace_list',
  'workspace.move_block': 'workspace_list',
  'workspace.report_metadata': 'ok',
  'workspace.close': 'ok',
  'tab.get': 'tab_info',
  'tab.focus': 'tab_info',
  'tab.rename': 'tab_info',
  'tab.move': 'tab_list',
  'tab.close': 'ok',
  'pane.get': 'pane_info',
  'pane.focus': 'pane_info',
  'pane.rename': 'pane_info',
  'pane.scroll': 'pane_info',
  'pane.split': 'pane_info',
  'pane.report_metadata': 'ok',
  'pane.close': 'ok',
  'pane.send_text': 'ok',
  'pane.send_keys': 'ok',
  'pane.send_input': 'ok',
  'pane.input.set': 'ok',
  'pane.graphics.clear': 'ok',
  'pane.edit_scrollback': 'ok',
  'pane.clear_agent_authority': 'ok',
  'pane.release_agent': 'ok',
  'pane.report_agent': 'ok',
  'pane.report_agent_session': 'ok',
  'events.subscribe': 'subscription_started',
  'layout.set_split_ratio': 'layout_split_ratio_set',
  'events.wait': 'wait_matched',
  'pane.wait_for_output': 'output_matched',
  // pattern: every probed X.get / X.rename answers X_info (workspace, tab, pane)
  'agent.get': 'agent_info',
  'agent.rename': 'agent_info',
  // sibling result: events.wait probed wait_matched; agent.wait matches the same event shape
  'agent.wait': 'wait_matched',
};

const pascal = (s: string): string =>
  s.split('_').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('');

// Variant helpers: every oneOf variant is `{ properties: { <key>: { const: string, ... } }, required?: string[] }`.
const prop = (v: Schema, key: string): Record<string, unknown> =>
  ((v.properties ?? {}) as Record<string, Record<string, unknown>>)[key] ?? {};
const constOf = (v: Schema, key: string): string => String(prop(v, key).const ?? '');

// Merge the $defs of all five bundled schemas into one namespace. First definition wins a
// plain name; later conflicting ones get a per-schema prefix. Refs are rewritten in place.
function mergeDefs(snapshot: Schema): { defs: Record<string, Json>; resolve: (ref: string) => string } {
  const order = ['request', 'success_response', 'event', 'subscription_event', 'error_response'];
  const prefixFor: Record<string, string> = {
    request: '', success_response: 'Response', event: 'Event', subscription_event: 'Subscription', error_response: 'Error',
  };
  const defs: Record<string, Json> = {};
  const owner: Record<string, string> = {}; // finalName -> schema it came from
  const rename: Record<string, Record<string, string>> = {}; // schema -> def -> finalName
  for (const schemaName of order) {
    rename[schemaName] = {};
    for (const [defName, def] of Object.entries((snapshot.schemas as Record<string, Schema>)[schemaName].$defs ?? {})) {
      let final = defName;
      if (defName in defs) {
        if (JSON.stringify(defs[defName]) === JSON.stringify(def)) {
          // identical shape under the same name — one definition serves all schemas
        } else {
          final = `${prefixFor[schemaName]}${defName}`;
          if (final in defs) throw new Error(`generated name collision: ${final}`);
        }
      }
      defs[final] = def;
      rename[schemaName][defName] = final;
    }
  }
  const resolve = (ref: string): string => {
    const m = /^#\/schemas\/([a-z_]+)\/\$defs\/([A-Za-z]+)$/.exec(ref);
    if (!m) throw new Error(`unexpected ref: ${ref}`);
    const final = rename[m[1]]?.[m[2]];
    if (!final) throw new Error(`unresolved ref: ${ref}`);
    return final;
  };
  const rewrite = (node: Json): void => {
    if (Array.isArray(node)) { node.forEach(rewrite); return; }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (k === '$ref' && typeof v === 'string' && v.startsWith('#/schemas/')) (node as Record<string, unknown>)['$ref'] = `#/$defs/${resolve(v)}`;
        else rewrite(v as Json);
      }
    }
  };
  for (const def of Object.values(defs)) rewrite(def);
  return { defs, resolve };
}

export async function generate(snapshot: Schema): Promise<{ methodsTs: string; eventsTs: string; reportJson: string }> {
  const { defs, resolve } = mergeDefs(snapshot);
  const protocol = snapshot.protocol as number;
  const schemaVersion = snapshot.schema_version as number;

  const request = (snapshot.schemas as Record<string, Schema>).request;
  const variants = (request.oneOf as Schema[]).slice()
    .sort((a, b) => constOf(a, 'method').localeCompare(constOf(b, 'method')));
  const present = new Set(variants.map(v => constOf(v, 'method')));

  // --- result correspondence ------------------------------------------------------------
  const responseVariants = ((snapshot.schemas as Record<string, Schema>).success_response.$defs!.ResponseResult as Schema).oneOf as Schema[];
  const constSet = new Set<string>();
  const variantByConst = new Map<string, Schema>();
  for (const v of responseVariants) {
    const c = constOf(v, 'type');
    if (constSet.has(c)) throw new Error(`duplicate ResponseResult const: ${c}`);
    constSet.add(c);
    variantByConst.set(c, v);
  }
  const resultFor = (method: string): { name: string } | { unknown: true } => {
    const flat = method.replace(/\./g, '_');
    if (constSet.has(flat)) return { name: pascal(flat) + 'Response' };
    const prefixMatches = [...constSet].filter(c => c.startsWith(flat));
    if (prefixMatches.length === 1) return { name: pascal(prefixMatches[0]!) + 'Response' };
    // reverse: the result const is a prefix of the method (pane.selection.read → pane_selection)
    const revMatches = [...constSet].filter(c => flat.startsWith(c));
    if (revMatches.length === 1) return { name: pascal(revMatches[0]!) + 'Response' };
    const override = RESULT_OVERRIDES[method];
    if (override) {
      if (!constSet.has(override)) throw new Error(`override for ${method} names unknown const ${override}`);
      return { name: pascal(override) + 'Response' };
    }
    return { unknown: true };
  };
  const constNameOf = (method: string, resolved: { name: string }): string => {
    const flat = method.replace(/\./g, '_');
    if (constSet.has(flat)) return flat;
    const prefixMatches = [...constSet].filter(c => c.startsWith(flat));
    if (prefixMatches.length === 1) return prefixMatches[0]!;
    const revMatches = [...constSet].filter(c => flat.startsWith(c));
    if (revMatches.length === 1) return revMatches[0]!;
    return RESULT_OVERRIDES[method]!;
  };

  // --- methods.ts -----------------------------------------------------------------------
  const usedResultNames = new Map<string, string>(); // generated def name -> ResponseResult const
  const methodEntries = variants.map(v => {
    const method = constOf(v, 'method');
    const paramsRef = prop(v, 'params') as { $ref?: string };
    if (!paramsRef.$ref) throw new Error(`method without params ref: ${method}`);
    const paramsName = resolve(paramsRef.$ref);
    const result = resultFor(method);
    const resultType = 'unknown' in result ? 'unknown' : result.name;
    if (resultType !== 'unknown') usedResultNames.set(resultType, 'name' in result ? constNameOf(method, result) : '');
    return `  '${method}': { params: ${paramsName}; result: ${resultType} };`;
  }).sort();
  if (new Set(methodEntries).size !== methodEntries.length) throw new Error('duplicate method entries');

  // Materialize the matched ResponseResult variants as named defs (they are inline in the snapshot).
  const generatedDefs: Record<string, Json> = {};
  for (const [name, c] of [...usedResultNames].sort()) {
    const variant = variantByConst.get(c);
    if (!variant) throw new Error(`no ResponseResult variant for ${c}`);
    if (name in defs) throw new Error(`generated result name collision: ${name}`);
    generatedDefs[name] = variant as Json;
  }

  // --- events.ts ---------------------------------------------------------------- them
  const subscriptionVariants = ((request.$defs!.Subscription) as Schema).oneOf as Schema[];
  const eventVariants = (((snapshot.schemas as Record<string, Schema>).event.$defs!.EventData) as Schema).oneOf as Schema[];
  const eventDataByConst = new Map<string, Schema>();
  for (const v of eventVariants) eventDataByConst.set(constOf(v, 'type'), v);
  const subscriptionEventDefs = (snapshot.schemas as Record<string, Schema>).subscription_event.$defs!;

  interface EventRow { kind: string; payload: string; filterDef?: string }
  const eventRows: EventRow[] = [];
  for (const v of subscriptionVariants) {
    const kind = constOf(v, 'type');
    const flat = kind.replace(/\./g, '_');
    const filterProps = Object.keys((v.properties ?? {}) as Record<string, unknown>).filter(k => k !== 'type');
    let payload: string;
    let filterDef: string | undefined;
    // The three filtered kinds carry their payload in the bundled subscription_event schema;
    // every other kind maps to the underscore-named const of the event schema's EventData.
    const subDefName = pascal(flat) + 'Event';
    if (subscriptionEventDefs[subDefName]) {
      payload = subDefName;
    } else {
      const data = eventDataByConst.get(flat);
      if (!data) throw new Error(`no EventData variant for ${kind}`);
      payload = pascal(flat) + 'Data';
      if (payload in defs || payload in generatedDefs) throw new Error(`generated event name collision: ${payload}`);
      generatedDefs[payload] = data as Json;
    }
    if (filterProps.length > 0) {
      filterDef = pascal(flat) + 'Filter';
      if (filterDef in defs || filterDef in generatedDefs) throw new Error(`generated filter name collision: ${filterDef}`);
      const filterSchema = JSON.parse(JSON.stringify(v)) as Schema & { required?: string[] };
      delete (filterSchema.properties as Record<string, unknown>).type;
      filterSchema.required = (filterSchema.required ?? []).filter(k => k !== 'type');
      generatedDefs[filterDef] = filterSchema as Json;
    }
    eventRows.push({ kind, payload, filterDef });
  }
  eventRows.sort((a, b) => a.kind.localeCompare(b.kind));

  // --- compile --------------------------------------------------------------------------
  const compileDefs = async (roots: string[]): Promise<string> => {
    const out = await compile(
      { $schema: 'https://json-schema.org/draft/2020-12/schema', title: 'Root', $defs: { ...defs, ...generatedDefs }, oneOf: [...new Set(roots)].sort().map(r => ({ $ref: `#/$defs/${r}` })) } as never,
      'Root',
      { bannerComment: '' },
    );
    // Drop the root union alias jstt emits first; keep every def.
    const start = out.indexOf('export ');
    const firstStatement = out.slice(start, out.indexOf(';\n', start) + 2);
    if (!firstStatement.startsWith('export type Root =')) throw new Error(`unexpected jstt head: ${firstStatement.slice(0, 60)}`);
    return out.slice(0, start) + out.slice(start + firstStatement.length).replace(/^\n+/, '').replace(/\n+$/, '') + '\n';
  };

  const header = (what: string): string =>
    `// Generated by scripts/gen-types.ts from schema/herdr-api-0.9.1.json (docs/runtime-kits.md 6.7) — do not edit.\n` +
    `// ${what}\n\n`;

  const methodsBody = await compileDefs(variants.flatMap(v => {
    const method = constOf(v, 'method');
    const names = [resolve((prop(v, 'params') as { $ref: string }).$ref)];
    const result = resultFor(method);
    if (!('unknown' in result)) names.push(result.name);
    return names;
  }));

  const methodsTs = header('Method table: request params and response result per socket method.') +
    'export interface HerdrMethods {\n' + methodEntries.join('\n') + '\n}\n\n' +
    'export type HerdrMethod = keyof HerdrMethods;\n' +
    'export type HerdrParams<M extends HerdrMethod> = HerdrMethods[M][\'params\'];\n' +
    'export type HerdrResult<M extends HerdrMethod> = HerdrMethods[M][\'result\'];\n\n' +
    methodsBody;

  const eventsBody = await compileDefs(eventRows.flatMap(r => [r.payload, ...(r.filterDef ? [r.filterDef] : [])]));
  const payloadEntries = eventRows.map(r => `  '${r.kind}': ${r.payload};`).join('\n');
  const filterEntries = eventRows.filter(r => r.filterDef).map(r => `  '${r.kind}': ${r.filterDef};`).join('\n');
  const eventsTs = header('Event table: subscription kind to payload; filtered kinds carry their filter fields.') +
    'export interface HerdrEvents {\n' + payloadEntries + '\n}\n\n' +
    (filterEntries ? 'export interface HerdrEventFilters {\n' + filterEntries + '\n}\n\n' : '') +
    'export type HerdrEventName = keyof HerdrEvents;\n' +
    'export type HerdrEventOf<E extends HerdrEventName> = HerdrEvents[E];\n' +
    'export type HerdrSubscription<E extends HerdrEventName = HerdrEventName> = { type: E } &\n' +
    '  (E extends keyof HerdrEventFilters ? HerdrEventFilters[E] : unknown);\n\n' +
    eventsBody;

  // --- report ---------------------------------------------------------------------------
  const missing = MUXR_METHODS.filter(m => !present.has(m));
  const unmatched = [...present]
    .filter(m => 'unknown' in resultFor(m))
    .sort()
    .map(m => ({ method: m, why: 'result type not determined by the snapshot (naming rules, docs and lab probe)' }));
  const report = { herdr: '0.9.1', protocol, schemaVersion, methods: variants.length, events: eventRows.length, missing, unmatched };
  const reportJson = JSON.stringify(report, null, 2) + '\n';

  return { methodsTs, eventsTs, reportJson };
}

// --- main ---------------------------------------------------------------------------------
const here = path.dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const snapshot = JSON.parse(readFileSync(path.join(here, '..', 'schema', 'herdr-api-0.9.1.json'), 'utf8')) as Schema;
  const { methodsTs, eventsTs, reportJson } = await generate(snapshot);
  const outDir = path.join(here, '..', 'src', 'generated');
  writeFileSync(path.join(outDir, 'methods.ts'), methodsTs);
  writeFileSync(path.join(outDir, 'events.ts'), eventsTs);
  writeFileSync(path.join(outDir, 'report.json'), reportJson);
  console.log('wrote src/generated/{methods.ts,events.ts,report.json}');
}
