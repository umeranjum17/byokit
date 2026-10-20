// Tests for scripts/release.ts: cascade, order and release notes, plus the lint,
// prepare and publish CLIs in a throwaway git repo. No network.
import { strict as assert } from "node:assert";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  extractNotes,
  parseChangelog,
  prepareChangelog,
  planCascade,
  topoOrder,
  type CascadePkg,
} from "./release.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const changelog = (dir: string): string => readFileSync(join(root, "packages", dir, "CHANGELOG.md"), "utf8");

function cascadeFixture(): CascadePkg[] {
  const empty: CascadePkg = {
    dir: "",
    version: "0.0.0",
    isPrivate: false,
    dependencies: {},
    devDependencies: {},
    unreleased: [],
  };
  const mk = (dir: string, version: string, extra: Partial<CascadePkg> = {}): CascadePkg => ({
    ...empty,
    dir,
    version,
    dependencies: { ...(extra.dependencies ?? {}) },
    devDependencies: { ...(extra.devDependencies ?? {}) },
    ...extra,
  });
  return [
    mk("link", "0.3.1", {
      unreleased: [{ kind: "SECURITY", text: "bad temp path; now random" }],
    }),
    mk("relay", "0.1.3", { dependencies: { "@byokit/link": "0.3.1" } }),
    mk("ui-core", "0.2.0"),
    mk("openclaw", "0.1.0", {
      isPrivate: true,
      dependencies: { "@byokit/link": "0.3.1", "@byokit/relay": "0.1.3" },
      devDependencies: { "@byokit/ui-core": "0.2.0" },
    }),
    mk("herdr", "0.1.0", {
      isPrivate: true,
      dependencies: { "@byokit/link": "0.3.1", "@byokit/relay": "0.1.3" },
    }),
  ];
}

test("planCascade bumps published dependents, re-pins private ones", () => {
  const pkgs = cascadeFixture();
  const plan = planCascade(pkgs, new Map([["link", "0.3.2"]]), new Set(["link", "relay", "ui-core"]));
  assert.equal(plan.versions.get("link"), "0.3.2");
  assert.equal(plan.versions.get("relay"), "0.1.4");
  assert.ok(!plan.versions.has("openclaw"), "private kit gets no bump");
  assert.ok(!plan.versions.has("herdr"), "private kit gets no bump");
  const relayPins = plan.pins.filter((p) => p.pkg === "relay");
  assert.deepEqual(relayPins, [{ pkg: "relay", dep: "link", from: "0.3.1", to: "0.3.2" }]);
  assert.ok(plan.pins.some((p) => p.pkg === "openclaw" && p.dep === "link" && p.to === "0.3.2"));
  assert.ok(plan.pins.some((p) => p.pkg === "openclaw" && p.dep === "relay" && p.to === "0.1.4"));
  assert.ok(plan.pins.some((p) => p.pkg === "herdr" && p.dep === "relay" && p.to === "0.1.4"));
  const relayBullets = plan.bullets.get("relay") ?? [];
  assert.ok(relayBullets.includes("- Dependency update: pins @byokit/link 0.3.2."));
  assert.ok(relayBullets.some((l) => l.includes("(from @byokit/link 0.3.2)") && l.startsWith("- SECURITY:")));
  const kitBullets = plan.bullets.get("openclaw") ?? [];
  assert.ok(kitBullets.includes("- Dependency update: pins @byokit/link 0.3.2."));
  assert.ok(kitBullets.every((l) => !l.includes("(from @byokit/")), "private kit gets Depends lines only");
});

test("planCascade re-pins a devDependency without a bump", () => {
  const pkgs = cascadeFixture();
  const plan = planCascade(pkgs, new Map([["ui-core", "0.2.1"]]), new Set(["link", "relay", "ui-core"]));
  assert.ok(!plan.versions.has("openclaw"));
  assert.ok(plan.pins.some((p) => p.pkg === "openclaw" && p.dep === "ui-core" && p.to === "0.2.1"));
  assert.deepEqual(plan.bullets.get("openclaw"), ["- Dependency update: pins @byokit/ui-core 0.2.1."]);
});

test("topoOrder puts link before relay before the kits", () => {
  const pkgs = cascadeFixture();
  const order = topoOrder([...pkgs].reverse());
  assert.ok(order.indexOf("link") < order.indexOf("relay"));
  assert.ok(order.indexOf("relay") < order.indexOf("openclaw"));
  assert.ok(order.indexOf("relay") < order.indexOf("herdr"));
});

