import Zeroconf from 'react-native-zeroconf';
import { browse as browseWith, scan as scanWith, type BrowseHandle, type BrowseOptions, type BrowseService } from './browse.ts';

export type { BrowseEventName, BrowseEvents, BrowseHandle, BrowseOptions, BrowseService, ZeroconfLike } from './browse.ts';

const nativeBrowser = new Zeroconf();

/** Start discovering `_<type>._<protocol>` services, e.g. `browse({ type: 'muxr' })`. Stop with `stop()`. */
export function browse(o: BrowseOptions): BrowseHandle {
  return browseWith({ ...o, zeroconf: nativeBrowser });
}

/** Collect resolved services for `ms` milliseconds, then stop. Rejects if the scan errors. */
export function scan(o: BrowseOptions & { ms: number }): Promise<BrowseService[]> {
  return scanWith({ ...o, zeroconf: nativeBrowser });
}
