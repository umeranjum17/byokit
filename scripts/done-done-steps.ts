// The step record done-done requires beside a journey's captures. Journeys in
// .done-done.yaml that are not code-only call this instead of hand-writing JSON,
// so every run names the real work it did in the one shape done-done validates.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type StepRecord = {
  target: { version: string };
  start: string;
  steps: string[];
  result: string;
};

const SHAPE = '{"target": {"version": "<version of the app driven>"}, "start": "<the state it started from>", "steps": ["<a step a user takes>", ...], "result": "<what a user can see at the end>"}';

// The same fault done-done's proof.js reports, so a journey never writes a record
// the gate would refuse: a non-empty target.version, start, steps list and result.
export function stepRecordFault(record: unknown): string | null {
  const text = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
  if (!record || typeof record !== "object" || Array.isArray(record))
    return `it is not a JSON object shaped ${SHAPE}`;
  const r = record as Record<string, unknown>;
  const target = r.target as Record<string, unknown> | undefined;
  if (!target || typeof target !== "object" || !text(target.version))
    return "target.version is missing";
  if (!text(r.start))
    return "start is missing";
  if (!Array.isArray(r.steps) || !r.steps.length || !r.steps.every(text))
    return "steps must be a non-empty list of strings";
  if (!text(r.result))
    return "result is missing";
  return null;
}

export function writeStepRecord(evidenceRoot: string | undefined, record: StepRecord): string {
  if (!evidenceRoot)
    throw new Error("DONE_DONE_EVIDENCE_ROOT is not set; run this from a done-done journey");
  const fault = stepRecordFault(record);
  if (fault)
    throw new Error(`step record is invalid: ${fault}`);
  const file = join(evidenceRoot, "steps.json");
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  return file;
}

const readJson = (file: string): Record<string, any> => JSON.parse(readFileSync(file, "utf8"));

const head = (repo: string): string =>
  execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

// Build: the packages npm run build compiled, then the built-entry doctor check.
export function buildRecord(repo: string, evidenceRoot: string): StepRecord {
  const buildLog = readFileSync(join(evidenceRoot, "build.log"), "utf8");
  if (!buildLog.includes("npm run build exited 0"))
    throw new Error("build.log does not record a successful npm run build");
  const doctor = readFileSync(join(evidenceRoot, "doctor.log"), "utf8")
    .split("\n").map((line) => line.trim()).filter(Boolean).pop() ?? "";
  if (!doctor.startsWith("doctor ok:"))
    throw new Error("doctor.log does not record a successful built-entry doctor check");
  // The record is committed in receipts, so name the built entry by its repo path, never this checkout's absolute one.
  const summary = doctor.replaceAll(`${repo}/`, "").replaceAll(repo, "<repo>");
  const pkg = readJson(join(repo, "packages/accounts/package.json"));
  const script = readJson(join(repo, "package.json")).scripts?.build ?? "";
  const built = /(?:^|&&\s*)tsc -b ([^&]+)/.exec(script)?.[1].trim().split(/\s+/).filter(Boolean) ?? [];
  return {
    target: { version: String(pkg.version) },
    start: `clean checkout at ${head(repo)} with no build output from this run`,
    steps: [
      `Ran npm run build: tsc -b ${built.join(", ")}, then node scripts/fix-words-dts.cjs.`,
      `Ran the built-entry doctor check: ${summary}`,
      `Read the build and doctor output this run wrote to build.log and doctor.log.`,
    ],
    result: `npm run build exited 0 and every package built; ${summary}`,
  };
}

// Gate: the gate check on this head, and the CI check runs it read beside it.
export function gateRecord(repo: string, evidenceRoot: string): StepRecord {
  const sha = head(repo);
  const lines = readFileSync(join(evidenceRoot, "gate.log"), "utf8")
    .split("\n").map((line) => line.trim()).filter(Boolean);
  const passed = lines.find((line) => /^PASS\b/.test(line));
  if (!passed)
    throw new Error(`gate.log does not record a PASS (last line: ${lines.at(-1) ?? "empty"})`);
  const ci = readFileSync(join(evidenceRoot, "ci-checks.log"), "utf8").trim();
  return {
    target: { version: sha },
    start: `checkout at head ${sha} before the gate check ran`,
    steps: [
      `Ran done-done gate on head ${sha}.`,
      ci
        ? "Read the pull request CI check runs recorded in ci-checks.log."
        : "Read ci-checks.log after the gate run: it recorded no CI check lines.",
    ],
    result: `done-done gate printed ${passed} for head ${sha}.`,
  };
}

function main(): void {
  const journey = process.argv[2];
  const root = process.cwd();
  const evidence = process.env.DONE_DONE_EVIDENCE_ROOT;
  const record = journey === "build"
    ? buildRecord(root, evidence ?? "")
    : journey === "gate"
      ? gateRecord(root, evidence ?? "")
      : (() => { throw new Error(`unknown journey ${journey ?? ""} (expected build or gate)`); })();
  console.log(`wrote ${writeStepRecord(evidence, record)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