test("extractNotes returns SECURITY/FIX bullets of one version", () => {
  const notes = extractNotes(changelog("seal"), "0.1.0");
  assert.ok(notes.some((b) => b.kind === "SECURITY"));
  assert.ok(notes.some((b) => b.kind === "FIX"));
  assert.ok(notes.every((b) => b.text.length > 0));
  assert.deepEqual(extractNotes(changelog("seal"), "9.9.9"), []);
});

test("prepare places cascade dependency notes inside every released version", () => {
  const pkgs = cascadeFixture();
  pkgs.find((p) => p.dir === "openclaw")!.isPrivate = false;
  const plan = planCascade(pkgs, new Map([["link", "0.3.2"]]), new Set(["link", "relay", "openclaw"]));
  const empty = "# Changelog\n\n## Unreleased\n\n## 0.1.0\n\n- Initial release.\n";
  for (const dir of ["relay", "openclaw"]) {
    const version = plan.versions.get(dir)!;
    const text = prepareChangelog(empty, version, "2026-09-30", plan.bullets.get(dir) ?? []);
    const parsed = parseChangelog(text);
    assert.deepEqual(parsed.unreleased, [], `${dir}: notes must not be stranded in Unreleased`);
    const released = parsed.versions.find((v) => v.version === version)!;
    assert.ok(released.bullets.some((b) => b.text === "Dependency update: pins @byokit/link 0.3.2."));
    assert.ok(released.bullets.some((b) => b.kind === "SECURITY"), `${dir}: inherited security notes ship too`);
    if (dir === "openclaw") assert.ok(released.bullets.some((b) => b.text === "Dependency update: pins @byokit/relay 0.1.4."));
  }
});

