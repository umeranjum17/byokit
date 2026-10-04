import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, readlink, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { AgentTurnEnd, AgentTurnFiles } from './types.ts';

export function positiveLimit(value: number | undefined, fallback: number): number {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('turn: invalid limit');
  return n;
}

// A baseline of the actual tree, independent of Git status and mtime granularity. Never traverse
// symlinks or read special files; a changing/unreadable tree fails rather than claiming a full diff.
export async function scanFiles(root: string, policy: AgentTurnFiles | undefined, resultName: string,
  active: () => void): Promise<Map<string, string>> {
  const maxFiles = positiveLimit(policy?.maxFiles, 10000);
  const maxBytes = positiveLimit(policy?.maxBytes, 128 * 1024 * 1024);
  let entries = 0;
  let bytes = 0;
  const found = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    active();
    // Catch a directory being swapped for an out-of-tree symlink during a scan.
    const canonical = await realpath(dir);
    const within = relative(root, canonical);
    if (canonical !== dir || within === '..' || within.startsWith(`..${sep}`)) throw new Error('turn: directory escaped');
    for (const name of await readdir(dir)) {
      active();
      const path = join(dir, name);
      const rel = relative(root, path).split(sep).join('/');
      if (name === '.git' || rel === resultName || policy?.exclude?.(rel)) continue;
      if (++entries > maxFiles) throw new Error('turn: file limit');
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        found.set(rel, `link:${await readlink(path)}`);
      } else if (info.isDirectory()) {
        await walk(path);
      } else if (info.isFile()) {
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const before = await file.stat();
          if (!before.isFile() || before.ino !== info.ino || before.dev !== info.dev) throw new Error('turn: file changed');
          const digest = createHash('sha256');
          const buffer = Buffer.alloc(64 * 1024);
          let total = 0;
          for (;;) {
            active();
            const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
            bytes += bytesRead; total += bytesRead;
            if (bytes > maxBytes) throw new Error('turn: byte limit');
            if (bytesRead === 0) break;
            digest.update(buffer.subarray(0, bytesRead));
          }
          const after = await file.stat();
          if (before.size !== total || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
            throw new Error('turn: file changed');
          }
          found.set(rel, `${before.mode}:${digest.digest('hex')}`);
        } finally { await file.close(); }
      }
    }
  }
  await walk(root);
  active();
  return found;
}

export function changedFiles(before: Map<string, string>, after: Map<string, string>): AgentTurnEnd['changedFiles'] {
  const changes: AgentTurnEnd['changedFiles'] = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    if (!before.has(path)) changes.push({ path, change: 'added' });
    else if (!after.has(path)) changes.push({ path, change: 'deleted' });
    else if (before.get(path) !== after.get(path)) changes.push({ path, change: 'modified' });
  }
  return changes;
}
