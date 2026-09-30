import { strict as assert } from "node:assert";
import { test } from "node:test";
import { examples } from "./readme-check.ts";

test("extracts TS fences with original line locations, skipping other fenced content", () => {
  assert.deepEqual(examples('# Demo\n\n```sh\nnode main\n```\n\n```ts\nconst x = 1;\n```\n~~~typescript\nconst y = 2;\n~~~'), [
    { line: 8, code: 'const x = 1;' }, { line: 11, code: 'const y = 2;' },
  ]);
  assert.deepEqual(examples('````markdown\n```ts\nnot an example\n```\n````'), []);
  assert.throws(() => examples('```ts\nunfinished'), /unclosed fence at line 1/);
});
