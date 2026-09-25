import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { WebSocketServer } from 'ws';
import { Host, keyPair } from '../src/index.ts';

test('React Native device pairs and requests without Node globals or TextDecoder', async () => {
  const bundle = await build({
    stdin: {
      contents: `import { DeviceLink, pairWithOffer } from '../src/index.ts';
        globalThis.result = (async () => {
          const words = [];
          const grant = await pairWithOffer(globalThis.offer, { name: 'Phone', onWords: (w) => words.push(w) });
          const link = new DeviceLink(grant);
          const answer = await link.request('get.state');
          link.stop();
          return { words: words[0], answer };
        })();`,
      resolveDir: import.meta.dirname,
      sourcefile: 'react-native-client.ts',
    },
    bundle: true, platform: 'browser', format: 'iife', conditions: ['react-native'],
    mainFields: ['react-native', 'browser', 'module', 'main'], write: false, logLevel: 'silent',
  });
  let hostWords = '';
  const host = await Host.open({
    keys: keyPair(), name: 'Kitchen computer', confirm: (p) => { hostWords = p.words; return true; },
    handle: (r) => ({ op: r.op }),
  });
  const server = createServer();
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => host.accept(ws));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/link`;
  try {
    const sandbox: any = {
      WebSocket, URL, TextEncoder, setTimeout, clearTimeout, console,
      crypto: { getRandomValues: (array: Uint8Array) => webcrypto.getRandomValues(array) },
      offer: host.offer({ role: 'control', urls: [url] }).text,
    };
    assert.equal(runInNewContext('typeof TextDecoder + ":" + typeof Buffer + ":" + typeof process + ":" + typeof require', sandbox),
      'undefined:undefined:undefined:undefined');
    runInNewContext(bundle.outputFiles[0].text, sandbox);
    let timer: ReturnType<typeof setTimeout>;
    const result = await Promise.race([sandbox.result, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('device timed out')), 5000); })])
      .finally(() => clearTimeout(timer)) as any;
    assert.equal(result.words, hostWords);
    assert.deepEqual(JSON.parse(JSON.stringify(result.answer)), { op: 'get.state' });
  } finally {
    host.close();
    wss.close();
    server.close();
  }
});
