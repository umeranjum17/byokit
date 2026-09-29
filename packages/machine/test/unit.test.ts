// M1 acceptance: the three golden files byte for byte; an arg with `"`, `\`, `%` and `$`
// round-trips per 8.4.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { quoteArg, quoteEnv, renderUnit } from '../src/unit.ts';
import type { HostRecipe } from '../src/types.ts';

const sha = (c: string): Record<'linux-x64' | 'linux-arm64', string> => ({ 'linux-x64': c.repeat(64), 'linux-arm64': c.repeat(64) });
const golden = (name: string): string =>
  readFileSync(new URL(`./golden/${name}`, import.meta.url), 'utf8');

test('sandbox API system unit, byte for byte', () => {
  const r: HostRecipe = {
    name: 'tracker',
    node: { version: '24.15.0', sha256: sha('a') },
    install: [['npm', 'ci']],
    run: { argv: ['node', 'server.mjs'], env: { PORT: '7310' } },
    workDir: '/home/user/tracker',
  };
  assert.equal(
    renderUnit(r, { kind: 'system', runUser: 'user', nodePath: '/home/user/.local/share/byokit/node/24.15.0/bin/node', selfId: false }),
    golden('sandbox-system.service'),
  );
});

test('SSH VM user unit, byte for byte', () => {
  const r: HostRecipe = {
    name: 'notes',
    node: { version: '24.15.0', sha256: sha('b') },
    install: [['sh', 'setup.sh']],
    run: { argv: ['/opt/notes/run.sh'], env: {} },
    workDir: '/home/alice/notes',
  };
  assert.equal(
    renderUnit(r, { kind: 'user', runUser: 'alice', nodePath: '/usr/bin/node', selfId: false }),
    golden('ssh-user.service'),
  );
});

test('system unit for a recipe with user and selfId, byte for byte', () => {
  const r: HostRecipe = {
    name: 'helper',
    node: { version: '25.9.0', sha256: sha('c') },
    install: [['npm', 'ci']],
    run: { argv: ['node', 'host.mjs'], env: { LANG: 'C.UTF-8' } },
    workDir: '/home/user/.users/appbot/helper',
    user: 'appbot',
  };
  assert.equal(
    renderUnit(r, { kind: 'system', runUser: 'appbot', nodePath: '/home/user/.users/appbot/.local/share/byokit/node/25.9.0/bin/node', selfId: true }),
    golden('system-user-selfid.service'),
  );
});

test('quoting per 8.4: an arg with `"`, `\\`, `%` and `$` round-trips', () => {
  assert.equal(quoteArg('a"b\\c%d$e'), '"a\\"b\\\\c%%d$$e"');
  // Environment values escape \, " and % but leave $ alone.
  assert.equal(quoteEnv('a"b\\c%d$e'), '"a\\"b\\\\c%%d$e"');
  const r: HostRecipe = {
    name: 'q',
    node: { version: '24.15.0', sha256: sha('a') },
    install: [['echo', 'ok']],
    run: { argv: ['node', 'a"b\\c%d$e'], env: { Q: 'x$y%z' } },
    workDir: '/home/user/q',
  };
  const unit = renderUnit(r, { kind: 'system', runUser: 'user', nodePath: '/n/node', selfId: false });
  assert.ok(unit.includes('ExecStart="/n/node" "a\\"b\\\\c%%d$$e"'), unit);
  assert.ok(unit.includes('Environment="Q=x$y%%z"'), unit);
  assert.ok(unit.endsWith('\n') && !unit.endsWith('\n\n'), 'one trailing newline');
  for (const line of unit.split('\n')) assert.equal(line.trimEnd(), line, 'no trailing spaces');
});
