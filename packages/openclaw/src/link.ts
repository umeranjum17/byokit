// Host-side link adapter (7.1): typed, member-checked ops over @byokit/link, sealed approval push via the relay.
// Node only; built in O9.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Grant, Host, HostOptions } from '@byokit/link';
import type { ServeIngress, Via } from '@byokit/reach';
import type { RelayClient } from '@byokit/relay';
import type { OpenClawKit } from './kit.ts';
import type { Member } from './types.ts';

export function openclawLink(kit: OpenClawKit, o: {
  memberOf: (grant: Grant) => Member | undefined; // which member a device acts for (e.g. grant.meta.member)
  passThrough?: (method: string, grant: Grant) => boolean; // D8; default () => false
  relay?: RelayClient; // sealed approval push (7.3)
}): Pick<HostOptions, 'handle' | 'stream' | 'allow'> {
  throw new Error('not built: O9');
}

export function serve(o: {
  host: Host;
  port: number;
  via?: Via;
  previous?: ServeIngress;
  http?: (req: IncomingMessage, res: ServerResponse) => void;
}): Promise<{ urls: string[]; ingress?: ServeIngress; close(): Promise<void> }> {
  throw new Error('not built: O9');
}
