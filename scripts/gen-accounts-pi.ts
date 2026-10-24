// Reproducible Metro syntax lowering of the published accounts pin plus one recorded Hermes throwIfAborted guard. No SDK bundling.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, version } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
export const piDir = resolve(root, 'packages/accounts/src/pi');
export const apis = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai', 'mistral-conversations', 'pi-messages', 'azure-openai-responses'];
const json = (path: string) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');

// Hermes (React Native) ships AbortSignal.any/timeout/fetch but not AbortSignal.prototype.throwIfAborted, so Pi's
// unconditional `signal.throwIfAborted()` throws TypeError before any fetch on a key route. Every bundled site the
// anchored pattern can rewrite becomes a local guard with the same semantics (throw the reason, else AbortError); a
// shape it cannot anchor (a call/index receiver) is left for the artifact gate to reject, never mis-rewritten. An
// aborted signal still rejects as aborted and the host app's globals are never touched. This keeps the fix at the
// one place Pi is bundled (here); a Pi bump re-runs this transform over the new sources.
export const patchName = 'hermes-throwIfAborted+portable-node-preload';
const throwIfAbortedGuard = 'function __byokitPiThrowIfAborted(signal) {\n  if (signal == null || !signal.aborted) return;\n  throw signal.reason !== void 0 ? signal.reason : Object.assign(new Error("The operation was aborted"), { name: "AbortError" });\n}\n';
const throwIfAbortedCall = /(?<![\w$.)\]])([A-Za-z_$][\w$]*(?:\s*\??\.\s*[A-Za-z_$][\w$]*)*)\s*\??\.throwIfAborted\s*(?:\?\.)?\s*\(\s*\)/g;
export function patchBundledThrowIfAborted(text: string): string {
  if (!text.includes('.throwIfAborted')) return text;
  const patched = text.replace(throwIfAbortedCall, '__byokitPiThrowIfAborted($1)');
  const marker = '//# sourceMappingURL=';
  const at = patched.lastIndexOf(marker);
  return at < 0 ? patched + throwIfAbortedGuard : patched.slice(0, at) + throwIfAbortedGuard + patched.slice(at);
}
// env-api-keys eagerly dynamicImport("node:fs"|os|path) when process.versions.node is set. The neutral
// bundle's __require shim throws in ESM ("Dynamic require is not supported"); catch at the helper so
// callers keep null helpers and authContext stays app-supplied.
export function patchBundledNodePreload(text: string): string {
  let out = text;
  const dyn = 'var dynamicImport = (specifier) => Promise.resolve().then(() => __toESM(__require(__rewriteRelativeImportExtension(specifier))));';
  const dynPatched = 'var dynamicImport = (specifier) => Promise.resolve().then(() => __toESM(__require(__rewriteRelativeImportExtension(specifier)))).catch(() => ({}));';
  if (out.includes(dyn)) out = out.split(dyn).join(dynPatched);
  const nodeMod = 'var importNodeModule = (specifier) => Promise.resolve().then(() => __toESM(__require(__rewriteRelativeImportExtension(specifier))));';
  const nodeModPatched = 'var importNodeModule = (specifier) => Promise.resolve().then(() => __toESM(__require(__rewriteRelativeImportExtension(specifier)))).catch(() => ({}));';
  if (out.includes(nodeMod)) out = out.split(nodeMod).join(nodeModPatched);
  return out;
}
// Verified published registry record; this repo's lock entry can omit resolved/integrity.
// A pin bump must verify this record again, not silently label new inputs with old provenance.
// The accounts dependency is a caret range, so the installed version moves with Dependabot; the bundle moves only when
// this record does (1.3.0 publishes no gitHead).
const registry = { version: '1.3.0', tarball: 'https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-1.3.0.tgz',
  integrity: 'sha512-KaBI8x7q7sPoFUXICNGD9efHzDG+oRNwVvkA9jdIsSQWH1RjFssOlEGsbLtewUPPgCrvmz0l2KTgSLXTyj3acw==',
  gitHead: null };

