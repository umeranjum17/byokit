// Runs inside `node --permission` with HOME pointing at a decoy someone's setup: it stores a
// canary through the fake keyring CLI and the passphrase file, all under the work dir from argv.
// Prints one JSON line. It must exit 0 without touching the decoy (the parent checks that).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileStore, keyringStore } from '../src/index.ts';
import { writeFakeCli, type FakeTool } from './fake-cli.ts';

const [workDir, tool] = process.argv.slice(2) as [string, FakeTool];
const CANARY = 'sk-canary-isolation-1c5d';
const result: Record<string, unknown> = { tool };

try {
  const bin = writeFakeCli(workDir, tool);
  const canaryFile = join(workDir, 'canary.txt');
  writeFileSync(canaryFile, CANARY);
  const ring = keyringStore({
    bin,
    tool,
    env: {
      FAKE_TOOL: tool,
      FAKE_LOG: join(workDir, 'invocations.jsonl'),
      FAKE_STATE: join(workDir, 'state.json'),
      FAKE_CANARY_FILE: canaryFile,
    },
  });
  await ring.set('openai', CANARY);
  result.keyringGet = await ring.get('openai');
  result.keyringDeleted = await ring.delete('openai');
  const file = fileStore({ path: join(workDir, 'keys.json'), passphrase: 'isolation-pass' });
  await file.set('openai', CANARY);
  result.fileGet = await file.get('openai');
  result.ok = result.keyringGet === CANARY && result.keyringDeleted === true && result.fileGet === CANARY;
} catch (e: any) {
  result.ok = false;
  result.error = e?.message ?? String(e);
}
console.log(JSON.stringify(result));
