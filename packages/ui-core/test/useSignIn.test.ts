// useSignIn with and without a starter: the sheet begins as it opens when `start` is given, and only watches
// when something else (a CLI in a Herdr tab) starts the sign-in. The probe mounts on the local react stub (no
// renderer is vendored), bundled with esbuild like portable.test.ts does; every mount is unmounted so no poll
// interval outlives its test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const probe = `
import { useSignIn } from 'useSignIn-src';
import { renderHook } from 'react';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function scenario(withStart) {
  const started = [];
  let reads = 0;
  let hook;
  try {
    hook = renderHook(() => useSignIn({
      read: async () => { reads++; return null; },
      ...(withStart ? { start: async (body) => { started.push(body); } } : {}),
      cancel: async () => {},
      ms: 5,
    }));
    await sleep(25);
    const phase = hook.result().phase;
    const beganOnOpen = started.length;
    hook.result().start();
    return { started, beganOnOpen, reads, phase };
  } finally {
    hook?.unmount();
  }
}
`;

async function scenario(withStart: boolean): Promise<{ beganOnOpen: number; reads: number; phase: string }> {
  const out = await build({
    stdin: { contents: probe, resolveDir: new URL('.', import.meta.url).pathname, loader: 'ts' },
    bundle: true,
    alias: {
      'useSignIn-src': new URL('../src/useSignIn.ts', import.meta.url).pathname,
      react: new URL('./react-stub.ts', import.meta.url).pathname,
    },
    format: 'esm',
    platform: 'node',
    write: false,
    logLevel: 'silent',
  });
  const mod = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles![0].text).toString('base64')}`);
  return mod.scenario(withStart) as Promise<{ beganOnOpen: number; reads: number; phase: string }>;
}

test('useSignIn begins as the sheet opens when start is given, and keeps polling', async () => {
  const r = await scenario(true);
  assert.equal(r.beganOnOpen, 1);
  assert.ok(r.reads >= 2, `expected polls, saw ${r.reads} reads`);
  assert.equal(r.phase, 'opening');
});

test('useSignIn without start never begins, and still watches the account', async () => {
  const r = await scenario(false);
  assert.equal(r.beganOnOpen, 0);
  assert.ok(r.reads >= 2, `expected polls, saw ${r.reads} reads`);
  assert.equal(r.phase, 'opening');
});