test("release lint CLI requires notes for unchanged shipped schemas and accepts feature and release PR and push ranges", () => {
  const dir = mkdtempSync(join(tmpdir(), "release-lint-"));
  const run = (command: string, args: string[]) => spawnSync(command, args, { cwd: dir, encoding: "utf8" });
  const git = (...args: string[]) => {
    const result = run("git", ["-c", "user.name=Release test", "-c", "user.email=release@example.invalid", "-c", "commit.gpgsign=false", ...args]);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    mkdirSync(join(dir, "scripts"));
    mkdirSync(join(dir, "packages/probe/schema"), { recursive: true });
    copyFileSync(join(root, "scripts/release.ts"), join(dir, "scripts/release.ts"));
    const manifest = { name: "@byokit/probe", version: "0.1.0", files: ["dist", "schema", "CHANGELOG.md"] };
    const manifestPath = join(dir, "packages/probe/package.json");
    const changelogPath = join(dir, "packages/probe/CHANGELOG.md");
    const changelog = "# Changelog\n\n## Unreleased\n\n- FIX: validate schema fields.\n\n## 0.1.0\n\n- Initial.\n";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    writeFileSync(changelogPath, changelog.replace("- FIX: validate schema fields.\n", ""));
    writeFileSync(join(dir, "packages/probe/schema/v1.json"), "{}");
    git("init", "-q"); git("add", "."); git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(dir, "packages/probe/schema/v1.json"), '{"changed":true}');
    git("add", "."); git("commit", "-qm", "change schema");
    const lintArgs = ["scripts/release.ts", "lint", "--base", base];
    const rejected = run(process.execPath, lintArgs);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /without a ## Unreleased bullet/);
    mkdirSync(join(dir, "packages/probe/changes"));
    writeFileSync(join(dir, "packages/probe/changes/schema.md"), "- FIX: validate schema fields.\n");
    git("add", "."); git("commit", "-qm", "note feature without bump");
    for (const args of [lintArgs, [...lintArgs, "--direct"]]) {
      const accepted = run(process.execPath, args);
      assert.equal(accepted.status, 0, accepted.stderr);
      assert.match(accepted.stdout, /release lint: ok/);
    }
    manifest.version = "0.1.1";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    writeFileSync(changelogPath, prepareChangelog(changelog, "0.1.1", "2026-09-30", []));
    git("add", "."); git("commit", "-qm", "note and bump");
    for (const args of [lintArgs, [...lintArgs, "--direct"]]) {
      const accepted = run(process.execPath, args);
      assert.equal(accepted.status, 0, accepted.stderr);
      assert.match(accepted.stdout, /release lint: ok/);
    }
    // A private scaffold's version has never shipped: removing private releases it at that same version.
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, private: true }));
    git("add", "."); git("commit", "-qm", "private scaffold");
    const privateBase = git("rev-parse", "HEAD");
    writeFileSync(manifestPath, JSON.stringify(manifest));
    writeFileSync(changelogPath, "# Changelog\n\n## Unreleased\n\n## 0.1.1\n\n- Initial public release.\n");
    git("add", "."); git("commit", "-qm", "first public release");
    for (const direct of [[], ["--direct"]]) {
      const accepted = run(process.execPath, ["scripts/release.ts", "lint", "--base", privateBase, ...direct]);
      assert.equal(accepted.status, 0, accepted.stderr);
      assert.match(accepted.stdout, /release lint: ok/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prepare CLI compiles fragments with existing notes and deletes them in its commit", () => {
  const dir = mkdtempSync(join(tmpdir(), "release-prepare-"));
  const run = (cmd: string, args: string[]) => {
    const r = spawnSync(cmd, args, {
      cwd: dir, encoding: "utf8", timeout: 120_000,
      env: { ...process.env, PATH: join(dir, "bin") + ":" + process.env.PATH, npm_config_offline: "true" },
    });
    // A timed-out child returns status null with empty stderr; name it so the assertion shows the hang.
    if (r.signal) r.stderr += `\n${cmd} ${args.join(" ")} was killed by ${r.signal} after the 120s timeout`;
    return r;
  };
  const git = (...args: string[]) => {
    const r = run("git", ["-c", "user.name=Umer", "-c", "user.email=umer@example.invalid", "-c", "commit.gpgsign=false", ...args]);
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  try {
    for (const path of ["scripts", "bin", "examples/expo", "examples/consumer", "packages/probe/changes", "packages/a-consumer", "packages/b-range", "packages/c-dev", "packages/d-first", "packages/e-new"]) mkdirSync(join(dir, path), { recursive: true });
    copyFileSync(join(root, "scripts/release.ts"), join(dir, "scripts/release.ts"));
    // Prefer the npm shipped beside the running node: a version-manager shim on
    // PATH (e.g. mise) can spin forever under this test's isolated HOME.
    const besideNode = join(dirname(process.execPath), "npm");
    const realNpm = existsSync(besideNode)
      ? besideNode
      : spawnSync("/bin/sh", ["-c", "command -v npm"], { encoding: "utf8" }).stdout.trim();
    assert.ok(realNpm.startsWith("/"));
    // Only registry version discovery is canned; lockfile resolution uses the actual npm, offline.
    // A placeholder-only package (0.0.0 reserves its name) answers its own list.
    // A name never published answers E404 on stdout, as npm --json prints it.
    writeFileSync(join(dir, "bin/npm"), `#!/bin/sh\nif [ "$1" = view ] && [ "$2" = @byokit/d-first ]; then echo '["0.0.0"]'; elif [ "$1" = view ] && [ "$2" = @byokit/e-new ]; then echo '{"error":{"code":"E404"}}'; exit 1; elif [ "$1" = view ]; then echo '["0.1.0"]'; else exec '${realNpm}' "$@"; fi\n`);
    chmodSync(join(dir, "bin/npm"), 0o755);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ private: true, type: "module", workspaces: ["packages/*"] }));
    writeFileSync(join(dir, "examples/expo/package.json"), '{"private":true}');
    const examplePath = join(dir, "examples/consumer/package.json");
    const example = { private: true, dependencies: { "@byokit/probe": "0.1.0", "@byokit/b-range": ">=0.1.0", "@byokit/c-dev": "file:../../packages/c-dev" },
      devDependencies: { "@byokit/probe": "0.1.0" }, peerDependencies: { "@byokit/a-consumer": "0.1.0" }, optionalDependencies: { "@byokit/probe": "0.1.0" } };
    writeFileSync(examplePath, JSON.stringify(example, null, 2) + "\n");
    const peerMeta = { "@byokit/probe": { optional: true }, "external-example": { optional: true } };
    writeFileSync(join(dir, "packages/a-consumer/package.json"), JSON.stringify({ name: "@byokit/a-consumer", version: "0.1.0",
      peerDependencies: { "@byokit/probe": "0.1.0", "external-example": ">=1" }, peerDependenciesMeta: peerMeta }, null, 2));
    writeFileSync(join(dir, "packages/b-range/package.json"), JSON.stringify({ name: "@byokit/b-range", version: "0.1.0",
      peerDependencies: { "@byokit/probe": ">=0.1.0" } }, null, 2));
    writeFileSync(join(dir, "packages/c-dev/package.json"), JSON.stringify({ name: "@byokit/c-dev", version: "0.1.0",
      devDependencies: { "@byokit/probe": "0.1.0" } }, null, 2));
    writeFileSync(join(dir, "packages/d-first/package.json"), JSON.stringify({ name: "@byokit/d-first", version: "0.1.0", publishConfig: { tag: "next" } }, null, 2));
    writeFileSync(join(dir, "bin/gh"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(dir, "bin/gh"), 0o755);
    for (const kit of ["a-consumer", "b-range", "c-dev", "d-first", "e-new"]) writeFileSync(join(dir, `packages/${kit}/CHANGELOG.md`), "# Changelog\n\n## Unreleased\n\n- Existing note.\n");
    writeFileSync(join(dir, "packages/e-new/package.json"), JSON.stringify({ name: "@byokit/e-new", version: "0.1.0" }, null, 2));
    writeFileSync(join(dir, "packages/probe/package.json"), JSON.stringify({ name: "@byokit/probe", version: "0.1.0" }, null, 2));
    const cl = join(dir, "packages/probe/CHANGELOG.md");
    writeFileSync(cl, "# Changelog\n\n## Unreleased\n\n- Existing note for Umer.\n");
    const fragment = join(dir, "packages/probe/changes/umer.md");
    writeFileSync(fragment, "- FIX: fragment for Umer.\n");
    const initial = run("npm", ["install", "--package-lock-only", "--no-audit", "--no-fund"]);
    assert.equal(initial.status, 0, initial.stderr);
    git("init", "-q"); git("checkout", "-b", "release-test"); git("add", "."); git("commit", "-qm", "fixture");
    const dry = run(process.execPath, ["scripts/release.ts", "prepare", "probe=patch", "--dry-run"]);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /Existing note for Umer/);
    assert.match(dry.stdout, /FIX: fragment for Umer/);
    assert.match(dry.stdout, /delete packages\/probe\/changes\/umer.md/);
    assert.ok(existsSync(fragment), "dry-run preserves fragments");
    assert.match(dry.stdout, /repin examples\/consumer\/package.json/);
    assert.deepEqual(JSON.parse(readFileSync(examplePath, "utf8")), example, "dry-run preserves example pins");
    const explicit = run(process.execPath, ["scripts/release.ts", "prepare", "probe=patch", "a-consumer=minor", "--dry-run"]);
    assert.equal(explicit.status, 0, explicit.stderr);
    assert.match(explicit.stdout, /@byokit\/a-consumer 0.1.0 -> 0.2.0/);
    const first = run(process.execPath, ["scripts/release.ts", "prepare", "d-first=0.1.0", "--dry-run"]);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /@byokit\/d-first 0.1.0 -> 0.1.0/, "first release at the current version past a 0.0.0 placeholder");
    const unpublished = run(process.execPath, ["scripts/release.ts", "prepare", "e-new=0.1.0", "--dry-run"]);
    assert.equal(unpublished.status, 0, unpublished.stderr);
    assert.match(unpublished.stdout, /@byokit\/e-new 0.1.0 -> 0.1.0/, "a name never on npm (E404 on stdout) is a first release, not an error");
    // Configure the writer's commit identity locally in this throwaway repository.
    git("config", "user.name", "Umer"); git("config", "user.email", "umer@example.invalid"); git("config", "commit.gpgsign", "false");
    const prepared = run(process.execPath, ["scripts/release.ts", "prepare", "probe=patch"]);
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.equal(existsSync(fragment), false);
    const repinned = JSON.parse(readFileSync(examplePath, "utf8"));
    assert.deepEqual(repinned.dependencies, { "@byokit/probe": "0.1.1", "@byokit/b-range": ">=0.1.0", "@byokit/c-dev": "file:../../packages/c-dev" });
    assert.equal(repinned.devDependencies["@byokit/probe"], "0.1.1");
    assert.equal(repinned.peerDependencies["@byokit/a-consumer"], "0.1.1", "example follows the release cascade too");
    assert.equal(repinned.optionalDependencies["@byokit/probe"], "0.1.1");
    const peer = JSON.parse(readFileSync(join(dir, "packages/a-consumer/package.json"), "utf8"));
    assert.equal(peer.version, "0.1.1", "published exact peer-dependent receives a patch");
    assert.deepEqual(peer.peerDependencies, { "@byokit/probe": "0.1.1", "external-example": ">=1" });
    assert.deepEqual(peer.peerDependenciesMeta, peerMeta);
    const ranged = JSON.parse(readFileSync(join(dir, "packages/b-range/package.json"), "utf8"));
    assert.equal(ranged.version, "0.1.0");
    assert.equal(ranged.peerDependencies["@byokit/probe"], ">=0.1.0");
    const dev = JSON.parse(readFileSync(join(dir, "packages/c-dev/package.json"), "utf8"));
    assert.equal(dev.version, "0.1.0", "dev-only pin changes never release a dependent");
    assert.equal(dev.devDependencies["@byokit/probe"], "0.1.1");
    const lock = JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8"));
    assert.equal(lock.packages["packages/probe"].version, "0.1.1");
    assert.equal(lock.packages["packages/a-consumer"].peerDependencies["@byokit/probe"], "0.1.1");
    assert.ok(prepared.stdout.indexOf("## @byokit/probe") < prepared.stdout.indexOf("## @byokit/a-consumer"), "provider published before alphabetically earlier peer-dependent");
    assert.deepEqual(parseChangelog(readFileSync(cl, "utf8")).versions[0].bullets, [
      { kind: "FIX", text: "fragment for Umer." }, { kind: "other", text: "Existing note for Umer." },
    ]);
    assert.equal(git("status", "--porcelain").trim(), "");
    const publish = run(process.execPath, ["scripts/release.ts", "publish", "--dry-run"]);
    assert.equal(publish.status, 0, publish.stderr);
    assert.match(publish.stdout, /npm publish -w @byokit\/d-first --access public --tag next( --provenance)? --dry-run/, "publishConfig.tag reaches npm as --tag");
    assert.match(publish.stdout, /npm publish -w @byokit\/probe --access public( --provenance)? --dry-run/, "no publishConfig.tag keeps npm's latest");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// A throwaway repo whose local origin/main sits one merge ahead of a detached
