// Tests for scripts/release.ts: pure changelog, version, cascade, order and
// lint functions. No network, fixtures as strings (plus the nine real
// CHANGELOGs on disk).
import { strict as assert } from "node:assert";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  bump,
  compareSemver,
  extractNotes,
  lint,
  parseChangelog,
  prepareChangelog,
  shippedPath,
  planCascade,
  rollUnreleased,
  topoOrder,
  type CascadePkg,
} from "./release.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const changelog = (dir: string): string => readFileSync(join(root, "packages", dir, "CHANGELOG.md"), "utf8");

test("bump patches and minors, refusing major and prereleases", () => {
  assert.equal(bump("0.3.1", "patch"), "0.3.2");
  assert.equal(bump("0.3.1", "minor"), "0.4.0");
  assert.equal(bump("0.1.3", "patch"), "0.1.4");
  assert.throws(() => bump("0.3.1", "major"), /refusing/);
  assert.throws(() => bump("0.3.1-rc.1", "patch"), /bad version/);
  assert.throws(() => bump("0.3.1", "1.0.0-beta"), /refusing/);
  assert.ok(compareSemver("0.3.2", "0.3.1") > 0);
  assert.ok(compareSemver("0.3.1", "0.3.1") === 0);
  assert.ok(compareSemver("0.2.0", "0.10.0") < 0);
});

test("parseChangelog reads all nine real changelogs", () => {
  for (const dir of ["accounts", "decide", "herdr", "link", "reach", "relay", "seal", "ui-core"]) {
    const parsed = parseChangelog(changelog(dir));
    assert.ok(parsed.versions.length > 0, `${dir} has versions`);
    assert.ok(
      parsed.versions.every((s) => /^\d+\.\d+\.\d+$/.test(s.version as string)),
      `${dir} versions are semver`,
    );
  }
  // link's normalized SECURITY bullet parses with its kind, wherever its release sits
  const link = parseChangelog(changelog("link"));
  const sec = link.versions.flatMap((s) => s.bullets).find((b) => b.kind === "SECURITY");
  assert.ok(sec && sec.text.length > 0);
  // the kit's first release rolled its notes into 0.1.0
  assert.ok(parseChangelog(changelog("openclaw")).versions.some((section) => section.version === "0.1.0"));
});

test("parseChangelog accepts the legacy bare SECURITY line and continuations", () => {
  const parsed = parseChangelog(
    "# Changelog\n\n## Unreleased\n\n## 0.3.1\n\nSECURITY: bare legacy line\n\n- FIX: wrapped\n  onto two lines\n\n- plain\n",
  );
  const bullets = parsed.versions[0].bullets;
  assert.deepEqual(bullets[0], { kind: "SECURITY", text: "bare legacy line" });
  assert.deepEqual(bullets[1], { kind: "FIX", text: "wrapped onto two lines" });
  assert.deepEqual(bullets[2], { kind: "other", text: "plain" });
});

