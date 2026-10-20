// The kit on a phone: its main entry bundled as React Native's bundler would (the react-native condition, so accounts'
// portable entry), checked for anything from Node, then run where there is no process, Buffer or require and where
// AbortSignal has no throwIfAborted (as on Hermes): sign in by device code and answer a turn with a stop signal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { mockOpenAI } from '@byokit/accounts/testing';

test('the main entry bundles for React Native with nothing from Node, and a turn answers there', async (t) => {
  const openai = await mockOpenAI();
  t.after(() => openai.close());
  const bundle = await build({
    stdin: {
      contents: `import { Accounts, memoryStore, portable } from '@byokit/accounts';
        import { memoryLog, PhoneSession } from '@byokit/phone';
        globalThis.run = async (base, approve) => {
          const accounts = new Accounts({ authBase: base, apiBase: base, store: () => memoryStore() }, portable);
          const shown = await accounts.login('Umer', 'chatgpt');
          if (!shown?.code) throw new Error('no code: ' + JSON.stringify(shown));
          await approve(shown.code);
          await accounts.finished('Umer', 'chatgpt');
          const session = await PhoneSession.open({ accounts, member: 'Umer', account: 'chatgpt', instructions: 'Be brief.', log: memoryLog() });
          const turn = await session.send('hello from the phone', { signal: new AbortController().signal });
          return { turn, account: await session.account() };
        };`,
      resolveDir: import.meta.dirname, sourcefile: 'phone.ts',
    },
    bundle: true, platform: 'browser', format: 'iife', conditions: ['react-native'], write: false, logLevel: 'silent', metafile: true,
  });
  const inputs = Object.keys(bundle.metafile!.inputs);
  assert.deepEqual(inputs.filter((f) => /node:|pi-ai|accounts\/dist\/index\.js/.test(f)), [], 'nothing from Node or Pi');
  assert.ok(inputs.some((f) => f.endsWith('accounts/dist/portable.js')), 'accounts resolves to its portable entry');

  // Hermes ships AbortSignal (with any and timeout) but not throwIfAborted.
  const original = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'throwIfAborted')!;
  Reflect.deleteProperty(AbortSignal.prototype, 'throwIfAborted');
  t.after(() => Object.defineProperty(AbortSignal.prototype, 'throwIfAborted', original));
  const sandbox: any = { setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, fetch, Response, Headers, Request,
    TextDecoder, TextEncoder, URL, URLSearchParams, crypto: globalThis.crypto, atob, btoa, AbortController, AbortSignal,
    EventTarget, Event, console, JSON, Object, Math, Date, Promise };
  runInNewContext(bundle.outputFiles[0].text, sandbox);
  const { turn, account } = await sandbox.run(openai.base, (code: string) => openai.approve(code));
  assert.equal(turn.state, 'done', turn.words);
  assert.equal(turn.answer, 'You said: hello from the phone');
  assert.equal(account.words, 'Uses your ChatGPT plan.');
});
