// The device entry is portable (section 9): it bundles for a browser and for the React Native condition, and
// nothing from Node can sneak in — esbuild refuses Node built-ins when bundling for a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const entry = new URL('../src/device.ts', import.meta.url).pathname;

test('./device bundles for a browser with nothing from Node, and the bundle imports', async () => {
  const result = await build({ entryPoints: [entry], bundle: true, platform: 'browser', format: 'esm', write: false, logLevel: 'silent' });
  assert.equal(result.errors.length, 0);
  assert.doesNotMatch(result.outputFiles[0].text, /node:/, 'a node:* import reached the device entry');
  const device = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
  assert.equal(typeof device.openclawDevice, 'function');
  assert.equal(typeof device.openNotice, 'function');
  assert.equal(typeof device.readAgentUsage, 'function');
  assert.equal(typeof device.agentUsageOf, 'function');
});

test('./device bundles under the react-native condition with nothing from Node', async () => {
  const result = await build({ entryPoints: [entry], bundle: true, platform: 'browser', conditions: ['react-native'], format: 'esm', write: false, logLevel: 'silent' });
  assert.equal(result.errors.length, 0);
  assert.doesNotMatch(result.outputFiles[0].text, /node:/, 'a node:* import reached the device entry');
});