export async function generatePi(): Promise<Map<string, string>> {
  const accounts = json('packages/accounts/package.json');
  const range = accounts.dependencies['@earendil-works/pi-ai'];
  const piRoot = relative(root, fileURLToPath(new URL('../', import.meta.resolve('@earendil-works/pi-ai'))));
  const pi = json(`${piRoot}/package.json`);
  const pin = pi.version;
  if (!range.endsWith(pin)) throw new Error(`Install the accounts range ${range} before generating Pi`);
  if (json('package.json').devDependencies.esbuild !== version) throw new Error('Install the exact esbuild pin before generating Pi');
  const locked = json('package-lock.json').packages['node_modules/@earendil-works/pi-ai'];
  if (locked.version !== pin || pin !== registry.version || locked.integrity && locked.integrity !== registry.integrity || locked.resolved && locked.resolved !== registry.tarball) throw new Error('Verify registry provenance before changing the Pi pin');
  const entryPoints = { core: 'scripts/accounts-pi-core.ts', 'cloudflare-stream': `${piRoot}/dist/providers/cloudflare-stream.js`,
    ...Object.fromEntries(apis.map((api) => [api, `${piRoot}/dist/api/${api}.js`])) };
  const options = { entryPoints, outdir: relative(root, piDir), bundle: true as const, splitting: true as const, format: 'esm' as const,
    platform: 'neutral' as const, target: 'es2022', mainFields: ['module', 'main'], conditions: ['import'],
    external: [...Object.keys(pi.dependencies), 'node:*'], supported: { 'dynamic-import': false }, chunkNames: 'chunk-[hash]',
    sourcemap: 'linked' as const, sourcesContent: true as const, legalComments: 'eof' as const,
    banner: { js: `// @earendil-works/pi-ai@${pin} (MIT, (c) 2025 Mario Zechner), bundled by @byokit/accounts with a Hermes throwIfAborted guard; see NOTICE.` } };
  const result = await build({ ...options, absWorkingDir: root, write: false, metafile: true, logLevel: 'error' });
  const files = new Map(result.outputFiles.map((f) => [relative(piDir, f.path), f.text]));
  for (const [name, text] of files) if (name.endsWith('.js')) {
    files.set(name, patchBundledNodePreload(patchBundledThrowIfAborted(text)));
  }
  for (const name of Object.keys(entryPoints)) files.set(`${name}.d.ts`, name === 'core'
    ? "export { createModels, createProvider } from '@earendil-works/pi-ai';\nexport { lazyApi } from '@earendil-works/pi-ai/api/lazy';\n"
    : `export * from '@earendil-works/pi-ai/${name === 'cloudflare-stream' ? 'providers' : 'api'}/${name}';\n`);
  const inputs = Object.keys(result.metafile.inputs).sort().map((path) => ({ path, sha256: sha256(readFileSync(resolve(root, path))) }));
  const outputs = [...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, text]) => ({ path, sha256: sha256(text) }));
  const externals = [...new Set(Object.values(result.metafile.outputs).flatMap((output) => output.imports.filter((i) => i.external).map((i) => i.path)))].sort();
  const patchSites = [...files].filter(([name]) => name.endsWith('.js')).reduce((n, [, text]) => n + [...text.matchAll(/__byokitPiThrowIfAborted\(/g)].length, 0);
  const preloadSites = [...files].filter(([name]) => name.endsWith('.js')).reduce((n, [, text]) => n + [...text.matchAll(/\.catch\(\(\) => \(\{\}\)\)/g)].length, 0);
  files.set('PROVENANCE.json', JSON.stringify({ package: pi.name, version: pin, tarball: registry.tarball, integrity: registry.integrity,
    gitHead: registry.gitHead, license: pi.license, copyright: 'Copyright (c) 2025 Mario Zechner',
    patch: { name: patchName, helper: '__byokitPiThrowIfAborted', sites: patchSites, preloadCatchSites: preloadSites,
      reason: 'Hermes lacks AbortSignal.prototype.throwIfAborted (local guard). Eager node:fs/os/path preloads in the neutral bundle catch __require failures so portable ESM does not reject after a green stream. Re-applied on every regenerate.' },
    esbuild: version, options, externals, inputs, outputs }, null, 2) + '\n');
  return files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = await generatePi();
  rmSync(piDir, { recursive: true, force: true });
  for (const [name, text] of files) { const path = resolve(piDir, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
  console.log(`Generated ${files.size} pinned Pi artifact files`);
}