test("rollUnreleased renames and inserts a fresh section", () => {
  const out = rollUnreleased("# Changelog\n\n## Unreleased\n\n- FIX: x\n", "0.3.2", "2026-10-01");
  assert.equal(out, "# Changelog\n\n## Unreleased\n\n## 0.3.2 (2026-10-01)\n\n- FIX: x\n");
  assert.throws(() => rollUnreleased("# Changelog\n\n## 0.1.0\n", "0.1.1", "2026-10-01"), /no ## Unreleased/);
});

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

test("lint fails an empty Unreleased under a src change, passes on version bump", () => {
  const changelogs: Record<string, string | null> = {
    link: "# Changelog\n\n## Unreleased\n\n## 0.3.1\n\n- SECURITY: x\n",
  };
  const files = { link: ["dist", "SECURITY.md", "CHANGELOG.md"] };
  const bad = lint({ changelogs, files, srcChanged: ["link"], depsChanged: [], versionChanged: [] });
  assert.ok(bad.some((e) => e.includes("Unreleased bullet")), bad.join("\n"));
  const ok = lint({ changelogs, files, srcChanged: ["link"], depsChanged: [], versionChanged: ["link"] });
  assert.deepEqual(ok, []);
});

test("lint enforces changelog shape and shipped files", () => {
  const errs = lint({
    changelogs: {
      a: null,
      b: "no title\n",
      c: "# Changelog\n\n## 0.1.0\n\n- x\n",
      d: "# Changelog\n\n## Unreleased\n\n## 0.2.0\n\n## 0.1.0\n\n- x\n",
      e: "# Changelog\n\n## Unreleased\n\n## 0.1.0\n\n- SECURITY:\n",
    },
    files: { a: [], b: [], c: [], d: ["dist"], e: ["dist", "CHANGELOG.md"] },
    srcChanged: [],
    depsChanged: [],
    versionChanged: [],
  });
  assert.ok(errs.some((e) => e.startsWith("a: missing")), errs.join("\n"));
  assert.ok(errs.some((e) => e.startsWith("b:")), errs.join("\n"));
  assert.ok(errs.some((e) => e.includes("first ## heading")), errs.join("\n"));
  assert.ok(errs.some((e) => e.includes("not descending") === false && e.includes("d:")), errs.join("\n"));
  assert.ok(errs.some((e) => e.includes("files must contain")), errs.join("\n"));
  assert.ok(errs.some((e) => e.includes("empty SECURITY")), errs.join("\n"));
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

test("shipped paths include engines, plugins, policies, schemas and native metadata", () => {
  for (const path of ["engine/pin.json", "plugin/gate.js", "policy/tools.json", "schema/v1.json", "app.plugin.js", "android/src/main.kt", "README.md"]) {
    assert.equal(shippedPath(path, ["dist", "engine", "plugin", "policy", "schema", "app.plugin.js", "android", "!android/build"]), true, path);
  }
  assert.equal(shippedPath("android/build/output.jar", ["android", "!android/build"]), false);
  assert.equal(shippedPath("test/contract.test.ts", ["dist"]), false);
  assert.equal(shippedPath("src/new.ts", ["dist"]), true);
  assert.equal(shippedPath("schema/a.json", ["schema/*.json"]), true);
});

test("published shipped changes require a real increase and release notes, private changes need notes", () => {
  const input = {
    changelogs: { link: "# Changelog\n\n## Unreleased\n\n- FIX: a fix.\n\n## 0.3.1\n\n- Initial.\n" },
    files: { link: ["dist", "CHANGELOG.md"] }, srcChanged: ["link"], depsChanged: [], versionChanged: [] as string[],
    versions: { link: { before: "0.3.1", after: "0.3.1", isPrivate: false } },
  };
  assert.ok(lint(input).some((e) => e.includes("version increase")));
  input.versions.link.after = "0.3.0";
  input.versionChanged = ["link"];
  assert.ok(lint(input).some((e) => e.includes("version increase")));
  input.versions.link.after = "0.3.2";
  assert.ok(lint(input).some((e) => e.includes("non-empty changelog section")));
  input.changelogs.link = prepareChangelog(input.changelogs.link, "0.3.2", "2026-09-30", []);
  assert.deepEqual(lint(input), []);
  input.versions.link = { before: "0.3.2", after: "0.3.2", isPrivate: true };
  input.versionChanged = [];
  assert.ok(lint(input).some((e) => e.includes("Unreleased bullet")));
});


test("release lint CLI rejects a shipped schema without a bump and accepts noted releases on PR and push ranges", () => {
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
    writeFileSync(changelogPath, changelog);
    writeFileSync(join(dir, "packages/probe/schema/v1.json"), "{}");
    git("init", "-q"); git("add", "."); git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(dir, "packages/probe/schema/v1.json"), '{"changed":true}');
    git("add", "."); git("commit", "-qm", "change schema");
    const lintArgs = ["scripts/release.ts", "lint", "--base", base];
    const rejected = run(process.execPath, lintArgs);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /without a version increase/);
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
