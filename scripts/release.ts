// Release tooling for the @byokit monorepo: versions, the dependent cascade,
// gates, tags and GitHub releases. `release.yml` runs the publish step with
// OIDC provenance; `private: true` holds a package back.
//
// Usage:
//   npm run release -- prepare link=patch relay=minor [--dry-run]
//   npm run release -- publish [--dry-run]
//   npm run release -- lint --base <ref>
//   npm run -s release -- notes --since <iso> [--json]
//   npm run -s release -- notes <pkg>@<version> [...]
// Only node: built-ins, plus git, gh and npm via child processes.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, matchesGlob } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);

// An interrupted publish (SIGINT/SIGTERM) must not leave the notes dir behind:
// the finally in doRelease covers success and failure, this covers abort.
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

export type BulletKind = "SECURITY" | "FIX" | "other";

export interface ChangelogBullet {
  kind: BulletKind;
  text: string;
}

export interface ChangelogSection {
  version: string | null; // null = Unreleased
  date: string | null;
  bullets: ChangelogBullet[];
}

export interface ParsedChangelog {
  unreleased: ChangelogBullet[];
  versions: ChangelogSection[];
}

const versionHeading = /^## (\d+\.\d+\.\d+)(?: \((\d{4}-\d{2}-\d{2})\))?$/;
const bareKind = /^(SECURITY|FIX):(.*)$/;

function toBullet(kind: string | null, text: string): ChangelogBullet {
  const t = text.trim();
  if (kind === "SECURITY") return { kind: "SECURITY", text: t };
  if (kind === "FIX") return { kind: "FIX", text: t };
  return { kind: "other", text: t };
}

// Parses the canonical format (§3) plus the legacy bare `SECURITY: ...` line.
// Continuation lines indented by exactly two spaces join with one space.
export function parseChangelog(text: string): ParsedChangelog {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "# Changelog") throw new Error("changelog must start with '# Changelog'");
  const sections: { version: string | null; date: string | null; bullets: ChangelogBullet[] }[] = [];
  let current: { version: string | null; date: string | null; bullets: ChangelogBullet[] } | null = null;
  let pending: { kind: string | null; parts: string[] } | null = null;
  const flush = () => {
    if (pending && current) current.bullets.push(toBullet(pending.kind, pending.parts.join(" ")));
    pending = null;
  };
  for (const line of lines.slice(1)) {
    if (line.startsWith("## ")) {
      flush();
      const head = line.slice(3).trim();
      if (head === "Unreleased") {
        current = { version: null, date: null, bullets: [] };
      } else {
        const m = versionHeading.exec(line);
        if (!m) throw new Error(`bad version heading: ${line}`);
        current = { version: m[1], date: m[2] ?? null, bullets: [] };
      }
      sections.push(current);
      continue;
    }
    if (!current) {
      if (line.trim() !== "") throw new Error(`text outside any section: ${line}`);
      continue;
    }
    if (line.startsWith("- ")) {
      flush();
      const body = line.slice(2);
      const m = bareKind.exec(body);
      pending = m ? { kind: m[1], parts: [m[2]] } : { kind: null, parts: [body] };
    } else if (/^  \S/.test(line) && pending) {
      pending.parts.push(line.slice(2));
    } else if (line.trim() === "") {
      flush();
    } else {
      const m = bareKind.exec(line.trim());
      if (m) {
        flush();
        pending = { kind: m[1], parts: [m[2]] };
      } else flush();
    }
  }
  flush();
  const unreleased = sections.length > 0 && sections[0].version === null ? sections[0].bullets : [];
  const versions = sections.filter((s) => s.version !== null) as ChangelogSection[];
  return { unreleased, versions };
}

// Rename `## Unreleased` to `## <version> (<date>)`, inserting a fresh one above.
export function rollUnreleased(text: string, version: string, date: string): string {
  const lines = text.split("\n");
  const i = lines.findIndex((l) => l.trim() === "## Unreleased");
  if (i < 0) throw new Error("no ## Unreleased section");
  lines.splice(i, 1, "## Unreleased", "", `## ${version} (${date})`);
  return lines.join("\n");
}

// Cascade notes belong in the version being released, before Unreleased is
// rolled. Keeping this shared by the dry-run and writer prevents empty releases.
export function prepareChangelog(text: string, version: string | null, date: string, bullets: string[]): string {
  const noted = text.replace("## Unreleased\n", `## Unreleased\n\n${bullets.join("\n")}\n`);
  return version === null ? noted : rollUnreleased(noted, version, date);
}

