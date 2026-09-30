import { test } from 'node:test';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolationContract } from './isolation-contract.ts';

// Run the real Engine supervisor's isolation contract in npm test without installing or calling a provider.
// The engine job runs these same assertions against the actual pinned engine.
test('engine isolation: offline child receives only the app-owned environment and listens on loopback',
  { timeout: 30_000 }, () => isolationContract((dir) => {
    const engineDir = join(dir, 'fake-engine');
    const entryDir = join(engineDir, 'node_modules', 'openclaw');
    // Match the supervisor's install validation without installing any dependencies.
    const shipped = fileURLToPath(new URL('../engine/', import.meta.url));
    mkdirSync(engineDir, { recursive: true });
    for (const file of ['package.json', 'package-lock.json'])
      writeFileSync(join(engineDir, file), readFileSync(join(shipped, file)));
    const lock = JSON.parse(readFileSync(join(shipped, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { version: string }>;
    };
    for (const [path, pkg] of Object.entries(lock.packages)) {
      if (!path) continue;
      mkdirSync(join(engineDir, path), { recursive: true });
      writeFileSync(join(engineDir, path, 'package.json'), JSON.stringify({ version: pkg.version }));
    }
    writeFileSync(join(entryDir, 'openclaw.mjs'), `
import { writeFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
writeFileSync(join(process.env.HOME, 'child.json'), JSON.stringify({ env: process.env, cwd: process.cwd() }));
const config = JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH, 'utf8'));
if (process.argv[2] !== 'gateway' || config.gateway.bind !== 'loopback') process.exit(1);
createServer(socket => socket.end()).listen(config.gateway.port, '127.0.0.1');
`);
    return engineDir;
  }));
