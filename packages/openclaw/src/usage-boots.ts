// Internal lifecycle records. Accounting UUIDs never participate in process ownership or liveness.
import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
export function appendUsageBoot(dir: string, record: { bootId: string } &
  ({ startedAt: number } | { failedAt: number; spawned: false })): void {
  let fd: number | undefined;
  try {
    fd = openSync(join(dir, 'boots.jsonl'), 'a', 0o600);
    const line = Buffer.from(JSON.stringify(record) + '\n');
    if (writeSync(fd, line) !== line.length) throw new Error();
    fsyncSync(fd);
  } catch { throw new Error('Usage boot record could not be made durable'); }
  finally { if (fd !== undefined) closeSync(fd); }
}
