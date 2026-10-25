// K2 (docs/runtime-kits.md 5.15, design report 4 K2): the non-secret map from a bound account agent to the one managed
// native CLI folder its engine work must use. The kit writes it from the account index (a folder path and nothing else);
// the engine patch reads it in the gateway at every CLI run, so a native account's launch, resumed session and detection
// probe all name that account's folder — never another account's, and never the person's own installed login.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The gateway environment variable naming that file. A pin change must keep this name and the table's shape. */
export const NATIVE_ENV_VAR = 'BYOKIT_NATIVE_ENV';
/** The table lives beside the bound rows' folders, inside the kit's own root. */
export const nativeEnvPath = (root: string): string => join(root, 'native', 'env.json');
/** One bound agent's folder: a directory inside the kit root, never a credential, an email or a token. */
export type NativeEnvRow = { cli: 'claude'; dir: string };
const valid = (value: unknown): value is NativeEnvRow => {
  const row = value as NativeEnvRow | undefined;
  return !!row && typeof row === 'object' && row.cli === 'claude' && typeof row.dir === 'string' && row.dir.startsWith('/');
};

/**
 * Replace one member's rows in the table, keeping every other member's: an add, a removal or a restart republishes the
 * truth from that member's index. Atomic and 0600; a missing or damaged table is rebuilt.
 */
export function writeNativeEnv(root: string, member: string, rows: Record<string, NativeEnvRow>): void {
  const path = nativeEnvPath(root);
  const kept: Record<string, NativeEnvRow> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const accounts = parsed && typeof parsed === 'object' ? (parsed as { accounts?: unknown }).accounts : undefined;
    if (accounts && typeof accounts === 'object' && !Array.isArray(accounts))
      for (const [agent, row] of Object.entries(accounts))
        if (!agent.startsWith(`${member}--`) && valid(row)) kept[agent] = row;
  } catch { /* no readable table: the index below is the only source */ }
  for (const [agent, row] of Object.entries(rows)) if (agent.startsWith(`${member}--`) && valid(row)) kept[agent] = row;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ v: 1, accounts: kept }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temp, path);
}
