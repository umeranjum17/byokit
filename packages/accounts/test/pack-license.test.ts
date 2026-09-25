import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

test("every package tarball includes LICENSE", () => {
  for (const name of readdirSync(join(root, "packages"))) {
    const directory = join(root, "packages", name);
    try {
      readdirSync(directory);
    } catch {
      continue;
    }
    const packageJson = join(directory, "package.json");
    if (!existsSync(packageJson)) continue;
    const manifest: { name: string } = JSON.parse(readFileSync(packageJson, "utf8"));
    const output = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: directory, encoding: "utf8" }));
    const packed = Array.isArray(output) ? output[0] : output[manifest.name];
    assert(packed.files.some((file: { path: string }) => file.path === "LICENSE"), `${manifest.name} tarball is missing LICENSE`);
  }
});
