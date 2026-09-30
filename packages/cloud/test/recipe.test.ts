// M1 acceptance: every 8.1 pure rule, one failing and one passing case each; env names
// API_KEY, token, DB_PASSWORD and Secret_x refused; argv --api-key, --token=x and password:x
// refused; workDir /home/user/../etc, /home/user/a b, /home/user/a%b and one with \n refused;
// node.range '>=24.15.0 <25 || >=25.9.0 <26' accepts 24.21.0 and 25.9.0 and rejects 24.14.9,
// 25.0.0 and 26.0.0; the marker hash is stable for equal input and differs when one
// installRoot argument changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MachineError } from '../src/errors.ts';
import { checkRecipe, markerHash, markerPath, satisfiesRange } from '../src/recipe.ts';
import type { HostRecipe } from '../src/types.ts';

const sha = (c: string): Record<'linux-x64' | 'linux-arm64', string> => ({ 'linux-x64': c.repeat(64), 'linux-arm64': c.repeat(64) });
const good = (): HostRecipe => ({
  name: 'web',
  node: { version: '24.15.0', sha256: sha('a') },
  install: [['npm', 'ci']],
  run: { argv: ['node', 'server.mjs'], env: { PORT: '7310' } },
  workDir: '/home/user/app',
});

const fails = (r: HostRecipe): string => {
  try {
    checkRecipe(r, 'web');
  } catch (e) {
    assert.equal((e as MachineError).code, 'bad-recipe');
    return (e as MachineError).message;
  }
  assert.fail(`expected bad-recipe for ${JSON.stringify(r)}`);
};

test('every 8.1 pure rule: one failing and one passing case each', () => {
  checkRecipe(good(), 'web');
  assert.match(fails({ ...good(), name: 'Web' }), /name/);
  assert.match(fails({ ...good(), name: 'other' }), /name/);
  assert.match(fails({ ...good(), workDir: '/home/user/../etc' }), /workDir/);
  assert.match(fails({ ...good(), install: [[]] }), /install/);
  assert.match(fails({ ...good(), install: [['npm', 'ci\n']] }), /install/);
  assert.match(fails({ ...good(), run: { ...good().run, argv: [] } }), /run\.argv/);
  assert.match(fails({ ...good(), run: { ...good().run, argv: ['node', 'a\nb'] } }), /run\.argv/);
  assert.match(fails({ ...good(), run: { ...good().run, env: { PORT: '73\n10' } } }), /run\.env/);
  assert.match(fails({ ...good(), node: { ...good().node, version: '24.x' } }), /node\.version/);
  assert.match(fails({ ...good(), node: { ...good().node, sha256: sha('z') } }), /node\.sha256/);
  assert.match(fails({ ...good(), node: { ...good().node, range: 'not-a-range' } }), /node\.range/);
  assert.match(fails({ ...good(), user: 'root' }), /user/);
  assert.match(fails({ ...good(), user: 'Root' }), /user/);
  // Passing variants of the same rules.
  checkRecipe({ ...good(), install: [['npm', 'ci']], update: [['npm', 'run', 'migrate']] }, 'web');
  checkRecipe({ ...good(), node: { ...good().node, range: '>=24.15.0' } }, 'web');
  checkRecipe({ ...good(), user: 'appbot' }, 'web');
  checkRecipe({ ...good(), installRoot: [['apt-get', 'install', '-y', 'curl']] }, 'web');
});

test('secret-looking env names are refused', () => {
  for (const name of ['API_KEY', 'token', 'DB_PASSWORD', 'Secret_x']) {
    assert.match(fails({ ...good(), run: { ...good().run, env: { [name]: 'x' } } }), /run\.env/, name);
  }
  checkRecipe(good(), 'web');
});

test('secret-looking argv elements are refused', () => {
  for (const argv of [['--api-key'], ['--token=x'], ['password:x']]) {
    assert.match(fails({ ...good(), run: { ...good().run, argv } }), /run\.argv/, argv[0]);
  }
  checkRecipe(good(), 'web');
});

test('unsafe workDir values are refused', () => {
  for (const workDir of ['/home/user/../etc', '/home/user/a b', '/home/user/a%b', '/home/user/a\nb']) {
    assert.match(fails({ ...good(), workDir }), /workDir/, JSON.stringify(workDir));
  }
  checkRecipe(good(), 'web');
});

test('node.range compare (G5a)', () => {
  const range = '>=24.15.0 <25 || >=25.9.0 <26';
  for (const v of ['24.21.0', '25.9.0']) assert.equal(satisfiesRange(v, range), true, v);
  for (const v of ['24.14.9', '25.0.0', '26.0.0']) assert.equal(satisfiesRange(v, range), false, v);
  assert.equal(satisfiesRange('24.21.0', '>=24.15.0'), true);
  assert.equal(satisfiesRange('24.21.0', 'bogus'), false);
});

test('the marker hash is stable for equal input and differs when one installRoot argument changes', () => {
  const a = markerHash('appbot', [['apt-get', 'install', '-y', 'curl']]);
  assert.equal(a, markerHash('appbot', [['apt-get', 'install', '-y', 'curl']]));
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.notEqual(a, markerHash('appbot', [['apt-get', 'install', '-y', 'wget']]));
  assert.notEqual(a, markerHash(undefined, [['apt-get', 'install', '-y', 'curl']]));
  assert.equal(markerHash(undefined, undefined), markerHash(undefined, undefined));
  assert.equal(markerPath('web', good()), `/var/lib/byokit/web-${markerHash(undefined, undefined)}`);
});