// HEAD: the state the publish step of a workflow_run finds when a later merge
// landed on main after that run's CI passed.
function supersededRepo(): { dir: string; originMain: string; git: (...args: string[]) => string; run: (env?: Record<string, string>) => SpawnSyncReturns<string> } {
  // The bare remote sits outside the repo, where `git status` cannot see it.
  const parent = mkdtempSync(join(tmpdir(), "release-publish-"));
  const dir = join(parent, "repo");
  const bare = join(parent, "origin.git");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  copyFileSync(join(root, "scripts/release.ts"), join(dir, "scripts/release.ts"));
  assert.equal(spawnSync("git", ["init", "-q", "--bare", bare]).status, 0);
  const git = (...args: string[]): string => {
    const r = spawnSync("git", ["-c", "user.name=Umer", "-c", "user.email=umer@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  git("remote", "add", "origin", bare);
  git("add", "."); git("commit", "-qm", "base");
  git("push", "-q", "origin", "main");
  git("commit", "-q", "--allow-empty", "-m", "later merge on main");
  const originMain = git("rev-parse", "HEAD");
  git("push", "-q", "origin", "main");
  git("checkout", "-q", "HEAD~1"); // detached at the sha CI passed, before the later merge
  const run = (env: Record<string, string> = {}): SpawnSyncReturns<string> =>
    spawnSync(process.execPath, ["scripts/release.ts", "publish"], { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } });
  return { dir, originMain, git, run };
}

test("publish CLI exits clean when a later merge supersedes the workflow_run sha", () => {
  const repo = supersededRepo();
  try {
    const superseded = repo.run({ GITHUB_EVENT_NAME: "workflow_run" });
    assert.equal(superseded.status, 0, superseded.stderr);
    assert.match(superseded.stdout, new RegExp(`superseded by ${repo.originMain}`));
  } finally { rmSync(repo.dir, { recursive: true, force: true }); }
});

test("publish CLI still fails every other HEAD mismatch", () => {
  const repo = supersededRepo();
  try {
    // A manual dispatch on the same stale sha still fails, as a head not on main does.
    for (const env of [{ GITHUB_EVENT_NAME: "workflow_dispatch" }, { GITHUB_EVENT_NAME: "" }]) {
      const refused = repo.run(env);
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /publish refuses: HEAD != origin\/main/);
    }
    repo.git("checkout", "-q", "-b", "off-main");
    repo.git("commit", "-q", "--allow-empty", "-m", "commit never merged");
    const offMain = repo.run({ GITHUB_EVENT_NAME: "workflow_run" });
    assert.equal(offMain.status, 1);
    assert.match(offMain.stderr, /publish refuses: HEAD != origin\/main/);
  } finally { rmSync(repo.dir, { recursive: true, force: true }); }
});
