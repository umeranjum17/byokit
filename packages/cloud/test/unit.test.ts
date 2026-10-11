// Systemd unit quoting per 8.4: an arg with `"`, `\`, `%` and `$` round-trips
// (guards against specifier and variable expansion in rendered units).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quoteArg, quoteEnv, renderUnit } from '../src/unit.ts';
import type { HostRecipe } from '../src/types.ts';

const sha = (c: string): Record<'linux-x64' | 'linux-arm64', string> => ({ 'linux-x64': c.repeat(64), 'linux-arm64': c.repeat(64) });

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
