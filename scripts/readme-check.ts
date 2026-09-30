// Extract fenced TypeScript examples without running them (some sign in or
// start real engines). Resolve imports against built workspace declarations.
// Run after npm run build: node scripts/readme-check.ts [packages/<kit>/README.md ...]
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

export interface Example {
  line: number;
  code: string;
  jsx?: true;
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

function main(): void {
  const readmes = process.argv.slice(2).length > 0 ? process.argv.slice(2).map((p) => resolve(p)) :
    readdirSync(join(root, "packages"), { withFileTypes: true }).filter((e) => e.isDirectory())
      .map((e) => join(root, "packages", e.name, "README.md"));
  // Inside the worktree so ordinary NodeNext resolution finds workspace packages,
  // not path aliases that could hide a broken exports/types map.
  const scratch = mkdtempSync(join(root, ".readme-check-"));
  let failed = false;
  let count = 0;
  try {
    const sources = new Map<string, { readme: string; example: Example }>();
    for (const readme of readmes) {
      const blocks = examples(readFileSync(readme, "utf8"));
      if (blocks.length === 0) {
        console.error(`${relative(root, readme)}: no TypeScript example`);
        failed = true;
      }
      for (const example of blocks) {
        const path = join(scratch, `example-${count++}.${example.jsx ? "tsx" : "mts"}`);
        writeFileSync(path, `${example.code}\nexport {};\n`);
        sources.set(path, { readme, example });
      }
    }
    const program = ts.createProgram([...sources.keys()], {
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.ReactJSX, strict: true, noEmit: true, skipLibCheck: true,
      types: ["node"], lib: ["lib.es2023.d.ts", "lib.dom.d.ts"],
    });
    for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
      failed = true;
      const source = diagnostic.file && sources.get(diagnostic.file.fileName);
      const location = diagnostic.file && diagnostic.start !== undefined ?
        diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start) : null;
      const name = source ? relative(root, source.readme) : "readme-check";
      const line = source && location ? source.example.line + location.line : 0;
      console.error(`${name}:${line}: TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`);
    }
    console.log(`README examples: ${count} blocks checked in ${readmes.length} kits`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (failed) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
