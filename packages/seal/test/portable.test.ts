import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

test('React Native/browser entry bundles and works without Node globals', async () => {
  const bundle = await build({
    stdin: {
      contents: `import { boxKeyPair, boxPublicKey, box, openAuthBox, sealBox, openBox, sealNotice, openNotice, sealSecretBox, openSecretBox, signingKeyPairFromSeed, signDetached, verifyDetached } from '../src/index.ts';
        const key = new Uint8Array(32); const message = new TextEncoder().encode('hello');
        const cipher = sealSecretBox(message, key);
        const pair = signingKeyPairFromSeed(key);
        const sender = boxKeyPair(), recipient = boxKeyPair();
        const auth = openAuthBox(box(message, recipient.publicKey, sender.secretKey), boxPublicKey(sender.secretKey), recipient.secretKey);
        const anonymous = openBox(sealBox(message, recipient.publicKey), recipient.secretKey);
        const notice = openNotice(sealNotice({ kind: 'done' }, recipient.publicKey), recipient.secretKey);
        globalThis.result = { auth: new TextDecoder().decode(auth), anonymous: new TextDecoder().decode(anonymous), notice, text: new TextDecoder().decode(openSecretBox(cipher, key)), signed: verifyDetached(message, signDetached(message, pair.secretKey), pair.publicKey) };`,
      resolveDir: import.meta.dirname,
      sourcefile: 'portable-client.ts',
    },
    bundle: true, platform: 'browser', format: 'iife', conditions: ['react-native'],
    mainFields: ['react-native', 'browser', 'module', 'main'], write: false, logLevel: 'silent',
  });
  const sandbox: any = { TextEncoder, TextDecoder, Uint8Array, crypto: { getRandomValues: (bytes: Uint8Array) => webcrypto.getRandomValues(bytes) } };
  assert.equal(runInNewContext('typeof Buffer + ":" + typeof process + ":" + typeof require', sandbox), 'undefined:undefined:undefined');
  runInNewContext(bundle.outputFiles[0].text, sandbox);
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.result)), { auth: 'hello', anonymous: 'hello', notice: { kind: 'done' }, text: 'hello', signed: true });
});
