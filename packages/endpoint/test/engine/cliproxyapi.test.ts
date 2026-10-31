// Real-binary journey, run by the endpoint-engine CI job and never by `npm test`: the pinned CLIProxyAPI release,
// started by the kit under `unshare -rn` against a loopback fake upstream. BYOKIT_CLIPROXYAPI_ARCHIVE names the downloaded
// CLIProxyAPI_8.0.48_linux_amd64_no-plugin.tar.gz; the job downloads it with gh and this test checks its checksum.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratchDir } from '../../../test-support.ts';

const SHA256 = 'fb3bada1cdd05a8ef84b9f3b777c1019092c87def6405d057fbe1b2be9def22f';
const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

test('the pinned binary answers through the kit: one client 200, one upstream identity, no extra log files', () => {
  const archive = process.env['BYOKIT_CLIPROXYAPI_ARCHIVE'];
  assert.ok(archive, 'set BYOKIT_CLIPROXYAPI_ARCHIVE to the v8.0.48 linux_amd64_no-plugin tarball (gh release download v8.0.48 -R router-for-me/CLIProxyAPI)');
  assert.equal(createHash('sha256').update(readFileSync(archive)).digest('hex'), SHA256, 'the archive is not the pinned release');
  const work = scratchDir('endpoint-engine');
  mkdirSync(join(work, 'bin'));
  execFileSync('tar', ['-xzf', archive, '-C', join(work, 'bin'), 'cli-proxy-api']);
  const out = execFileSync('unshare', ['-rn', 'sh', join(fixtures, 'inner.sh'), work, join(work, 'bin', 'cli-proxy-api'), fixtures], { encoding: 'utf8', timeout: 90_000 });
  assert.equal(out, 'client_http=200 upstream_hits=2 statuses=[503 200 ] distinct_upstream_identities=1 leak_files=0 extra_log_files=0 disguised_calls=0\nPASS\n');
});
