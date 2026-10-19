// `@byokit/cloud/unit`, Node only, on the machine inside the host process: the unit writers
// (unit.ts) plus the host's side of delivery (5.8, 5.12): take a delivered inbox file, and
// answer through the outbox the setup device reads back.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { MachineError } from './errors.ts';
import { FILE_NAME } from './unit.ts';

export * from './unit.ts';

const checkFile = (file: string): void => {
  if (!FILE_NAME.test(file)) throw new MachineError('bad-recipe', `file: must match ${FILE_NAME.source}, got ${JSON.stringify(file)}`);
};

/**
 * One delivered `<workDir>/.byokit/inbox/<file>`, or null while absent. Call `done()` (it removes
 * the file) only after handling it resolves, so a crash part-way handles the same file on the next start.
 */
export async function takeInbox(workDir: string, file: string): Promise<{ bytes: Uint8Array; done(): Promise<void> } | null> {
  checkFile(file);
  const path = `${workDir}/.byokit/inbox/${file}`;
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(path));
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return null;
    throw e;
  }
  return { bytes, done: () => rm(path, { force: true }) };
}

/** Write `<workDir>/.byokit/outbox/<file>` at 0600 through a temporary name and a rename, so it is never read half-written. */
export async function writeOutbox(workDir: string, file: string, text: string): Promise<void> {
  checkFile(file);
  const dir = `${workDir}/.byokit/outbox`;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${dir}/.${file}.tmp`; // a leading dot never matches FILE_NAME, so it is never read as an answer
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, `${dir}/${file}`);
}
