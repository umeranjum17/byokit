import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { accountKind, accountKinds } from '../src/kinds.ts';
import { generateKinds } from '../scripts/gen-kinds.ts';
import { createAccountPanes } from '../src/accounts.ts';
import type { StartAgent } from '../src/types.ts';

test('24 pinned kinds, 12 folder variables and 18 resume planners regenerate offline', () => {
  const kinds = accountKinds();
  assert.deepEqual(kinds, generateKinds());
  assert.equal(readFileSync(new URL('../src/kinds.json', import.meta.url), 'utf8'), JSON.stringify(generateKinds(), null, 2) + '\n');
  assert.equal(kinds.reduce((n, row) => n + row.aliases.length, 0), 30);
  assert.equal(kinds.length, 24);
  assert.equal(kinds.filter((k) => k.folderVar).length, 12);
  assert.equal(kinds.filter((k) => k.resume).length, 18);
  assert.equal(kinds.filter((k) => k.folderVar && k.resume).length, 12);
  assert.equal(accountKind('grok')?.folderVar, 'GROK_HOME', 'never use the Herdr-only override');
  assert.equal(accountKind('omp')?.folderVar, 'PI_CODING_AGENT_DIR', 'direct folder, not home-relative PI_CONFIG_DIR');
  assert.equal(accountKind('kimi-code')?.kind, 'kimi');
  assert.equal(accountKind('muse-bin-0.1.0')?.kind, 'muse');
  assert.equal(accountKind('muse-binary'), undefined);
  for (const row of kinds) {
    assert.equal(row.billing, 'unknown');
    assert.equal(row.offer, 'explicit');
    assert.equal(row.upstream.revision, '065ef9d6a531c49fb8bee7e818ef837065b21ee9');
    if (!row.folderVar) assert.equal(row.loginLabel, 'One sign-in per computer user');
  }
  kinds[0]!.kind = 'mutated';
  assert.notEqual(accountKinds()[0]!.kind, 'mutated');
});

test('sign-in tab folders follow pinned kinds and preserve launch-env isolation', async () => {
  const starts: StartAgent[] = [];
  const panes = createAccountPanes({ call: async () => { assert.fail('no transport expected'); },
    startAgent: async (o) => { starts.push(o); return { paneId: 'tab' }; } });
  for (const kind of accountKinds()) {
    const launch = { env: { PATH: '/safe/bin' }, unset: ['SECRET'] };
    if (kind.folderVar) {
      await panes.openSignInTab({ workspaceId: 'workspace', kind: kind.kind, cwd: '/repo', folder: '/managed', env: launch });
      assert.deepEqual(starts.at(-1)?.env, { env: { PATH: '/safe/bin', [kind.folderVar]: '/managed' }, unset: ['SECRET'] });
      assert.deepEqual(launch, { env: { PATH: '/safe/bin' }, unset: ['SECRET'] });
    } else {
      await panes.openSignInTab({ workspaceId: 'workspace', kind: kind.kind, cwd: '/repo' });
      assert.equal(starts.at(-1)?.env, undefined, 'tab-only support does not guess a folder');
      const before = starts.length;
      await assert.rejects(panes.openSignInTab({ workspaceId: 'workspace', kind: kind.kind, cwd: '/repo', folder: '/managed' }),
        (e: { code?: string }) => e.code === 'sign_in_failed');
      assert.equal(starts.length, before);
    }
  }
});