// Source is compiled to dist; the remaining shipped paths follow the package's
// files list, including its exclusion patterns. README/LICENSE ship implicitly.
export function shippedPath(path: string, files: string[]): boolean {
  if (path.startsWith("src/")) return true;
  if (/^(?:README(?:\..*)?|LICEN[CS]E(?:\..*)?)$/i.test(path)) return true;
  if (path === "CHANGELOG.md" || path === "package.json") return false;
  const matches = (pattern: string) => matchesGlob(path, pattern) || matchesGlob(path, `${pattern.replace(/\/$/, "")}/**`);
  return files.some((f) => !f.startsWith("!") && matches(f)) &&
    !files.some((f) => f.startsWith("!") && matches(f.slice(1)));
}

export function bump(version: string, kind: string): string {
  if (kind === "major" || kind.includes("-")) throw new Error(`refusing kind: ${kind}`);
  if (version.includes("-") || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`bad version: ${version}`);
  const [major, minor, patch] = version.split(".").map(Number);
  if (kind === "patch") return `${major}.${minor}.${patch + 1}`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  throw new Error(`refusing kind: ${kind}`);
}

export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

export interface CascadePkg {
  dir: string;
  version: string;
  isPrivate: boolean;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  unreleased: ChangelogBullet[];
}

export interface PinEdit {
  pkg: string;
  dep: string;
  from: string;
  to: string;
}

export interface CascadePlan {
  versions: Map<string, string>;
  pins: PinEdit[];
  bullets: Map<string, string[]>;
}

const byokitDir = (name: string): string | null =>
  name.startsWith("@byokit/") ? name.slice("@byokit/".length) : null;

// Fixed-point cascade (§2, §4.1 step 5): exact internal pins follow releases;
// published dependents in `dependencies` get a patch plus copied notes.
export function planCascade(
  pkgs: CascadePkg[],
  releases: Map<string, string>,
  published: Set<string>,
): CascadePlan {
  const versions = new Map(releases);
  const byDir = new Map(pkgs.map((p) => [p.dir, p]));
  const pins: PinEdit[] = [];
  const bullets = new Map<string, string[]>();
  // New-section SECURITY/FIX notes per released package, including copies that
  // arrived mid-cascade (kept with their original marker so origin survives).
  const newSectionNotes = new Map<string, ChangelogBullet[]>();
  for (const [dir, v] of versions) {
    void v;
    newSectionNotes.set(dir, (byDir.get(dir)?.unreleased ?? []).filter((b) => b.kind !== "other"));
  }
  const addBullets = (dir: string, lines: string[]) => {
    const cur = bullets.get(dir) ?? [];
    cur.unshift(...lines);
    bullets.set(dir, cur);
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const d of pkgs) {
      for (const scope of ["dependencies", "devDependencies"] as const) {
        for (const [depName, pin] of Object.entries(d[scope])) {
          const x = byokitDir(depName);
          if (!x || !versions.has(x)) continue;
          const next = versions.get(x) as string;
          if (pin === next) continue;
          pins.push({ pkg: d.dir, dep: x, from: pin, to: next });
          d[scope][depName] = next;
          changed = true;
          const notes = newSectionNotes.get(x) ?? [];
          const copies = notes.map((b) =>
            b.text.startsWith("(from @byokit/")
              ? `- ${b.kind}: ${b.text}`
              : `- ${b.kind}: (from @byokit/${x} ${next}) ${b.text}`,
          );
          if (scope === "dependencies" && !d.isPrivate && published.has(d.dir) && !versions.has(d.dir)) {
            const v = bump(d.version, "patch");
            versions.set(d.dir, v);
            newSectionNotes.set(d.dir, [
              ...(byDir.get(d.dir)?.unreleased ?? []).filter((b) => b.kind !== "other"),
              ...copies.map((line) => {
                const m = /^-\s(SECURITY|FIX):\s(.*)$/.exec(line) as RegExpExecArray;
                return { kind: m[1], text: m[2] } as ChangelogBullet;
              }),
            ]);
            addBullets(d.dir, [`- Dependency update: pins @byokit/${x} ${next}.`, ...copies]);
          } else {
            addBullets(d.dir, [`- Dependency update: pins @byokit/${x} ${next}.`]);
            if (!versions.has(d.dir)) newSectionNotes.set(d.dir, newSectionNotes.get(d.dir) ?? []);
          }
        }
      }
    }
  }
  return { versions, pins, bullets };
}

