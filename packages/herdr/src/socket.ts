// The Herdr socket: one connection per request, event sockets and reconnects (docs/runtime-kits.md 6.3) — built in H3.

import type { HerdrTransport } from './types.ts';

export function socketTransport(socketPath: string): HerdrTransport {
  throw new Error('@byokit/herdr: socketTransport lands in H3 (docs/runtime-kits.md §11.3).');
}
