import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowedFailure, analyze, examples, snapshot } from "./readme-check.ts";

test("extracts TS fences with original line locations, skipping other fenced content", () => {
  assert.deepEqual(examples('# Demo\n\n```sh\nnode main\n```\n\n```ts\nconst x = 1;\n```\n~~~typescript\nconst y = 2;\n~~~'), [
    { line: 8, code: 'const x = 1;' }, { line: 11, code: 'const y = 2;' },
  ]);
  assert.deepEqual(examples('````markdown\n```ts\nnot an example\n```\n````'), []);
  assert.throws(() => examples('```ts\nunfinished'), /unclosed fence at line 1/);
});


test("a baseline tolerates only the exact old failure, while fixed and new examples remain checked", () => {
  const dir = mkdtempSync(join(tmpdir(), "readme-example-"));
  const readme = join(dir, "README.md");
  try {
    writeFileSync(readme, "```ts\nconst value: number = 'bad';\n```\n");
    const [old] = analyze([readme]);
    assert.ok(old.diagnostics.length > 0);
    const baseline = [{ readme: old.readme, block: old.block, snapshot: snapshot(old), reason: "Existing fixture gap." }];
    assert.equal(allowedFailure(old, baseline), true);
    assert.equal(allowedFailure({ ...old, code: old.code + "\nmissing();" }, baseline), false);
    assert.equal(allowedFailure({ ...old, diagnostics: [...old.diagnostics, { start: 0, code: 2304, message: "New failure" }] }, baseline), false);
    writeFileSync(readme, "```ts\nconst value: number = 1;\n```\n```ts\nmissing();\n```\n");
    const [fixed, added] = analyze([readme]);
    assert.deepEqual(fixed.diagnostics, []);
    assert.ok(added.diagnostics.length > 0);
    assert.equal(allowedFailure(added, baseline), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
