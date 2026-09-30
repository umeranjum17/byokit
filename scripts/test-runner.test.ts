import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("concurrent test runners own their scratch; genuine leaks still fail; default TMPDIR is isolated", async () => {
  const parent = mkdtempSync(join(tmpdir(), "runner-guard-"));
  const fixture = join(parent, "fixture.test.mts");
  writeFileSync(fixture, `
import { test } from 'node:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const markers = process.env.GUARD_MARKERS!;
const mark = (name: string) => join(markers, name);
async function wait(name: string) {
  const deadline = Date.now() + 10000;
  while (!existsSync(mark(name))) {
    if (Date.now() > deadline) throw new Error('fixture synchronization timed out: ' + name);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
test('scratch fixture', async () => {
  const mode = process.env.GUARD_MODE;
  if (mode === 'hold') {
    await wait('observer-ready'); // observer's before-snapshot is already taken
    const dir = mkdtempSync(join(tmpdir(), 'byokit-guard-'));
    try { writeFileSync(mark('hold-ready'), dir); await wait('release'); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  } else if (mode === 'observer') {
    writeFileSync(mark('observer-ready'), 'ready');
    await wait('hold-ready'); // hold's directory exists throughout this run's leak check
  } else {
    writeFileSync(mark('location'), JSON.stringify({ tmp: tmpdir(), home: process.env.HOME }));
    const dir = mkdtempSync(join(tmpdir(), 'byokit-guard-'));
    if (mode !== 'leak') rmSync(dir, { recursive: true, force: true });
  }
});
`);
  const run = (mode: string, useDefault = false) => {
    const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: parent, GUARD_MODE: mode, GUARD_MARKERS: parent };
    delete env.NODE_TEST_CONTEXT; // independent runner, not a recursive node:test child
    if (useDefault) { delete env.TMPDIR; delete env.TMP; delete env.TEMP; }
    const child = spawn("sh", ["scripts/test.sh", fixture], { cwd: root, env, timeout: 20000 });
    let output = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { output += data; });
    return new Promise<{ status: number | null; output: string }>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, output }));
    });
  };
  try {
    const hold = run("hold");
    const observer = await run("observer");
    writeFileSync(join(parent, "release"), "release");
    const held = await hold;
    assert.equal(observer.status, 0, observer.output);
    assert.equal(held.status, 0, held.output);
    const leaked = await run("leak");
    assert.equal(leaked.status, 1, leaked.output);
    assert.match(leaked.output, /test run leaked project temp directories/);
    const leakingRun = JSON.parse(readFileSync(join(parent, "location"), "utf8"));
    assert.notEqual(leakingRun.tmp, parent, "explicit shared parent must also get a unique run folder");
    assert.equal(existsSync(leakingRun.tmp), false, "failed run cleans only its owned scratch");
    const normal = await run("pass", true);
    assert.equal(normal.status, 0, normal.output);
    const defaultRun = JSON.parse(readFileSync(join(parent, "location"), "utf8"));
    assert.match(defaultRun.tmp, /^\/tmp\/bt\./);
    assert.equal(existsSync(defaultRun.tmp), false);
    assert.notEqual(defaultRun.home, process.env.HOME);
  } finally {
    writeFileSync(join(parent, "release"), "release");
    rmSync(parent, { recursive: true, force: true });
  }
});
