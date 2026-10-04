import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '../../test-support.ts';

async function consumer(entry: string) {
  return build({ stdin: { contents: `
    import * as kit from '${entry}';
    import { runFixture } from './rn-fixture.ts';
    globalThis.result = runFixture();
    globalThis.exports = Object.keys(kit);
    if (typeof print === 'function') print(JSON.stringify({ result: globalThis.result,
      runtime: typeof HermesInternal === 'object' ? 'Hermes' : 'other' }));`,
    resolveDir: import.meta.dirname, sourcefile: 'phone.ts' }, bundle: true, platform: 'browser',
    conditions: ['react-native'], format: 'iife', target: 'es2015', write: false, metafile: true, logLevel: 'silent' });
}
function verify(result: any) {
  assert.equal(result.known.tokens, 25);
  assert.equal(result.known.week.remaining, 75);
  assert.equal(result.unknown.tokens, 25);
  assert.equal(result.unknown.unknownCalls, 1);
  assert.equal('remaining' in result.unknown.week, false);
  assert.equal(result.history.calls[1].billing, 'subscription');
  assert.equal(result.history.calls[0].billingLabel, "Person's API bill");
  assert.equal(result.history.calls[2].billingLabel, "Person's own plan");
  assert.deepEqual(result.runs.map((run: any) => run.runId), ['api-run', 'run']);
  assert.equal(result.runs[0].tokens.total, 20);
  assert.equal(result.run.runId, 'run');
  assert.equal(result.run.calls.length, 2);
  assert.equal(result.run.tokens.provenance, 'unknown');
  assert.equal(result.run.unpricedCalls, 2);
  assert.ok(result.run.calls.every((call: any) => call.lane === 'host-lane' && call.route === 'host-route'));

  assert.equal('cost' in result.history.calls[1], false);
  assert.equal(result.history.calls[2].tokens.provenance, 'unknown');
  assert.deepEqual(result.history.costs, [{ amount: 0.000056, currency: 'USD', billing: 'api',
    label: "Person's API bill", basis: 'app-prices', estimated: true }]);
  assert.equal(result.history.unpricedCalls, 2);
  assert.equal(result.room.left, 75);
  assert.equal(result.blocked.left, 0);
  assert.equal(result.blocked.limited, true);
}

test('built RN condition and explicit entry expose local accounting without Node adapters', async () => {
  for (const entry of ['@byokit/usage', '@byokit/usage/react-native']) {
    const bundle = await consumer(entry);
    assert.ok(Object.keys(bundle.metafile!.inputs).some((path) => path.endsWith('dist/rn.js')));
    assert.deepEqual(Object.keys(bundle.metafile!.inputs).filter((path) => /node:|providers|identity|\/store\.js$/.test(path)), []);
    const sandbox: any = {};
    runInNewContext(bundle.outputFiles[0].text, sandbox);
    verify(JSON.parse(JSON.stringify(sandbox.result)));
    assert.equal(sandbox.exports.includes('usage'), false);
    assert.equal(sandbox.exports.includes('fileUsageStore'), false);
    assert.ok(sandbox.exports.includes('tokenLedger'));
  }
});

test('built React Native consumer returns the same contract in Hermes', { skip: !process.env.BYOKIT_HERMES }, async () => {
  const bundle = await consumer('@byokit/usage');
  const file = join(scratchDir('usage-hermes'), 'consumer.js');
  // The standalone legacy CLI needs the preset's v0 profile, which lowers classes.
  // This is not qualification of an Expo SDK runtime.
  const require = createRequire(import.meta.url);
  const { transformSync } = require('@babel/core');
  const transformed = transformSync(bundle.outputFiles[0].text, {
    filename: file, babelrc: false, configFile: false, sourceType: 'script', ast: true,
    caller: { name: 'metro', platform: 'android', engine: 'hermes', bundler: 'metro', isDev: false },
    presets: [[require('babel-preset-expo'), { enableBabelRuntime: false, unstable_transformProfile: 'hermes-v0' }]],
  });
  assert.ok(transformed.ast);
  const classNodes = JSON.stringify(transformed.ast).match(/"type":"Class(?:Declaration|Expression)"/g) ?? [];
  assert.equal(classNodes.length, 0);
  console.log('Hermes fixture: hermes-v0 transform; remaining class syntax: 0');
  writeFileSync(file, transformed.code);
  const output = execFileSync(process.env.BYOKIT_HERMES!, [file], { encoding: 'utf8' });
  const { result, runtime } = JSON.parse(output.trim());
  assert.equal(runtime, 'Hermes');
  verify(result);
  console.log(`Hermes built-kit output: ${JSON.stringify(result)}`);
});
