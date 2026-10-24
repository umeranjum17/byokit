// Node only (`@byokit/usage/version/node`): the version a package.json on disk says, as a build of that folder runs it.
import { readdirSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { buildVersion, type BuildVersion } from './version.ts';

/** A package's name and running version; pending `changes/*.md` fragments beside it make it a dev build. A
 *  published install carries no `changes/` folder, so it always reads as the release it is. */
export function packageVersion(packageJson: string | URL): BuildVersion & { name: string } {
  const manifest = JSON.parse(readFileSync(packageJson, 'utf8')) as { name?: unknown; version?: unknown };
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
    throw new TypeError(`${String(packageJson)} has no name and version`);
  }
  const at = typeof packageJson === 'string' ? pathToFileURL(packageJson) : packageJson;
  let fragments: string[] = [];
  try { fragments = readdirSync(new URL('changes/', at)).filter((f) => f.endsWith('.md')); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  return { name: manifest.name, ...buildVersion(manifest.version, { unreleased: fragments.length > 0 }) };
}
