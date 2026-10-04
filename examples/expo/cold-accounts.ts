// Real Metro dependency/parser gate, then web-only cold evaluation of the packed-style Accounts key path.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { verifyAccountsProbe } from '../../scripts/accounts-key-probe-check.ts';

const repo = new URL('../../', import.meta.url).pathname;
const expo = join(repo, 'examples/expo');
const retained = process.argv[2];
const dir = retained ?? mkdtempSync(join(tmpdir(), 'cold-accounts-'));
mkdirSync(dir, { recursive: true });
try {
  symlinkSync(join(expo, 'node_modules'), join(dir, 'node_modules'), 'dir');
  cpSync(join(repo, 'scripts/accounts-key-probe.mjs'), join(dir, 'probe.mjs'));
  cpSync(join(repo, 'fixtures/conformance/pi-streams.json'), join(dir, 'pi-streams.json'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'cold-accounts', private: true, main: 'probe.mjs' }));
  writeFileSync(join(dir, 'app.json'), JSON.stringify({ expo: { name: 'Cold Accounts', slug: 'cold-accounts', platforms: ['android'] } }));
  // Build stock config at the probe root (including its server root); mirror the app's explicit overrides only.
  writeFileSync(join(dir, 'metro.config.js'), `const { getDefaultConfig } = require('expo/metro-config');\nconst app = require(${JSON.stringify(join(expo, 'metro.config.js'))});\nconst config = getDefaultConfig(__dirname);\nconfig.watchFolders = [...app.watchFolders, __dirname, ${JSON.stringify(join(expo, 'node_modules'))}];\nconfig.resolver.nodeModulesPaths = app.resolver.nodeModulesPaths;\nconfig.resolver.blockList = app.resolver.blockList;\nmodule.exports = config;\n`);
  execFileSync(join(expo, 'node_modules/.bin/expo'), ['export', '--platform', 'android', '--no-bytecode', '--no-minify', '--dump-sourcemap', '--output-dir', 'out'], {
    cwd: dir, stdio: 'inherit', timeout: 180_000,
    env: { ...process.env, CI: '1', EXPO_OFFLINE: '1', EXPO_NO_TELEMETRY: '1',
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require ${join(repo, 'scripts/test-egress-guard.cjs')}` },
  });
  function files(path: string): string[] {
    return readdirSync(path, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)]);
  }
  const bundles = files(join(dir, 'out')).filter((path) => path.includes('/_expo/') && path.endsWith('.js'));
  assert.equal(bundles.length, 1);
  const path = bundles[0];
  const map = JSON.parse(readFileSync(path + '.map', 'utf8'));
  assert.ok(map.sources.some((source: string) => source.includes('/accounts/dist/pi/')), 'kit artifact actually bundled');
  assert.ok(!map.sources.some((source: string) => source.includes('@earendil-works/pi-ai/dist/') || source.startsWith('node:')), 'no published Pi or Node builtin module');
  let code = readFileSync(path, 'utf8');
  // Skip RN InitializeCore's native-bridge runners, not the probe. Metro's plain process.env shim remains.
  const runners = [...code.matchAll(/^__r\((\d+)\);$/gm)];
  assert.ok(runners.length >= 1, 'the probe main module must run; native-bridge preludes may be absent');
  for (const runner of runners.slice(0, -1)) code = code.replace(runner[0] + '\n', '');
  const web = { FormData, Blob, File, console, Response, Headers, Request, ReadableStream, TextEncoder, TextDecoder,
    AbortController, AbortSignal, URL, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval,
    queueMicrotask, structuredClone, Event, EventTarget, DOMException, crypto: globalThis.crypto, atob, btoa, performance };
  const context = vm.createContext(web);
  context.global = context; context.self = context; context.window = context;
  vm.runInContext(code, context, { filename: path, timeout: 10_000 });
  assert.equal(context.require, undefined);
  assert.equal(context.fetch, undefined);
  assert.equal(context.process?.versions, undefined, 'Metro shim is not Node process');
  assert.equal(context.process?.pid, undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([context.__accountsKeyProbe, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Cold probe timed out')), 30_000); })]);
    verifyAccountsProbe(result);
    writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    console.log('cold-accounts: real Metro + two-family text/tool/usage/options/abort/isolation passed; no require, Node process or global fetch injected');
  } finally { clearTimeout(timer); }
} finally { if (!retained) rmSync(dir, { recursive: true, force: true }); }
