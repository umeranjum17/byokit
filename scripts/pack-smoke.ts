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

function sh(cmd: string, args: string[], cwd: string): string {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`failed: ${cmd} ${args.join(" ")}\n${r.stderr}${r.stdout}`);
  return r.stdout;
}

interface PackEntry {
  name: string;
  filename: string;
}

function main(): void {
  // No `byokit-` prefix: scripts/test.sh's leak check would blame other runs.
  const dir = mkdtempSync(join(tmpdir(), "pack-smoke-byokit-"));
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
    // Exact internal pins must resolve to the tarball set, never nested copies.
    for (const e of entries) {
      const nested = join(appDir, "node_modules", e.name, "node_modules", "@byokit");
      if (existsSync(nested)) fail(e.name, `nested @byokit under ${e.name}: a pin the tarballs do not satisfy`);
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
    const impLines = subpaths.map((s) => `await import(${JSON.stringify(s.spec)});`);
    writeFileSync(join(appDir, "imp.mjs"), `${impLines.join("\n")}\nconsole.log("import-all-ok");\n`);
    const browserSpecs = subpaths.filter((s) => s.browser);
    writeFileSync(
      join(appDir, "imp-browser.mjs"),
      `${browserSpecs.map((s) => `await import(${JSON.stringify(s.spec)});`).join("\n")}\nconsole.log("import-browser-ok");\n`,
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
    // Consumer typecheck under three module resolutions.
    const consumer = subpaths.map((s, i) => `import * as m${i} from ${JSON.stringify(s.spec)};\nvoid m${i};`).join("\n");
    writeFileSync(join(appDir, "consumer.ts"), `${consumer}\n`);
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
    let failed = 0;
    for (const e of entries) {
      const r = results.get(e.name) ?? "pass";
      if (r !== "pass") failed++;
      console.log(`${e.name}\t${r}`);
    }
    if (failed > 0) throw new Error(`${failed} package(s) failed the pack smoke`);
    console.log(`pack smoke: ${entries.length}/${entries.length} packages pass`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

try {
  if (process.argv[1] === fileURLToPath(import.meta.url)) main();
} catch (e) {
  console.error(`smoke:pack: ${(e as Error).message}`);
  process.exit(1);
}
