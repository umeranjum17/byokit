// Regression for .done-done.yaml journeys that write evidence but no step record:
// a receipt citing such a run is refused with "has no step record". The build and
// gate journeys are not code-only, so done-done requires a well-formed steps.json
// in the one shape its proof.js validates. This fails on the pre-fix tree, where
// neither journey writes one and scripts/done-done-steps.ts does not exist.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { stepRecordFault } from "./done-done-steps.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const config = readFileSync(join(root, ".done-done.yaml"), "utf8");

function journey(name: string): string {
  const at = config.indexOf(`\n  ${name}:`);
  assert.notEqual(at, -1, `.done-done.yaml has journey ${name}`);
  const rest = config.slice(at + 1);
  const next = rest.slice(1).search(/\n  [a-z][a-z0-9-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

function write(journeyName: string, evidence: string): { status: number | null; stderr: string } {
  const run = spawnSync(process.execPath, ["scripts/done-done-steps.ts", journeyName], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, DONE_DONE_EVIDENCE_ROOT: evidence },
  });
  return { status: run.status, stderr: run.stderr };
}

test("the build and gate journeys are not code-only and write the step record done-done validates", () => {
  const evidence = mkdtempSync(join(tmpdir(), "byokit-steps-"));
  try {
    const version = JSON.parse(readFileSync(join(root, "packages/accounts/package.json"), "utf8")).version;
    writeFileSync(join(evidence, "build.log"), "npm run build exited 0 and every package built (run test)\n");
    writeFileSync(join(evidence, "doctor.log"), `doctor ok: @byokit/accounts ${version} resolves /repo/packages/accounts/dist/index.js\n`);
    const built = write("build", evidence);
    assert.equal(built.status, 0, built.stderr);
    const record = JSON.parse(readFileSync(join(evidence, "steps.json"), "utf8"));
    assert.equal(stepRecordFault(record), null, "build writes the exact shape done-done validates");
    assert.ok(record.steps.length > 0, "the build record is non-empty");
    assert.match(record.steps.join("\n"), /npm run build/);
    assert.match(record.steps.join("\n"), /doctor/);
    assert.match(record.result, /every package built/);
    assert.match(journey("build"), /node scripts\/done-done-steps\.ts build/, "the build journey calls the writer");

    writeFileSync(join(evidence, "gate.log"), "gate checked at 2026-10-29T00:00:00Z on head abc\nPASS\n");
    writeFileSync(join(evidence, "ci-checks.log"), "CI check runs for this pull request:\n  done-done,completed\n");
    const gated = write("gate", evidence);
    assert.equal(gated.status, 0, gated.stderr);
    const gate = JSON.parse(readFileSync(join(evidence, "steps.json"), "utf8"));
    assert.equal(stepRecordFault(gate), null, "gate writes the exact shape done-done validates");
    assert.ok(gate.steps.length > 0, "the gate record is non-empty");
    assert.match(gate.result, /PASS/);
    assert.match(journey("gate"), /node scripts\/done-done-steps\.ts gate/, "the gate journey calls the writer");
  } finally {
    rmSync(evidence, { recursive: true, force: true });
  }

  const failing = mkdtempSync(join(tmpdir(), "byokit-steps-"));
  try {
    writeFileSync(join(failing, "gate.log"), "FAIL: no receipt\n");
    writeFileSync(join(failing, "ci-checks.log"), "");
    assert.notEqual(write("gate", failing).status, 0, "a failed gate run writes no PASS record");
    assert.equal(existsSync(join(failing, "steps.json")), false);
  } finally {
    rmSync(failing, { recursive: true, force: true });
  }
});
