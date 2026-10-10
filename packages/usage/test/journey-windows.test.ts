// A host shows both usage windows per account, each with its reset and a reading age, from the built
// public surface only. This is the MU-S1 journey: `usage().read()` replays the shared synthetic payloads
// through an injected transport (mocked `fetch` for Claude, the fake app-server for Codex), then the built
// `windowsView` (from `@byokit/usage/view`) lists the windows tightest first with their millisecond reset,
// a line and a reset line, plus an age taken only from `Reading.at`. The wording and the age cases come
// from `fixtures/conformance/usage-typescript.json`, changed there first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { scratchDir } from '../../test-support.ts';
import { usage, claudeWindows, roomOf, type Source, type Reading, type Window } from '@byokit/usage';
import { windowsView } from '@byokit/usage/view';
import { fakeCodex, fakeFetch } from '@byokit/usage/testing';
import payloads from './usage-payloads.json' with { type: 'json' };
import edge from '../../../fixtures/conformance/usage-typescript.json' with { type: 'json' };

const nowMs = 1788600000000;
const viewCase = edge.windowsView;

async function claudeReading(): Promise<Reading> {
  const reader = usage({ fetch: fakeFetch([{ body: payloads.claude.raw }]).fetch });
  const source: Source = { provider: 'claude', access: 'synthetic-token', accountId: 'synthetic-account' };
  return reader.read(source, { nowMs });
}

async function codexReading(): Promise<Reading> {
  const dir = scratchDir('usage-windows');
  const home = join(dir, 'sign-in'); mkdirSync(home);
  writeFileSync(join(home, 'auth.json'), JSON.stringify({ tokens: { account_id: payloads.codex.identity } }));
  const fake = fakeCodex({ dir: join(dir, 'bin'), raw: payloads.codex.raw });
  const reader = usage({ stateDir: join(dir, 'state') });
  return reader.read({ provider: 'codex', bin: fake.bin, home }, { nowMs });
}

test('windowsView lists both windows tightest first with their reset, and a host reads Claude and Codex through it', async () => {
  for (const [provider, read, expected] of [
    ['claude', claudeReading, viewCase.claude] as const,
    ['codex', codexReading, viewCase.codex] as const,
  ]) {
    const reading = await read();
    assert.deepEqual(reading.windows, payloads[provider].windows as Window[]);
    const view = windowsView(reading, nowMs);
    assert.equal(view.windows.length, expected.length);
    assert.deepEqual(view.windows.map((w) => w.kind), expected.map((c) => c.kind));
    for (const [i, want] of expected.entries()) {
      const line = view.windows[i]!;
      assert.equal(line.provider, provider);
      assert.equal(line.kind, want.kind);
      assert.equal(line.usedPercent, want.usedPercent);
      // The millisecond reset is unchanged from the reading, never re-scaled.
      assert.equal(line.resetsAt, want.resetsAt);
      assert.equal(line.resetsAt, payloads[provider].windows[i]?.resetsAt);
      assert.equal(line.text, want.text);
      assert.equal(line.resetText, want.resetText);
    }
    // A fresh reading pairs with an as-of age taken from Reading.at.
    assert.equal(view.freshness, 'fresh');
    assert.equal(view.stale, false);
    assert.equal(view.ageText, 'Read a moment ago');
  }
});

test('windowsView age comes only from Reading.at: unknown without one, none for a future clock, stale but numeric past a day', async () => {
  const windows = payloads.codex.windows as Window[];
  for (const fixture of viewCase.age) {
    const reading: Reading = { provider: 'codex', windows, ...('at' in fixture ? { at: fixture.at } : {}) };
    const view = windowsView(reading, fixture.now);
    assert.equal(view.freshness, fixture.freshness);
    assert.equal(view.stale, fixture.stale);
    if ('ageText' in fixture) assert.equal(view.ageText, fixture.ageText);
    else assert.equal('ageText' in view, false, 'a future reading carries no age');
    // A stale reading keeps its numbers.
    if (fixture.stale) {
      assert.equal(view.windows.length, windows.length);
      assert.deepEqual(view.windows.map((w) => w.usedPercent), [...windows.map((w) => w.usedPercent)].sort((a, b) => (b ?? -1) - (a ?? -1)));
    }
  }
});

test('windowsView marks a window without a used percent unknown, orders unknowns last and never mutates the reading', () => {
  const reading: Reading = { provider: 'claude', at: nowMs, windows: [{ provider: 'claude', kind: 'weekly' }] };
  const before = JSON.stringify(reading);
  const view = windowsView(reading, nowMs);
  assert.equal(JSON.stringify(reading), before);
  assert.equal(view.windows[0]!.usedPercent, undefined);
  assert.equal(view.windows[0]!.text, viewCase.unknownWindow.text);
  assert.equal(view.windows[0]!.resetText, viewCase.unknownWindow.resetText);

  // Tightest first, an unknown window after the measured ones.
  const scoped = claudeWindows(edge.claude);
  const scopedView = windowsView({ provider: 'claude', at: edge.now, windows: scoped }, edge.now);
  assert.deepEqual(scopedView.windows.map((w) => w.usedPercent), [100, 30, 20, undefined]);
});

test('roomOf and the plan view are unchanged by the windows view and the entry stays portable', async () => {
  const reading: Reading = { provider: 'codex', at: nowMs, windows: payloads.codex.windows as Window[] };
  windowsView(reading, nowMs);
  assert.deepEqual(roomOf(reading, nowMs), { left: 10, span: 'week', resetsAt: 1788616800000, at: nowMs, ageMs: 0, freshness: 'fresh' });

  const bundle = await build({
    stdin: { contents: `import { windowsView, planView } from '@byokit/usage/view'; globalThis.probe = { windowsView, planView };`,
      resolveDir: import.meta.dirname, sourcefile: 'windows-view.ts' },
    bundle: true, platform: 'browser', format: 'iife', write: false, metafile: true, logLevel: 'silent',
  });
  const inputs = Object.keys(bundle.metafile!.inputs);
  assert.deepEqual(inputs.filter((path) => /node:/.test(path)), [], 'nothing from Node');
  assert.ok(bundle.outputFiles[0].text.length > 0);
});
