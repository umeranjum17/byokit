import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeRoute } from '../src/route.ts';

test('describeRoute names the route a dial address takes', () => {
  assert.equal(describeRoute('wss://desk.tail0de54.ts.net'), 'Tailscale');
  assert.equal(describeRoute('ws://100.64.0.1:8792'), 'Tailscale');
  assert.equal(describeRoute('ws://100.128.0.1:8792'), 'Hosted VPS / custom relay');
  assert.equal(describeRoute('wss://quiet-fox.trycloudflare.com'), 'Cloudflare tunnel');
  assert.equal(describeRoute('ws://192.168.1.8:8792'), 'Local or private network');
  assert.equal(describeRoute('ws://localhost:8792'), 'Local or private network');
  assert.equal(describeRoute('https://192.168.1.8'), 'Hosted VPS / custom relay');
  assert.equal(describeRoute('wss://relay.example.com/link/v1/abc'), 'Hosted VPS / custom relay');
  assert.equal(describeRoute('not a url'), undefined);
  assert.equal(describeRoute(undefined), undefined);
});
