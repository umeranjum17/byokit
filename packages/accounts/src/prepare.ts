// Shared, non-secret config for a new pool folder (plan v1 section 5.5). The source is the person's own
// default folder for that tool, and only the names in the table below are linked or copied, so a sign-in
// file, session store, log or Pi models.json is never touched. BYOKit has already linked the history name
// (projects for Claude, sessions for the rest) before it calls this, so prepare must not touch that name.
import { constants, copyFileSync, existsSync, realpathSync, symlinkSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { CliProvider } from './cli.ts';

/** The names a pool folder shares with the person's own default folder for one tool. A tool outside this
 * table (OpenCode, Kimi, Vibe) shares no config today. */
const SHARED: Partial<Record<CliProvider, { folder: string[]; link: string[]; copy: string[] }>> = {
  claude: { folder: ['.claude'], link: ['skills', 'agents'], copy: ['settings.json'] },
  codex: { folder: ['.codex'], link: ['agents', 'rules', 'AGENTS.md'], copy: ['config.toml'] },
  pi: { folder: ['.pi', 'agent'], link: ['extensions', 'skills'], copy: ['settings.json'] },
};

export type PoolPrepareOptions = { home: string };

/** The `prepare` callback a pool host passes to `cliAccounts`: link the shared config folders and copy the
 * settings files from the person's own default folder for the tool. A name the person does not have is
 * skipped, never created. A failure throws, which rolls the new folder back. */
export function poolPrepare(options: PoolPrepareOptions): (folder: string, provider: CliProvider) => Promise<void> {
  if (typeof options?.home !== 'string' || !isAbsolute(options.home)) throw new Error('a pool folder needs an absolute HOME for its shared config');
  const { home } = options;
  return async (folder, provider) => {
    const shared = SHARED[provider];
    if (!shared) return;
    const source = join(home, ...shared.folder);
    for (const name of shared.link) {
      const from = join(source, name);
      if (!existsSync(from) || existsSync(join(folder, name))) continue;
      symlinkSync(realpathSync(from), join(folder, name));
    }
    for (const name of shared.copy) {
      const from = join(source, name);
      if (!existsSync(from) || existsSync(join(folder, name))) continue;
      copyFileSync(from, join(folder, name), constants.COPYFILE_EXCL);
    }
  };
}
