import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectedWords, describeRoute, routeChoices, routeShort } from '../src/route.ts';

test('describeRoute names the route a dial address takes', () => {
  assert.equal(describeRoute('wss://desk.tail0de54.ts.net'), 'Tailscale');
  assert.equal(describeRoute('ws://100.64.0.1:8792'), 'Private network');
  assert.equal(describeRoute('ws://100.64.0.1:8792', 'direct'), 'Tailscale');
  assert.equal(describeRoute('ws://100.90.0.4:8792', 'private'), 'Private network');
  assert.equal(describeRoute('ws://100.90.0.4:8792', 'tailscale'), 'Tailscale');
  assert.equal(describeRoute('ws://100.64.0.1.example.com'), 'Your own server');
  assert.equal(describeRoute('ws://192.168.1.8.example.com'), 'Your own server');
  assert.equal(describeRoute('ws://100.128.0.1:8792'), 'Your own server');
  assert.equal(describeRoute('wss://quiet-fox.trycloudflare.com'), 'Temporary public link');
  assert.equal(describeRoute('ws://192.168.1.8:8792'), 'Same Wi-Fi');
  assert.equal(describeRoute('ws://192.168.1.8:8792', 'lan'), 'Same Wi-Fi');
  assert.equal(describeRoute('ws://localhost:8792'), 'Same Wi-Fi');
  assert.equal(describeRoute('https://192.168.1.8'), 'Your own server');
  assert.equal(describeRoute('wss://relay.example.com/link/v1/abc'), 'Away from home');
  assert.equal(describeRoute('not a url'), undefined);
  assert.equal(describeRoute(undefined), undefined);
});

test('the connected line names the route just dialled, plainly', () => {
  assert.equal(connectedWords('Kitchen computer', 'ws://192.168.1.8:8792'), 'Connected to Kitchen computer - same Wi-Fi.');
  assert.equal(connectedWords('Kitchen computer', 'wss://desk.tail0de54.ts.net'), 'Connected to Kitchen computer - Tailscale.');
  assert.equal(connectedWords('Kitchen computer', 'wss://relay.example.com/link/v1/abc'), 'Connected to Kitchen computer - away from home.');
  assert.equal(connectedWords('Kitchen computer', 'not a url'), 'Connected to Kitchen computer.');
  assert.equal(connectedWords('Kitchen computer', undefined), 'Connected to Kitchen computer.');
  assert.equal(routeShort(describeRoute('wss://quiet-fox.trycloudflare.com')), 'a temporary public link');
  assert.equal(routeShort(undefined), undefined);
});

test('route words never carry addresses, protocols or relay jargon', () => {
  const banned = /ws:\/\/|wss:\/\/|https?:\/\/|\bTLS\b|relay|credential|\d+\.\d+\.\d+\.\d+/i;
  for (const c of routeChoices()) for (const s of [c.title, c.sentence, c.needs]) assert.doesNotMatch(s, banned, s);
  for (const url of ['wss://desk.tail0de54.ts.net', 'ws://192.168.1.8:8792', 'ws://100.64.0.1:8792',
    'wss://quiet-fox.trycloudflare.com', 'wss://relay.example.com/link/v1/abc', 'wss://umer.example:8792/link']) {
    const route = describeRoute(url)!;
    assert.doesNotMatch(route, banned, route);
    assert.doesNotMatch(connectedWords('Kitchen computer', url), banned);
  }
});

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

test('routeChoices is the one word table: every route code once, in recommendation order', () => {
  const choices = routeChoices();
  assert.deepEqual(choices.map((c) => c.code), ['tailscale', 'tailscale-direct', 'private', 'lan', 'cloudflare', 'external']);
  for (const c of choices) {
    assert.ok(c.title.length > 0 && c.sentence.length > 0 && c.needs.length > 0, c.code);
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
  assert.equal(keyView('not_included', words).message, 'key.notIncluded');
  assert.equal(keyView('ok', words).label, 'API key (billed per use)');
});
