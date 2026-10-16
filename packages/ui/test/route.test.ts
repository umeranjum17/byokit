import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeRoute } from '../src/route.ts';

test('describeRoute parses pairing links on React Native, where URL.canParse is missing and hostname is empty for ws://', () => {
  const RealURL = globalThis.URL;
  // The RN 0.83 polyfill: no canParse, and nothing parsed past the scheme for ws://.
  class PolyfillURL {
    static canParse: undefined;
    protocol: string;
    hostname = '';
    constructor(url: string) {
      const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(url);
      if (!m) throw new TypeError('Invalid URL');
      this.protocol = `${m[1].toLowerCase()}:`;
    }
  }
  (globalThis as unknown as { URL: unknown }).URL = PolyfillURL;
  try {
    assert.equal((globalThis.URL as unknown as { canParse?: unknown }).canParse, undefined);
    assert.equal(new globalThis.URL('wss://desk.tail0de54.ts.net').hostname, '');
    assert.equal(describeRoute('wss://desk.tail0de54.ts.net'), 'Tailscale');
    assert.equal(describeRoute('ws://100.64.0.1:8792'), 'Private network');
    assert.equal(describeRoute('ws://100.64.0.1:8792', 'direct'), 'Tailscale');
    assert.equal(describeRoute('ws://192.168.1.8:8792'), 'Same Wi-Fi');
    assert.equal(describeRoute('ws://localhost:8792'), 'Same Wi-Fi');
    assert.equal(describeRoute('wss://quiet-fox.trycloudflare.com'), 'Temporary public link');
    assert.equal(describeRoute('wss://relay.example.com/link/v1/abc'), 'Away from home');
    assert.equal(describeRoute('not a url'), undefined);
    assert.equal(describeRoute(undefined), undefined);
  } finally {
    globalThis.URL = RealURL;
  }
});

test('key entry card states contain only words and never retain the submitted key', async () => {
  const { keyStep, keyView } = await import('../src/key.ts');
  const words = (key: string) => key === 'key.label' ? 'API key (billed per use)' : key;
  const checking = keyStep('entry', { type: 'submit' });
  assert.equal(checking, 'checking');
  assert.equal(keyView(checking, words).busy, true);
  const invalid = keyStep(checking, { type: 'result', result: 'invalid' });
  assert.equal(keyView(invalid, words).editable, true);
  assert.equal(keyStep(invalid, { type: 'edit' }), 'entry');
  assert.equal(keyStep(checking, { type: 'result', result: 'ok' }), 'ok');
  const workspace = keyStep(checking, { type: 'result', result: 'workspace' });
  assert.deepEqual([keyView(workspace, words).message, keyView(workspace, words).editable], ['key.workspace', false]);
  assert.equal(keyStep(workspace, { type: 'submit' }), 'checking', 'the pick submits again');
  assert.equal(keyView('not_included', words).message, 'key.notIncluded');
  assert.equal(keyView('ok', words).label, 'API key (billed per use)');
});