// Topological order by internal dependencies (DFS post-order, input order kept).
export function topoOrder(
  pkgs: { dir: string; dependencies: Record<string, string>; devDependencies?: Record<string, string> }[],
): string[] {
  const inSet = new Set(pkgs.map((p) => p.dir));
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (dir: string) => {
    if (seen.has(dir)) return;
    seen.add(dir);
    const p = pkgs.find((k) => k.dir === dir);
    if (p) {
      for (const scope of [p.dependencies, p.devDependencies ?? {}]) {
        for (const name of Object.keys(scope)) {
          const x = byokitDir(name);
          if (x && inSet.has(x)) visit(x);
        }
      }
    }
    out.push(dir);
  };
  for (const p of pkgs) visit(p.dir);
  return out;
}

// Every SECURITY:/FIX: bullet of one version section.
export function extractNotes(text: string, version: string): ChangelogBullet[] {
  const parsed = parseChangelog(text);
  return (parsed.versions.find((s) => s.version === version)?.bullets ?? []).filter(
    (b) => b.kind === "SECURITY" || b.kind === "FIX",
  );
}

export interface LintInput {
  changelogs: Record<string, string | null>;
  files: Record<string, string[]>;
  srcChanged: string[];
  depsChanged: string[];
  versionChanged: string[];
  versions?: Record<string, { before: string | null; after: string; isPrivate: boolean }>;
}

