// M1 acceptance: the 8.3 step 4 argv for both arches, byte for byte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { archOf, nodeDir, nodeInstallArgv, nodePath, nodeUrl } from '../src/node.ts';
import type { HostRecipe } from '../src/types.ts';

const sha = (c: string): Record<'linux-x64' | 'linux-arm64', string> => ({ 'linux-x64': c.repeat(64), 'linux-arm64': c.repeat(64) });
const recipe = (): HostRecipe => ({
  name: 'web',
  node: { version: '24.15.0', sha256: { 'linux-x64': 'a'.repeat(64), 'linux-arm64': 'b'.repeat(64) } },
  install: [['npm', 'ci']],
  run: { argv: ['node', 'server.mjs'], env: {} },
  workDir: '/home/user/app',
});

test('8.3 step 4 argv, linux-x64, byte for byte', () => {
  assert.deepEqual(nodeInstallArgv(recipe(), 'linux-x64', '/home/user'), [
    'sh', '-c',
    'set -e; d=$(mktemp -d); trap "rm -rf \\"$d\\"" EXIT\n'
      + 'curl -fsSL -o "$d/n.tar.xz" "$1"\n'
      + 'echo "$2  $d/n.tar.xz" | sha256sum -c --status || exit 3\n'
      + 'mkdir -p "$3"; tar -xJf "$d/n.tar.xz" -C "$3" --strip-components=1',
    'sh',
    'https://nodejs.org/dist/v24.15.0/node-v24.15.0-linux-x64.tar.xz',
    'a'.repeat(64),
    '/home/user/.local/share/byokit/node/24.15.0',
  ]);
});

test('8.3 step 4 argv, linux-arm64, byte for byte', () => {
  assert.deepEqual(nodeInstallArgv(recipe(), 'linux-arm64', '/home/user'), [
    'sh', '-c',
    'set -e; d=$(mktemp -d); trap "rm -rf \\"$d\\"" EXIT\n'
      + 'curl -fsSL -o "$d/n.tar.xz" "$1"\n'
      + 'echo "$2  $d/n.tar.xz" | sha256sum -c --status || exit 3\n'
      + 'mkdir -p "$3"; tar -xJf "$d/n.tar.xz" -C "$3" --strip-components=1',
    'sh',
    'https://nodejs.org/dist/v24.15.0/node-v24.15.0-linux-arm64.tar.xz',
    'b'.repeat(64),
    '/home/user/.local/share/byokit/node/24.15.0',
  ]);
});

test('arch, paths and URL helpers', () => {
  assert.equal(archOf('x86_64'), 'linux-x64');
  assert.equal(archOf('aarch64'), 'linux-arm64');
  assert.equal(archOf('armv7l'), null);
  assert.equal(nodeDir('/home/user', '24.15.0'), '/home/user/.local/share/byokit/node/24.15.0');
  assert.equal(nodePath('/home/user', '24.15.0'), '/home/user/.local/share/byokit/node/24.15.0/bin/node');
  assert.equal(nodeUrl('24.15.0', 'linux-x64'), 'https://nodejs.org/dist/v24.15.0/node-v24.15.0-linux-x64.tar.xz');
});
