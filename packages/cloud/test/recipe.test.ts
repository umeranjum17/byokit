// 8.1 secret and path guards: env names API_KEY, token, DB_PASSWORD and Secret_x refused;
// argv --api-key, --token=x and password:x refused; workDir /home/user/../etc,
// /home/user/a b, /home/user/a%b and one with \n refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MachineError } from '../src/errors.ts';
import { checkRecipe } from '../src/recipe.ts';
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
