// Extract and typecheck every fenced TypeScript block without executing it.
// Run after npm run build: node scripts/readme-check.ts [packages/<kit>/README.md ...]
// Existing gaps are frozen in readme-baseline.json; changing code or diagnostics
// invalidates its snapshot. Passing examples never need a baseline entry.
// TypeScript 7 ships no in-process compiler API, so the check drives the supported
// surface instead: one `tsc -p` run over the extracted files, diagnostics parsed back.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tsc = join(root, "node_modules", "typescript", "bin", "tsc");

export interface Example {
  line: number;
  code: string;
  jsx?: true;
}

export interface BlockResult {
  readme: string;
  block: number; // 1-based TS block, 0 means no TypeScript example
  line: number;
  code: string;
  diagnostics: { start: number; code: number; message: string }[];
}

export interface BaselineEntry {
  readme: string;
  block: number;
  snapshot: string;
  reason: string;
}

export function examples(markdown: string): Example[] {
  const found: Example[] = [];
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const fence = /^\s*(`{3,}|~{3,})(\S*)\s*$/.exec(lines[i]);
    if (!fence) continue;
    const start = i + 1;
    const close = new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`);
    while (++i < lines.length && !close.test(lines[i])) { /* fenced content */ }
    if (i === lines.length) throw new Error(`unclosed fence at line ${start}`);
    if (["ts", "typescript", "tsx"].includes(fence[2])) {
      found.push({ line: start + 1, code: lines.slice(start, i).join("\n"), ...(fence[2] === "tsx" ? { jsx: true as const } : {}) });
    }
  }
  return found;
}

export function snapshot(result: BlockResult): string {
  return createHash("sha256").update(JSON.stringify({ code: result.code, diagnostics: result.diagnostics })).digest("hex");
}

export function allowedFailure(result: BlockResult, baseline: BaselineEntry[]): boolean {
  return baseline.some((entry) => entry.readme === result.readme && entry.block === result.block &&
    entry.reason.trim() !== "" && entry.snapshot === snapshot(result));
}

const diagnosticLine = /^(.*)\((\d+),(\d+)\): (?:error|warning) (TS\d+): (.*)$/;

function offsetOf(text: string, line: number, column: number): number {
  const lines = text.split("\n");
  let offset = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i++) offset += lines[i].length + 1;
  return offset + column - 1;
}

export function analyze(readmes: string[]): BlockResult[] {
  // Ordinary NodeNext resolution against built workspace exports; no aliases
  // pointing into src that would hide broken declarations or exports maps.
  const scratch = mkdtempSync(join(root, ".readme-check-"));
  const results: BlockResult[] = [];
  try {
    const sources = new Map<string, { result: BlockResult; text: string }>();
    for (const readme of readmes) {
      const blocks = examples(readFileSync(readme, "utf8"));
      if (blocks.length === 0) {
        results.push({ readme: relative(root, readme), block: 0, line: 1, code: "", diagnostics: [
          { start: 0, code: 0, message: "no TypeScript example" },
        ] });
      }
      for (const [index, example] of blocks.entries()) {
        const name = `example-${sources.size}.${example.jsx ? "tsx" : "mts"}`;
        const text = `${example.code}\nexport {};\n`;
        writeFileSync(join(scratch, name), text);
        const result = { readme: relative(root, readme), block: index + 1, line: example.line, code: example.code, diagnostics: [] } as BlockResult;
        results.push(result);
        sources.set(resolve(scratch, name), { result, text });
      }
    }
    writeFileSync(join(scratch, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        module: "nodenext", moduleResolution: "nodenext", target: "es2023", jsx: "react-jsx",
        strict: true, noEmit: true, skipLibCheck: true, types: ["node"], lib: ["es2023", "dom"],
      },
      files: [...sources.keys()].map((path) => relative(scratch, path)),
    }));
    let output = "";
    try {
      execFileSync(process.execPath, [tsc, "-p", scratch, "--pretty", "false"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string };
      output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
      if (e.stdout === undefined && e.stderr === undefined) throw error;
    }
    let current: BlockResult | undefined;
    for (const raw of output.split("\n")) {
      if (raw.trim() === "") continue;
      const match = diagnosticLine.exec(raw);
      if (!match) {
        if (/^Found \d+ errors? in /.test(raw)) continue;
        if (current && /^\s/.test(raw) && current.diagnostics.length > 0) {
          current.diagnostics[current.diagnostics.length - 1].message += `\n${raw.trimStart()}`;
          continue;
        }
        // Compiler/config/dependency errors outside an extracted file must fail.
        throw new Error(`readme-check: ${raw}`);
      }
      const [, file, line, column, code, message] = match;
      const source = sources.get(resolve(root, file));
      if (!source) throw new Error(`readme-check: TS${code}: ${message}`);
      current = source.result;
      current.diagnostics.push({ start: offsetOf(source.text, Number(line), Number(column)), code: Number(code.slice(2)), message });
    }
    return results;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function main(): void {
  const readmes = process.argv.slice(2).length > 0 ? process.argv.slice(2).map((p) => resolve(p)) :
    readdirSync(join(root, "packages"), { withFileTypes: true }).filter((e) => e.isDirectory())
      .map((e) => join(root, "packages", e.name, "README.md"));
  const baseline = JSON.parse(readFileSync(join(root, "scripts/readme-baseline.json"), "utf8")) as BaselineEntry[];
  const results = analyze(readmes);
  let failed = 0;
  let allowed = 0;
  for (const result of results) {
    if (result.diagnostics.length === 0) continue;
    if (allowedFailure(result, baseline)) {
      allowed++;
      console.log(`baseline: ${result.readme} block ${result.block || "missing"}`);
      continue;
    }
    failed++;
    for (const diagnostic of result.diagnostics) {
      const line = result.line + result.code.slice(0, diagnostic.start).split("\n").length - 1;
      console.error(`${result.readme}:${line}: TS${diagnostic.code}: ${diagnostic.message}`);
    }
  }
  const used = new Set(results.filter((r) => r.diagnostics.length > 0 && allowedFailure(r, baseline))
    .map((r) => `${r.readme}:${r.block}`));
  for (const entry of baseline) {
    if (readmes.some((p) => relative(root, p) === entry.readme) && !used.has(`${entry.readme}:${entry.block}`)) {
      console.warn(`baseline no longer needed: ${entry.readme} block ${entry.block}; remove its entry`);
    }
  }
  console.log(`README examples: ${results.filter((r) => r.block > 0).length} blocks, ${allowed} existing gaps, ${failed} new failures in ${readmes.length} kits`);
  if (failed > 0) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
