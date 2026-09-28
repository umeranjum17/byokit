// Owns the server process in `own` mode (adopt never spawns) and the kit's state machine
// (docs/runtime-kits.md 6.3) — built in H3.

import type { HerdrKitOptions, HerdrState, HerdrTransport } from './types.ts';

export class Supervisor {
  constructor(o: HerdrKitOptions, onState: (s: HerdrState) => void) {
    throw new Error('@byokit/herdr: Supervisor lands in H3 (docs/runtime-kits.md §11.3).');
  }

  env(): Record<string, string> {
    throw new Error('@byokit/herdr: Supervisor.env lands in H3 (docs/runtime-kits.md §11.3).');
  }

  start(): Promise<HerdrTransport> {
    throw new Error('@byokit/herdr: Supervisor.start lands in H3 (docs/runtime-kits.md §11.3).');
  }

  stop(): Promise<void> {
    throw new Error('@byokit/herdr: Supervisor.stop lands in H3 (docs/runtime-kits.md §11.3).');
  }
}
