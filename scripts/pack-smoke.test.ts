import { strict as assert } from "node:assert";
import { test } from "node:test";
import { smokeFailures } from "./pack-smoke.ts";

test("browser-only and subpath import failures fail smoke even when every package passed", () => {
  const results = new Map([["@byokit/accounts", "pass"], ["@byokit/herdr", "pass"]]);
  assert.deepEqual(smokeFailures(results), []);
  results.set("@byokit/accounts [browser]", "FAIL: browser import failed");
  results.set("@byokit/herdr/device", "FAIL: default import failed");
  assert.deepEqual(smokeFailures(results), ["@byokit/accounts [browser]", "@byokit/herdr/device"]);
});
