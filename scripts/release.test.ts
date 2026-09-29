// Tests for scripts/release.ts: pure changelog, version, cascade, order and
// lint functions. No network, fixtures as strings (plus the nine real
// CHANGELOGs on disk).
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  bump,
  compareSemver,
  extractNotes,
  lint,
  parseChangelog,
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
  assert.equal(parseChangelog(changelog("openclaw")).versions[0]?.version, "0.1.0");
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
  assert.ok(relayBullets.includes("- Depends on @byokit/link 0.3.2."));
  assert.ok(relayBullets.some((l) => l.includes("(from @byokit/link 0.3.2)") && l.startsWith("- SECURITY:")));
  const kitBullets = plan.bullets.get("openclaw") ?? [];
  assert.ok(kitBullets.includes("- Depends on @byokit/link 0.3.2."));
  assert.ok(kitBullets.every((l) => !l.includes("(from @byokit/")), "private kit gets Depends lines only");
});

test("planCascade re-pins a devDependency without a bump", () => {
  const pkgs = cascadeFixture();
  const plan = planCascade(pkgs, new Map([["ui-core", "0.2.1"]]), new Set(["link", "relay", "ui-core"]));
  assert.ok(!plan.versions.has("openclaw"));
  assert.ok(plan.pins.some((p) => p.pkg === "openclaw" && p.dep === "ui-core" && p.to === "0.2.1"));
  assert.deepEqual(plan.bullets.get("openclaw"), ["- Depends on @byokit/ui-core 0.2.1."]);
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
