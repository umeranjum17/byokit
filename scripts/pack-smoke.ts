// Fresh-project gate: pack every workspace tarball, install them into a
// scratch app outside the monorepo, and prove the packed shape imports,
// typechecks and runs. Run: npm run smoke:pack. Exits 1 on any failure.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = join(fileURLToPath(import.meta.url), "..");
const root = join(here, "..");

// An aborted smoke run (SIGINT/SIGTERM) must not leave the scratch app behind:
// the finally in main covers success and failure, this covers abort.
const pendingTmp = new Set<string>();
process.on("exit", () => {
  for (const dir of pendingTmp) rmSync(dir, { recursive: true, force: true });
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    for (const dir of [...pendingTmp]) rmSync(dir, { recursive: true, force: true });
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  });
}

function sh(cmd: string, args: string[], cwd: string): string {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`failed: ${cmd} ${args.join(" ")}\n${r.stderr}${r.stdout}`);
  return r.stdout;
}

interface PackEntry {
  name: string;
  filename: string;
}

// Include export-subpath and browser-condition failures, not just workspace
// names: those result keys do not appear in the packed package list.
export function smokeFailures(results: Map<string, string>): string[] {
  return [...results].filter(([, result]) => result !== "pass").map(([name]) => name);
}

function main(): void {
  // No `byokit-` prefix: scripts/test.sh's leak check would blame other runs.
  const dir = mkdtempSync(join(tmpdir(), "pack-smoke-byokit-"));
  pendingTmp.add(dir);
  try {
    const tgzDir = join(dir, "tgz");
    const appDir = join(dir, "app");
    execFileSync("mkdir", ["-p", tgzDir, appDir]);
    const out = sh("npm", ["pack", "--workspaces", "--pack-destination", tgzDir, "--json"], root);
    const entries = Object.values(JSON.parse(out) as Record<string, PackEntry>);
    if (entries.length === 0) throw new Error("npm pack --workspaces packed nothing");
    const results = new Map<string, string>();
    const pass = (name: string): void => {
      results.set(name, "pass");
    };
    const fail = (name: string, why: string): void => {
      results.set(name, `FAIL: ${why}`);
    };
    // Tarball rules.
    const tgzByName = new Map<string, string>();
    for (const e of entries) {
      tgzByName.set(e.name, join(tgzDir, e.filename));
      let files: string[];
      try {
        files = execFileSync("tar", ["-tzf", join(tgzDir, e.filename)], { encoding: "utf8" }).split("\n").filter(Boolean);
      } catch (err) {
        fail(e.name, `cannot list tarball: ${(err as Error).message}`);
        continue;
      }
      const inner = files.map((f) => f.replace(/^package\//, ""));
      for (const need of ["package.json", "README.md", "LICENSE", "CHANGELOG.md"]) {
        if (!inner.includes(need)) fail(e.name, `tarball missing ${need}`);
      }
      const bad = inner.find((f) => f.startsWith("src/") || f.startsWith("test/") || f.endsWith(".tsbuildinfo"));
      if (bad) fail(e.name, `tarball ships source: ${bad}`);
      if (!results.has(e.name)) pass(e.name);
    }
    // Scratch app installing the tarballs.
    const tsVersion = JSON.parse(readFileSync(join(root, "node_modules", "typescript", "package.json"), "utf8")) as {
      version: string;
    };
    writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: "pack-smoke", private: true, type: "module" }));
    const tgzPaths = entries.map((e) => join(tgzDir, e.filename));
    sh(
      "npm",
      ["install", "--no-audit", "--no-fund", ...tgzPaths, `typescript@${tsVersion.version}`, "@types/node@22"],
      appDir,
    );
    // The writing engine must arrive from npm with the packed kit and answer through its default loader.
    writeFileSync(join(appDir, "write-engine.mjs"), `
import assert from 'node:assert/strict';
import { Compose, ENGINE_VERSION, PROTOCOL } from '@byokit/write';
const writer = new Compose();
assert.deepEqual(await writer.hello(), { protocol: PROTOCOL, version: ENGINE_VERSION });
const [check] = await writer.check({ drafts: ['Umer shipped the first version today.'], platform: 'x' });
assert.equal(check.fits, true);
assert.equal(check.length, 'Umer shipped the first version today.'.length);
`);
    try {
      sh("node", ["write-engine.mjs"], appDir);
      pass("@byokit/write [npm engine]");
    } catch (err) {
      fail("@byokit/write [npm engine]", (err as Error).message);
    }
    // Exact internal pins must resolve to the tarball set, never nested copies.
    for (const e of entries) {
      const nested = join(appDir, "node_modules", e.name, "node_modules", "@byokit");
      if (existsSync(nested)) fail(e.name, `nested @byokit under ${e.name}: a pin the tarballs do not satisfy`);
    }
    writeFileSync(join(appDir, "locked-seal.mjs"), `
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileStore } from '@byokit/accounts';
import { osKeyringSeal } from '@byokit/secrets/node';
import { OpenClawKit, stateWords } from '@byokit/openclaw';
import { fakeGateway } from '@byokit/openclaw/testing';
const stateDir = join(process.cwd(), 'seal-state');
mkdirSync(stateDir, { mode: 0o700 });
const keys = new Map();
let locked = false;
const keyring = { get(name) { if (locked) throw new Error('locked'); return keys.get(name) ?? null; },
  set(name, value) { keys.set(name, value); }, delete: name => keys.delete(name) };
const o = { service: 'packed-seal', stateDir, keyring };
const seal = osKeyringSeal(o);
const path = join(stateDir, 'private', 'accounts.bin');
await fileStore(path, seal).modify('provider', async () => ({ type: 'api_key', key: 'packed-canary' }));
const before = readFileSync(path);
const engineRoot = join(stateDir, 'openclaw');
mkdirSync(join(engineRoot, 'state'), { recursive: true });
writeFileSync(join(engineRoot, 'state', 'auth.json'), 'packed-login');
await new OpenClawKit({ stateDir, authSeal: seal, spawnEngine: false }).prepare();
const engineFile = join(engineRoot, 'auth-store.sealed');
const engineBefore = readFileSync(engineFile);
locked = true;
const fallback = osKeyringSeal(o);
await assert.rejects(fileStore(path, fallback).read('provider'), e => e.code === 'keyring-locked');
const kit = new OpenClawKit({ stateDir, authSeal: fallback, spawnEngine: false, transport: fakeGateway().factory });
await kit.prepare(); await kit.start();
assert.equal(kit.state.phase, 'locked');
assert.match(stateWords(kit.state), /saved sign-in is locked/);
assert.deepEqual(readFileSync(path), before);
assert.deepEqual(readFileSync(engineFile), engineBefore);
locked = false;
await kit.start(); assert.equal(kit.state.phase, 'ready'); await kit.stop();
const dual = osKeyringSeal({ ...o, dualWrap: true });
await fileStore(path, dual).read('provider');
assert.equal(readFileSync(path)[4], 3);
const dualKit = new OpenClawKit({ stateDir, authSeal: dual, spawnEngine: false, transport: fakeGateway().factory });
await dualKit.prepare();
locked = true;
assert.equal((await fileStore(path, osKeyringSeal({ ...o, dualWrap: true })).read('provider')).key, 'packed-canary');
await dualKit.start(); assert.equal(dualKit.state.phase, 'ready'); await dualKit.stop();
assert.equal(readFileSync(engineFile)[4], 3);
`);
    try {
      sh("node", ["locked-seal.mjs"], appDir);
      pass("sealing [locked recovery and dual wrapping]");
    } catch (err) {
      fail("sealing [locked recovery and dual wrapping]", (err as Error).message);
    }
    // The packed kit must refuse a live orphan without failed-start cleanup consuming its guards/store.
    writeFileSync(join(appDir, "openclaw-orphan.mjs"), `
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OpenClawKit, EngineAlreadyRunningError, stateWords } from '@byokit/openclaw';
import { fakeGateway } from '@byokit/openclaw/testing';
import { hostKeySeal } from '@byokit/secrets';
const stateDir = join(process.cwd(), 'orphan-state');
const root = join(stateDir, 'openclaw');
const authSeal = hostKeySeal({ key: new Uint8Array(32).fill(9) });
const kit = new OpenClawKit({ stateDir, authSeal, spawnEngine: false, transport: fakeGateway().factory });
mkdirSync(join(root, 'state'), { recursive: true });
writeFileSync(join(root, 'state', 'auth.json'), 'packed-login');
await kit.prepare();
const sealed = readFileSync(join(root, 'auth-store.sealed'));
const deadHost = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
await once(deadHost, 'exit');
const gateway = spawn(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'ignore'] });
await once(gateway.stdout, 'data');
const pid = join(root, 'gateway.pid');
const lock = join(root, 'auth-store.lock');
mkdirSync(lock);
writeFileSync(join(lock, 'pid'), String(deadHost.pid));
writeFileSync(pid, String(gateway.pid));
mkdirSync(join(root, 'state'));
writeFileSync(join(root, 'state', 'auth.json'), 'packed-refreshed-login');
try {
  await assert.rejects(kit.start(), e => e instanceof EngineAlreadyRunningError && e.code === 'engine-already-running');
  assert.equal(kit.state.why, 'engine-already-running');
  assert.match(stateWords(kit.state), /saved sign-in is in use/);
  await kit.stop();
  assert.equal(readFileSync(pid, 'utf8'), String(gateway.pid));
  assert.equal(readFileSync(join(lock, 'pid'), 'utf8'), String(deadHost.pid));
  assert.deepEqual(readFileSync(join(root, 'auth-store.sealed')), sealed);
  assert.equal(readFileSync(join(root, 'state', 'auth.json'), 'utf8'), 'packed-refreshed-login');
} finally {
  const exited = once(gateway, 'exit'); gateway.kill(); await exited;
}
await kit.start();
assert.equal(kit.state.phase, 'ready');
assert.equal(readFileSync(join(root, 'state', 'auth.json'), 'utf8'), 'packed-refreshed-login');
assert.equal(existsSync(pid), false);
await kit.stop();
assert.equal(existsSync(lock), false);
assert.equal(existsSync(join(root, 'state')), false);
`);
    try {
      sh("node", ["openclaw-orphan.mjs"], appDir);
      pass("@byokit/openclaw [orphan ownership and dead-pid recovery]");
    } catch (err) {
      fail("@byokit/openclaw [orphan ownership and dead-pid recovery]", (err as Error).message);
    }
    // Import every export subpath, default and browser conditions.
    const subpaths: { spec: string; browser: boolean }[] = [];
    const bins: { pkg: string; bin: string }[] = [];
    for (const e of entries) {
      const pj = JSON.parse(
        readFileSync(join(appDir, "node_modules", e.name, "package.json"), "utf8"),
      ) as { exports?: Record<string, unknown>; bin?: Record<string, string> | string };
      for (const [key, value] of Object.entries(pj.exports ?? {})) {
        const spec = key === "." ? e.name : `${e.name}${key.slice(1)}`;
        const browser =
          typeof value === "object" && value !== null && "browser" in (value as Record<string, unknown>);
        subpaths.push({ spec, browser });
      }
      if (typeof pj.bin === "object" && pj.bin !== null) {
        for (const bin of Object.keys(pj.bin)) bins.push({ pkg: e.name, bin });
      } else if (typeof pj.bin === "string") {
        bins.push({ pkg: e.name, bin: e.name });
      }
    }
    const impLines = subpaths.map((s) => `await import(${JSON.stringify(s.spec)}${s.spec.endsWith("/package.json") ? ", { with: { type: 'json' } }" : ""});`);
    writeFileSync(join(appDir, "imp.mjs"), `${impLines.join("\n")}\nconsole.log("import-all-ok");\n`);
    const browserSpecs = subpaths.filter((s) => s.browser);
    writeFileSync(
      join(appDir, "imp-browser.mjs"),
      `${browserSpecs.map((s) => `await import(${JSON.stringify(s.spec)}${s.spec.endsWith("/package.json") ? ", { with: { type: 'json' } }" : ""});`).join("\n")}\nconsole.log("import-browser-ok");\n`,
    );
    try {
      sh("node", ["imp.mjs"], appDir);
    } catch (err) {
      for (const s of subpaths) fail(s.spec, `default import failed: ${(err as Error).message.split("\n")[0]}`);
    }
    try {
      sh("node", ["--conditions=browser", "imp-browser.mjs"], appDir);
    } catch (err) {
      for (const s of browserSpecs) fail(`${s.spec} [browser]`, `browser import failed: ${(err as Error).message.split("\n")[0]}`);
    }
    // Consumer typecheck under three module resolutions. Plugins and package metadata are runtime-only exports.
    const consumer = subpaths.filter((s) => !s.spec.endsWith("/app.plugin.js") && !s.spec.endsWith("/package.json")).map((s, i) => `import * as m${i} from ${JSON.stringify(s.spec)};\nvoid m${i};`).join("\n");
    const anthropicConsumer = `
import { Accounts, anthropic, type AnthropicResult } from '@byokit/accounts';
const claude = anthropic({ key: 'app-owned-key' });
const native = { model: 'explicit-model', max_tokens: 1024,
  messages: [{ role: 'user' as const, content: 'Hello' }] };
const text: Promise<string> = claude.respond(native);
const result: Promise<AnthropicResult> = claude.respond({ ...native, result: true });
const accountResult: Promise<AnthropicResult> = new Accounts({ offer: ['anthropic'] }).respond('member', {
  ...native, provider: 'anthropic', key: 'app-owned-key', result: true,
});
void text; void result; void accountResult;
`;
    writeFileSync(join(appDir, "consumer.ts"), `${consumer}\n${anthropicConsumer}\n`);
    const tsc = join(appDir, "node_modules", ".bin", "tsc");
    const configs: Record<string, unknown> = {
      nodenext: {
        compilerOptions: {
          module: "nodenext",
          moduleResolution: "nodenext",
          target: "es2023",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: ["node"],
        },
        files: ["consumer.ts"],
      },
      bundlerBrowser: {
        compilerOptions: {
          module: "esnext",
          moduleResolution: "bundler",
          customConditions: ["browser"],
          target: "es2023",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: [],
          lib: ["es2023", "dom"],
        },
        files: ["consumer.ts"],
      },
      bundlerRn: {
        compilerOptions: {
          module: "esnext",
          moduleResolution: "bundler",
          customConditions: ["react-native"],
          target: "es2023",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: [],
          lib: ["es2023", "dom"],
        },
        files: ["consumer.ts"],
      },
    };
    for (const [name, config] of Object.entries(configs)) {
      const file = join(appDir, `tsconfig.${name}.json`);
      writeFileSync(file, JSON.stringify(config, null, 2));
      const r = spawnSync(tsc, ["-p", file], { cwd: appDir, encoding: "utf8" });
      if (r.status !== 0) {
        for (const s of subpaths) fail(s.spec, `typecheck ${name} failed:\n${r.stdout}`);
        break;
      }
    }
    // Exercise the packed realtime child entry, not only its static exports.
    if (tgzByName.has("@byokit/realtime")) {
      writeFileSync(join(appDir, "realtime.mjs"), `
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { realtimeEngine, toolBridge } from '@byokit/realtime/node';
const server = createServer((_req, response) => response.end('v=0\\r\\ns=voice\\r\\n'));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const frames = [];
const bridge = toolBridge({ tools: [], handlers: {}, emit: frame => frames.push(frame), failure: () => 'Failed' });
const engine = realtimeEngine({ engine: 'chatgpt', auth: { kind: 'plan', access: async () => ({ access: 'test-token', accountId: 'test-account' }) }, endpoint: 'http://127.0.0.1:' + server.address().port, bridge, emit: frame => frames.push(frame) });
const waitFor = async predicate => {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('packed realtime timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
};
try {
  await waitFor(() => frames.some(frame => frame.type === 'realtime.webrtc.start'));
  assert.equal(engine.receive({ type: 'realtime.webrtc.offer', sdp: 'v=0\\r\\n' }), true);
  await waitFor(() => frames.some(frame => frame.type === 'realtime.webrtc.answer'));
  assert.ok(!JSON.stringify(frames).includes('test-token'));
} finally { engine.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
console.log('packed-realtime-child-ok');
`);
      try { sh("node", ["realtime.mjs"], appDir); }
      catch (err) { fail("@byokit/realtime", `packed child flow failed: ${(err as Error).message}`); }
    }
    // Package bins must start without a missing-module error.
    for (const { pkg, bin } of bins) {
      const r = spawnSync(join(appDir, "node_modules", ".bin", bin), [], {
        cwd: appDir,
        encoding: "utf8",
        timeout: 10_000,
      });
      if (/ERR_MODULE_NOT_FOUND|SyntaxError|Cannot find module/.test(`${r.stderr}`)) {
        fail(pkg, `bin ${bin} failed to load:\n${r.stderr}`);
      }
    }
    console.log("package\t\tresult");
    const failures = smokeFailures(results);
    const failed = failures.length;
    for (const [name, result] of results) console.log(`${name}\t${result}`);
    if (failed > 0) throw new Error(`${failed} check(s) failed the pack smoke`);
    console.log(`pack smoke: ${entries.length}/${entries.length} packages pass`);
  } finally {
    pendingTmp.delete(dir);
    rmSync(dir, { recursive: true, force: true });
  }
}

try {
  if (process.argv[1] === fileURLToPath(import.meta.url)) main();
} catch (e) {
  console.error(`smoke:pack: ${(e as Error).message}`);
  process.exit(1);
}
