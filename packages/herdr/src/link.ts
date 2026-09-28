// Host-side link adapter: the hd.* ops over @byokit/link, and the serve() wiring (duplicated per kit by design,
// D3) — built in H7 (docs/runtime-kits.md 7.1).

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Grant, Host, HostOptions } from '@byokit/link';
import type { RelayClient } from '@byokit/relay';
import type { ServeIngress, Via } from '@byokit/reach';
import type { HerdrKit } from './kit.ts';

export function herdrLink(kit: HerdrKit, o: {
  scopeOf: (grant: Grant) => { workspaces: 'all' | string[] };
  passThrough?: (method: string, grant: Grant) => boolean; // D8; default () => false
  relay?: RelayClient;                                     // sealed approval push (7.3)
}): Pick<HostOptions, 'handle' | 'stream' | 'allow'> {
  throw new Error('@byokit/herdr: herdrLink lands in H7 (docs/runtime-kits.md §11.3).');
}

export function serve(o: { host: Host; port: number; via?: Via; previous?: ServeIngress;
  http?: (req: IncomingMessage, res: ServerResponse) => void }): Promise<{ urls: string[]; ingress?: ServeIngress; close(): Promise<void> }> {
  throw new Error('@byokit/herdr: serve lands in H7 (docs/runtime-kits.md §11.3).');
}