// Well-formed changelogs, files shipping them, and the per-PR Unreleased rule.
export function lint(input: LintInput): string[] {
  const errors: string[] = [];
  const dirs = Object.keys(input.changelogs);
  for (const dir of dirs) {
    const text = input.changelogs[dir];
    if (text === null) {
      errors.push(`${dir}: missing packages/${dir}/CHANGELOG.md`);
      continue;
    }
    let parsed: ParsedChangelog;
    try {
      parsed = parseChangelog(text);
    } catch (e) {
      errors.push(`${dir}: ${(e as Error).message}`);
      continue;
    }
    const firstHeading = /^(## .*)$/m.exec(text)?.[1];
    if (firstHeading !== "## Unreleased") errors.push(`${dir}: first ## heading must be ## Unreleased`);
    const vs = parsed.versions.map((s) => s.version as string);
    for (let i = 1; i < vs.length; i++) {
      if (compareSemver(vs[i - 1], vs[i]) <= 0) errors.push(`${dir}: version headings not descending: ${vs[i - 1]}, ${vs[i]}`);
    }
    for (const s of [{ version: null as string | null, bullets: parsed.unreleased }, ...parsed.versions]) {
      for (const b of s.bullets) {
        if ((b.kind === "SECURITY" || b.kind === "FIX") && b.text === "") {
          errors.push(`${dir}: empty ${b.kind} entry in ${s.version ?? "Unreleased"}`);
        }
      }
    }
    if (!(input.files[dir] ?? []).includes("CHANGELOG.md")) {
      errors.push(`${dir}: files must contain CHANGELOG.md`);
    }
  }
  for (const dir of new Set([...input.srcChanged, ...input.depsChanged])) {
    const version = input.versions?.[dir];
    if (version && !version.isPrivate && version.before !== null &&
        (!/^\d+\.\d+\.\d+$/.test(version.after) || compareSemver(version.after, version.before) < 0)) {
      errors.push(`${dir}: shipped files or runtime manifest changed with an invalid or decreased version`);
    }
    const text = input.changelogs[dir];
    if (text == null) continue;
    let parsed: ParsedChangelog;
    try { parsed = parseChangelog(text); } catch { continue; } // reported above
    if (input.versionChanged.includes(dir)) {
      if (version && !version.isPrivate && !parsed.versions.some((v) => v.version === version.after && v.bullets.length > 0)) {
        errors.push(`${dir}: bumped version ${version.after} needs a non-empty changelog section`);
      }
    } else if (parsed.unreleased.length === 0) {
      errors.push(`${dir}: shipped files or dependencies changed without a ## Unreleased bullet`);
    }
  }
  return errors;
}

// --- process helpers (CLI only) ---

function sh(cmd: string, args: string[], opts: { cwd?: string; stdio?: "inherit" | "pipe" } = {}): string {
  const r = spawnSync(cmd, args, { cwd: opts.cwd ?? root, encoding: "utf8", stdio: opts.stdio ?? "pipe" });
  if (r.status !== 0) {
    throw new Error(`command failed: ${cmd} ${args.join(" ")}\n${r.stderr ?? ""}${r.stdout ?? ""}`);
  }
  return r.stdout ?? "";
}

function npmView(args: string[]): { ok: boolean; out: string; err: string } {
  const r = spawnSync("npm", ["view", ...args], { cwd: root, encoding: "utf8" });
  return { ok: r.status === 0, out: r.stdout ?? "", err: r.stderr ?? "" };
}

function npmVersions(name: string): string[] | null {
  const r = npmView([name, "versions", "--json"]);
  if (r.ok) {
    const v = JSON.parse(r.out);
    return Array.isArray(v) ? v : [v];
  }
  if (r.err.includes("E404")) return null;
  throw new Error(`npm view ${name} versions failed:\n${r.err}`);
}

function npmTimes(name: string): Record<string, string> {
  const r = npmView([name, "time", "--json"]);
  if (r.ok) {
    const v: unknown = JSON.parse(r.out);
    return (Array.isArray(v) ? v[0] : v) as Record<string, string>;
  }
  if (r.err.includes("E404")) return {};
  throw new Error(`npm view ${name} time failed:\n${r.err}`);
}

interface WSPkg {
  dir: string;
  name: string;
  version: string;
  isPrivate: boolean;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

function workspacePackages(): WSPkg[] {
  const dirs = readdirSync(join(root, "packages"), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  return dirs.map((dir) => {
    const pj = JSON.parse(readFileSync(join(root, "packages", dir, "package.json"), "utf8")) as {
      name: string;
      version: string;
      private?: boolean;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return {
      dir,
      name: pj.name,
      version: pj.version,
      isPrivate: pj.private === true,
      dependencies: { ...(pj.dependencies ?? {}) },
      devDependencies: { ...(pj.devDependencies ?? {}) },
    };
  });
}

function readChangelog(dir: string): string | null {
  try {
    return readFileSync(join(root, "packages", dir, "CHANGELOG.md"), "utf8");
  } catch {
    return null;
  }
}

function packageFiles(dir: string): string[] {
  const pj = JSON.parse(readFileSync(join(root, "packages", dir, "package.json"), "utf8")) as {
    files?: string[];
  };
  return pj.files ?? [];
}

function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function help(): string {
  return `npm run release -- <command>

  prepare <pkg>=<patch|minor|x.y.z> [...] [--dry-run]  bump versions, roll
      changelogs, cascade exact internal pins, commit on a branch
  publish [--dry-run]  on merged main: gates, npm publish, GitHub releases,
      backfill missing releases for versions already on npm
  lint --base <ref> [--direct]  shipped-file, version and changelog checks
  notes --since <iso> [--json]  SECURITY:/FIX: bullets published after <iso>
  notes <pkg>@<version> [...]  SECURITY:/FIX: bullets of listed versions
`;
}

function cmdPrepare(rest: string[]): void {
  const dryRun = rest.includes("--dry-run");
  const args = rest.filter((a) => a !== "--dry-run");
  const branch = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  if (branch === "HEAD" || branch === "main") throw new Error(`prepare refuses branch '${branch}': use a release branch, not main`);
  if (sh("git", ["status", "--porcelain"]).trim() !== "") throw new Error("prepare refuses a dirty tree");
  const pkgs = workspacePackages();
  const byDir = new Map(pkgs.map((p) => [p.dir, p]));
  const requested = new Map<string, string>();
  for (const arg of args) {
    const m = /^([a-z-]+)=(\S+)$/.exec(arg);
    if (!m) throw new Error(`bad prepare arg: ${arg} (want <pkg>=<patch|minor|x.y.z>)`);
    const [, pkg, kind] = m;
    const p = byDir.get(pkg);
    if (!p) throw new Error(`unknown package: ${pkg}`);
    if (p.isPrivate) throw new Error(`${pkg} is private: held, not publishable`);
    if (kind === "patch" || kind === "minor") {
      requested.set(pkg, bump(p.version, kind));
    } else {
      if (kind === "major" || kind.includes("-")) throw new Error(`refusing version: ${kind}`);
      if (!/^\d+\.\d+\.\d+$/.test(kind)) throw new Error(`bad version: ${kind}`);
      const onNpm = npmVersions(p.name);
      if (onNpm?.includes(kind)) throw new Error(`${p.name}@${kind} is already on npm`);
      if (compareSemver(kind, p.version) < 0) throw new Error(`${kind} is lower than current ${p.version}`);
      if (kind === p.version && onNpm !== null) throw new Error(`${p.name}@${kind} equals current and is on npm`);
      requested.set(pkg, kind);
    }
  }
  if (requested.size === 0) throw new Error("prepare needs at least one <pkg>=<kind>");
  const texts = new Map<string, string>();
  for (const [pkg] of requested) {
    const text = readChangelog(pkg);
    if (text === null) throw new Error(`missing packages/${pkg}/CHANGELOG.md`);
    if (parseChangelog(text).unreleased.length === 0) {
      throw new Error(`${pkg}: ## Unreleased has no bullets`);
    }
    texts.set(pkg, text);
  }
  const published = new Set(pkgs.filter((p) => npmVersions(p.name) !== null).map((p) => p.dir));
  const cascadePkgs: CascadePkg[] = pkgs.map((p) => ({
    dir: p.dir,
    version: p.version,
    isPrivate: p.isPrivate,
    dependencies: { ...p.dependencies },
    devDependencies: { ...p.devDependencies },
    unreleased: (() => {
      const t = readChangelog(p.dir);
      return t === null ? [] : parseChangelog(t).unreleased;
    })(),
  }));
  const plan = planCascade(cascadePkgs, requested, published);
  const order = topoOrder(pkgs).filter((d) => plan.versions.has(d));
  const today = utcToday();
  if (dryRun) {
    console.log("planned versions:");
    for (const d of order) console.log(`  @byokit/${d} ${byDir.get(d)?.version} -> ${plan.versions.get(d)}`);
    console.log("pin edits:");
    for (const pin of plan.pins) console.log(`  ${pin.pkg}: @byokit/${pin.dep} ${pin.from} -> ${pin.to}`);
    console.log("changelog diffs:");
    for (const d of order) {
      const preview = prepareChangelog(readChangelog(d) as string, plan.versions.get(d) as string, today, plan.bullets.get(d) ?? []);
      console.log(`--- packages/${d}/CHANGELOG.md\n${preview}`);
    }
    for (const [d, lines] of plan.bullets) {
      if (!plan.versions.has(d)) console.log(`--- packages/${d}/CHANGELOG.md (Unreleased only):\n${lines.join("\n")}`);
    }
    console.log("dry-run: wrote nothing");
    return;
  }
  for (const d of order) {
    const pjPath = join(root, "packages", d, "package.json");
    const pjText = readFileSync(pjPath, "utf8");
    const old = (byDir.get(d) as WSPkg).version;
    const rolled = prepareChangelog(readChangelog(d) as string, plan.versions.get(d) as string, today, plan.bullets.get(d) ?? []);
    writeFileSync(pjPath, pjText.replace(`"version": "${old}"`, `"version": "${plan.versions.get(d)}"`));
    writeFileSync(join(root, "packages", d, "CHANGELOG.md"), rolled);
  }
  for (const [d, lines] of plan.bullets) {
    if (plan.versions.has(d)) continue; // notes already rolled into the released section
    const clPath = join(root, "packages", d, "CHANGELOG.md");
    const text = readFileSync(clPath, "utf8");
    writeFileSync(clPath, prepareChangelog(text, null, today, lines));
  }
  // Pin edits for dependents that planCascade re-pinned (package.json files).
  for (const pin of plan.pins) {
    const pjPath = join(root, "packages", pin.pkg, "package.json");
    const pjText = readFileSync(pjPath, "utf8");
    writeFileSync(pjPath, pjText.replace(`"@byokit/${pin.dep}": "${pin.from}"`, `"@byokit/${pin.dep}": "${pin.to}"`));
  }
  sh("npm", ["install", "--package-lock-only", "--no-audit", "--no-fund"]);
  sh("npm", ["install", "--package-lock-only", "--no-audit", "--no-fund"], { cwd: join(root, "examples/expo") });
  sh("git", ["add", "-A"]);
  const msg = `chore(release): ${order.map((d) => `@byokit/${d} ${plan.versions.get(d)}`).join(", ")}`;
  sh("git", ["commit", "-m", msg]);
  for (const d of order) {
    console.log(`## @byokit/${d} ${plan.versions.get(d)}`);
    for (const b of extractNotes(readChangelog(d) as string, plan.versions.get(d) as string)) {
      console.log(`- ${b.kind}: ${b.text}`);
    }
  }
  console.log("next: open a PR; after it merges run 'npm run release -- publish' on main");
}

function cmdPublish(rest: string[]): void {
  const dryRun = rest.includes("--dry-run");
  const dirty = sh("git", ["status", "--porcelain"]).trim() !== "";
  if (dirty && !dryRun) throw new Error("publish refuses a dirty tree");
  if (dirty) console.log("warning: dirty tree (dry-run)");
  let head = sh("git", ["rev-parse", "HEAD"]).trim();
  void head;
  let onMain = false;
  try {
    sh("git", ["fetch", "origin", "main"]);
    head = sh("git", ["rev-parse", "HEAD"]).trim();
    const originMain = sh("git", ["rev-parse", "origin/main"]).trim();
    onMain = head === originMain;
  } catch {
    onMain = false;
  }
  if (!onMain && !dryRun) throw new Error("publish refuses: HEAD != origin/main");
  if (!onMain) console.log("warning: HEAD != origin/main (dry-run)");
  // CI gate: check, browser, engine, react-native and android passed on this sha.
  let ciOk = false;
  try {
    const runs = JSON.parse(sh("gh", ["run", "list", "--workflow", "ci.yml", "--commit", head, "--json", "status,conclusion,event"])) as {
      status: string;
      conclusion: string;
    }[];
    ciOk = runs.some((r) => r.status === "completed" && r.conclusion === "success");
  } catch {
    ciOk = false;
  }
  if (!ciOk && !dryRun) throw new Error(`publish refuses: no successful ci.yml run for ${head}`);
  if (!ciOk) console.log("warning: no successful ci.yml run for this commit (dry-run)");
  const pkgs = workspacePackages().filter((p) => !p.isPrivate);
  const npmOf = new Map<string, string[] | null>();
  for (const p of pkgs) npmOf.set(p.dir, npmVersions(p.name));
  const pending = pkgs.filter((p) => !(npmOf.get(p.dir) ?? [])?.includes(p.version));
  const canonical = ["link", "seal", "secrets", "connect", "reach", "ui-core", "accounts", "realtime", "decide", "relay", "openclaw", "herdr", "write", "record", "overlay", "cloud", "statusbar", "usage", "push"];
  const rank = (d: string): number => {
    const i = canonical.indexOf(d);
    return i < 0 ? canonical.length : i;
  };
  const pendingOrder = topoOrder([...pkgs].sort((a, b) => rank(a.dir) - rank(b.dir))).filter((d) =>
    pending.some((p) => p.dir === d),
  );
  const byDir = new Map(pkgs.map((p) => [p.dir, p]));
  const doRelease = (tag: string, title: string, notes: string, target: string): void => {
    if (dryRun) {
      console.log(`gh release create ${tag} --target ${target} --title "${title}" --notes-file <tmp>`);
      console.log(notes);
      return;
    }
    try {
      sh("gh", ["release", "view", tag]);
      console.log(`release ${tag} exists, skipping`);
      return;
    } catch {
      // missing: create it
    }
    const dir = mkdtempSync(join(tmpdir(), "byokit-release-"));
    pendingTmp.add(dir);
    try {
      const notesFile = join(dir, "notes.md");
      writeFileSync(notesFile, notes);
      sh("gh", ["release", "create", tag, "--target", target, "--title", title, "--notes-file", notesFile]);
    } finally {
      pendingTmp.delete(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  };
  if (pendingOrder.length === 0) console.log("nothing pending");
  if (!dryRun) {
    if (pendingOrder.length > 0) {
      for (const d of pendingOrder) {
        const text = readChangelog(d);
        const v = (byDir.get(d) as WSPkg).version;
        const section = text === null ? undefined : parseChangelog(text).versions.find((s) => s.version === v);
        if (!section || section.bullets.length === 0) {
          throw new Error(`${d}: CHANGELOG has no non-empty ## ${v} section`);
        }
      }
      sh("npm", ["run", "build"], { stdio: "inherit" });
      // tsc -b never deletes stale outputs, so start from a clean dist.
      for (const p of workspacePackages()) {
        rmSync(join(root, "packages", p.dir, "dist"), { recursive: true, force: true });
        rmSync(join(root, "packages", p.dir, "tsconfig.tsbuildinfo"), { force: true });
      }
      sh("npm", ["run", "build"], { stdio: "inherit" });
      sh("npm", ["run", "check"], { stdio: "inherit" });
      sh("npm", ["test"], { stdio: "inherit" });
      sh("npm", ["run", "smoke:pack"], { stdio: "inherit" });
    }
  } else if (pendingOrder.length > 0) {
    console.log(`would gate: clean dist, build, check, test, smoke:pack for ${pendingOrder.join(", ")}`);
  }
  const publishedNow: { pkg: string; version: string }[] = [];
  for (const d of pendingOrder) {
    const p = byDir.get(d) as WSPkg;
    const tag = `${d}-v${p.version}`;
    if ((npmVersions(p.name) ?? []).includes(p.version)) {
      console.log(`${p.name}@${p.version} appeared on npm, skipping publish`);
      continue;
    }
    const pubArgs = ["publish", "-w", p.name, "--access", "public"];
    if (process.env.GITHUB_ACTIONS === "true") pubArgs.push("--provenance");
    if (dryRun) {
      console.log(`npm ${pubArgs.join(" ")} --dry-run`);
    } else {
      try {
        sh("npm", pubArgs, { stdio: "inherit" });
      } catch (e) {
        const done = publishedNow.map((r) => r.pkg).join(", ") || "none";
        const left = pendingOrder.slice(pendingOrder.indexOf(d)).map((x) => `@byokit/${x}`).join(", ");
        throw new Error(`${(e as Error).message}\npublished this run: ${done}; remaining: ${left}`);
      }
      publishedNow.push({ pkg: p.name, version: p.version });
    }
    const section = parseChangelog(readChangelog(d) as string).versions.find((s) => s.version === p.version);
    const notes = `${(section?.bullets ?? []).map((b) => (b.kind === "other" ? `- ${b.text}` : `- ${b.kind}: ${b.text}`)).join("\n")}\n\nnpm: \`${p.name}@${p.version}\``;
    doRelease(tag, `${p.name} ${p.version}`, notes, head);
    if (dryRun) publishedNow.push({ pkg: p.name, version: p.version });
  }
  // Backfill: versions on npm with no GitHub release yet.
  for (const p of pkgs) {
    const onNpm = npmOf.get(p.dir) ?? npmVersions(p.name) ?? [];
    if (!onNpm.includes(p.version)) continue;
    const tag = `${p.dir}-v${p.version}`;
    let exists = false;
    try {
      sh("gh", ["release", "view", tag]);
      exists = true;
    } catch {
      exists = false;
    }
    if (exists) continue;
    let target = head;
    const r = npmView([`${p.name}@${p.version}`, "gitHead", "--json"]);
    if (r.ok) {
      try {
        const parsed: unknown = JSON.parse(r.out);
        const gh = Array.isArray(parsed) ? parsed[0] : parsed;
        if (typeof gh === "string" && gh !== "") target = gh;
      } catch {
        // keep HEAD
      }
    }
    const section = parseChangelog(readChangelog(p.dir) as string).versions.find((s) => s.version === p.version);
    const notes = `${(section?.bullets ?? []).map((b) => (b.kind === "other" ? `- ${b.text}` : `- ${b.kind}: ${b.text}`)).join("\n")}\n\nnpm: \`${p.name}@${p.version}\``;
    doRelease(tag, `${p.name} ${p.version}`, notes, target);
  }
  for (const r of publishedNow) {
    for (const b of extractNotes(readChangelog(r.pkg.replace("@byokit/", "")) as string, r.version)) {
      console.log(`${b.kind} ${r.pkg}@${r.version}: ${b.text}`);
    }
  }
}

function cmdLint(rest: string[]): void {
  const baseIndex = rest.indexOf("--base");
  const base = baseIndex < 0 ? undefined : rest[baseIndex + 1];
  if (!base || base.startsWith("--")) throw new Error("lint needs --base <ref>");
  // PRs use a merge-base; a main push checks its complete before..after range.
  const comparisonBase = rest.includes("--direct") ? base : sh("git", ["merge-base", base, "HEAD"]).trim();
  const names = sh("git", ["diff", "--name-only", comparisonBase, "HEAD"]).split("\n").filter(Boolean);
  const srcChanged: string[] = [];
  const depsTouched: string[] = [];
  const versionChanged: string[] = [];
  const versions: NonNullable<LintInput["versions"]> = {};
  const pkgs = workspacePackages();
  for (const p of pkgs) {
    const manifestPath = `packages/${p.dir}/package.json`;
    const current = JSON.parse(readFileSync(join(root, manifestPath), "utf8"));
    let previous: typeof current | null = null;
    // Missing at base is a new package; other git errors must fail lint.
    const existed = sh("git", ["ls-tree", comparisonBase, "--", manifestPath]).trim() !== "";
    if (existed) previous = JSON.parse(sh("git", ["show", `${comparisonBase}:${manifestPath}`]));
    versions[p.dir] = { before: previous?.private === true ? null : previous?.version ?? null, after: p.version, isPrivate: p.isPrivate };
    const prefix = `packages/${p.dir}/`;
    if (names.some((n) => n.startsWith(prefix) &&
        (shippedPath(n.slice(prefix.length), current.files ?? []) || shippedPath(n.slice(prefix.length), previous?.files ?? [])))) {
      srcChanged.push(p.dir);
    }
    if (!names.includes(manifestPath)) continue;
    // Leaving private is the first public release, even when the scaffold already used its version.
    if (previous?.version !== p.version || (previous?.private === true && !p.isPrivate)) versionChanged.push(p.dir);
    // The runtime manifest is shipped too. Dev-only tooling changes do not
    // require a consumer release; exports, engines, native metadata and pins do.
    const runtime = (manifest: Record<string, unknown>) => Object.fromEntries(
      Object.entries(manifest).filter(([key]) => !["version", "devDependencies", "scripts"].includes(key)).sort(([a], [b]) => a.localeCompare(b)),
    );
    if (!previous || JSON.stringify(runtime(previous)) !== JSON.stringify(runtime(current))) depsTouched.push(p.dir);
  }
  const changelogs: Record<string, string | null> = {};
  const files: Record<string, string[]> = {};
  for (const p of pkgs) {
    changelogs[p.dir] = readChangelog(p.dir);
    files[p.dir] = packageFiles(p.dir);
  }
  const errors = lint({ changelogs, files, srcChanged, depsChanged: depsTouched, versionChanged, versions });
  if (errors.length > 0) {
    for (const e of errors) console.error(`lint: ${e}`);
    throw new Error(`release lint failed with ${errors.length} error(s)`);
  }
  console.log("release lint: ok");
}

interface NoteLine {
  package: string;
  version: string;
  published: string;
  kind: string;
  text: string;
  tag: string;
}

function cmdNotes(rest: string[]): void {
  const json = rest.includes("--json");
  const args = rest.filter((a) => a !== "--json");
  const lines: NoteLine[] = [];
  if (args[0] === "--since") {
    const since = Date.parse(args[1]);
    if (Number.isNaN(since)) throw new Error(`bad --since: ${args[1]}`);
    for (const p of workspacePackages().filter((x) => !x.isPrivate)) {
      const onNpm = npmVersions(p.name);
      if (!onNpm) continue;
      const times = npmTimes(p.name);
      const text = readChangelog(p.dir);
      if (text === null) continue;
      for (const v of onNpm) {
        const t = times[v];
        if (!t || Date.parse(t) <= since) continue;
        for (const b of extractNotes(text, v)) {
          lines.push({ package: p.name, version: v, published: t, kind: b.kind, text: b.text, tag: `${p.dir}-v${v}` });
        }
      }
    }
    lines.sort((a, b) => (a.published < b.published ? -1 : a.published > b.published ? 1 : a.package < b.package ? -1 : 1));
  } else {
    for (const spec of args) {
      const m = /^(@byokit\/[a-z-]+)@(\d+\.\d+\.\d+)$/.exec(spec) ?? /^([a-z-]+)@(\d+\.\d+\.\d+)$/.exec(spec);
      if (!m) throw new Error(`bad notes spec: ${spec} (want <pkg>@<version>)`);
      const dir = m[1].startsWith("@byokit/") ? m[1].slice("@byokit/".length) : m[1];
      const pkgs = workspacePackages();
      const p = pkgs.find((x) => x.dir === dir);
      if (!p) throw new Error(`unknown package: ${dir}`);
      const text = readChangelog(dir);
      if (text === null) throw new Error(`missing packages/${dir}/CHANGELOG.md`);
      let published = "";
      try {
        published = (npmTimes(p.name)[m[2]] ?? "") as string;
      } catch {
        published = "";
      }
      for (const b of extractNotes(text, m[2])) {
        lines.push({ package: p.name, version: m[2], published, kind: b.kind, text: b.text, tag: `${dir}-v${m[2]}` });
      }
    }
  }
  for (const l of lines) {
    if (json) console.log(JSON.stringify(l));
    else console.log(`${l.kind} ${l.package}@${l.version}: ${l.text}`);
  }
}

function main(): void {
  const [, , cmd, ...rest] = process.argv;
  if (cmd === "--help" || cmd === "-h" || cmd === undefined) {
    console.log(help());
    return;
  }
  if (cmd === "prepare") cmdPrepare(rest);
  else if (cmd === "publish") cmdPublish(rest);
  else if (cmd === "lint") cmdLint(rest);
  else if (cmd === "notes") cmdNotes(rest);
  else throw new Error(`unknown command: ${cmd}\n${help()}`);
}

try {
  if (process.argv[1] === fileURLToPath(import.meta.url)) main();
} catch (e) {
  console.error(`release: ${(e as Error).message}`);
  process.exit(1);
}
