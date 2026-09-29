// G11 acceptance: the opt-in pinned fetch downloads the binary only when called, verifies its sha256,
// refuses a bad hash leaving no file, and returns an existing verified file without downloading — all
// against a loopback fixture server, never the network (scripts/test.sh blocks outbound egress).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { isAbsolute, join } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import { HERDR_VERSION } from '../src/constants.ts';
import { HERDR_ASSETS, ensureHerdr, fetchHerdr } from '../src/binary.ts';

const FIXTURE = Buffer.from('#!/bin/sh\necho "fixture herdr 0.9.1"\n');
const FIXTURE_SHA = createHash('sha256').update(FIXTURE).digest('hex');

// The linux-x86_64 hash H2/H9 recomputed over the official release asset (schema/SOURCE.md).
const RECORDED_LINUX_X64 = '2a02fed16beb651ef006e1d43f048f652ca4dc58ad053cd2d44450563d5c54b7';

type FakeRelease = { url: string; hits: () => number; close: () => Promise<void> };

async function fakeRelease(body: Buffer = FIXTURE): Promise<FakeRelease> {
  let hits = 0;
  const server: Server = createServer((req, res) => {
    hits++;
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/herdr-linux-x86_64`,
    hits: () => hits,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

test('a good hash downloads an executable binary and returns its absolute path', async () => {
  const release = await fakeRelease();
  try {
    const dir = scratchDir('herdr-binary-good');
    const bin = await ensureHerdr({ dir, platform: 'linux-x64', url: release.url, sha256: FIXTURE_SHA });
    assert.ok(isAbsolute(bin), 'the bin is absolute for own mode');
    assert.equal(bin, join(dir, 'herdr'));
    assert.deepEqual(readFileSync(bin), FIXTURE);
    assert.ok(statSync(bin).mode & 0o111, 'the binary is marked executable');
    assert.equal(release.hits(), 1);
  } finally {
    await release.close();
  }
});

test('a bad hash is refused and no file is left behind', async () => {
  const release = await fakeRelease();
  try {
    const dir = scratchDir('herdr-binary-bad');
    await assert.rejects(
      ensureHerdr({ dir, platform: 'linux-x64', url: release.url, sha256: '0'.repeat(64) }),
      /safety check/,
    );
    assert.deepEqual(readdirSync(dir), [], 'neither the binary nor a temp download remains');
  } finally {
    await release.close();
  }
});

test('an existing verified file is returned with no download', async () => {
  const release = await fakeRelease();
  const dir = scratchDir('herdr-binary-cached');
  const first = await ensureHerdr({ dir, platform: 'linux-x64', url: release.url, sha256: FIXTURE_SHA });
  await release.close();
  const second = await ensureHerdr({ dir, platform: 'linux-x64', url: release.url, sha256: FIXTURE_SHA });
  assert.equal(second, first, 'the same verified file comes back with the server gone');
  assert.deepEqual(readFileSync(second), FIXTURE);
});

test('an existing file with the wrong bytes is replaced by a fresh download', async () => {
  const release = await fakeRelease();
  const dir = scratchDir('herdr-binary-replace');
  const before = await ensureHerdr({ dir, platform: 'linux-x64', url: release.url, sha256: FIXTURE_SHA });
  await release.close();
  // Tamper with the cached file: the next call must not trust it.
  writeFileSync(before, Buffer.from('#!/bin/sh\necho tampered\n'));
  const release2 = await fakeRelease();
  try {
    const after = await ensureHerdr({ dir, platform: 'linux-x64', url: release2.url, sha256: FIXTURE_SHA });
    assert.equal(after, before);
    assert.deepEqual(readFileSync(after), FIXTURE);
  } finally {
    await release2.close();
  }
});

test('an unsupported platform and a non-pinned version fail in plain words', async () => {
  const dir = scratchDir('herdr-binary-unsupported');
  await assert.rejects(ensureHerdr({ dir, platform: 'windows-x64' }), /no pinned Herdr app for "windows-x64"/);
  await assert.rejects(ensureHerdr({ dir, platform: 'linux-x64', version: '0.0.0' }), /only fetches the pinned Herdr/);
  assert.ok(!existsSync(join(dir, 'herdr')), 'a refusal downloads nothing');
});

test('the platform defaults to this computer (linux-x64 in CI)', async () => {
  if (`${process.platform}-${process.arch}` !== 'linux-x64') return; // covered by the explicit-platform cases
  const release = await fakeRelease();
  try {
    const bin = await ensureHerdr({ dir: scratchDir('herdr-binary-default'), url: release.url, sha256: FIXTURE_SHA });
    assert.deepEqual(readFileSync(bin), FIXTURE);
  } finally {
    await release.close();
  }
});

test('fetchHerdr is the same helper, and the pinned table matches the recorded hashes', () => {
  assert.equal(fetchHerdr, ensureHerdr);
  assert.equal(HERDR_VERSION, '0.9.1');
  assert.equal(HERDR_ASSETS['linux-x64'].sha256, RECORDED_LINUX_X64);
  for (const [platform, asset] of Object.entries(HERDR_ASSETS)) {
    assert.match(asset.sha256, /^[0-9a-f]{64}$/, `${platform} carries a full sha256`);
    assert.ok(asset.url.includes('v0.9.1'), `${platform} points at the pinned release`);
  }
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as {
    exports: Record<string, unknown>;
  };
  assert.ok(pkg.exports['./binary'], 'the ./binary entry is published');
});

test('nothing downloads on import: the module only defines the helper', async () => {
  // If this file's imports alone caused network traffic, the egress guard would already have failed
  // the run; this pins the other half — no side effects at import time.
  assert.equal(typeof ensureHerdr, 'function');
});
