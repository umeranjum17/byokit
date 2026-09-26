// The React Native entry (package exports condition "react-native"): browse the LAN for mDNS services. Metro
// resolves this file and bundles its static import of the app-provided react-native-zeroconf (optional peer
// dependency). Node and web builds resolve the main entry and never see it.
import Zeroconf from 'react-native-zeroconf';
import { browse as browseWith, scan as scanWith, type BrowseHandle, type BrowseOptions, type BrowseService } from './browse.ts';

export type { BrowseEventName, BrowseEvents, BrowseHandle, BrowseOptions, BrowseService, ZeroconfLike } from './browse.ts';

/** Start discovering `_<type>._<protocol>` services, e.g. `browse({ type: 'muxr' })`. Stop with `stop()`. */
export function browse(o: BrowseOptions): BrowseHandle {
  return browseWith({ ...o, zeroconf: new Zeroconf() });
}

/** Collect resolved services for `ms` milliseconds, then stop. Rejects if the scan errors. */
export function scan(o: BrowseOptions & { ms: number }): Promise<BrowseService[]> {
  return scanWith({ ...o, zeroconf: new Zeroconf() });
}
