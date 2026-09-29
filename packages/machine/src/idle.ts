// Sleep-and-wake on the machine itself (docs/machine-kit.md M7, './idle' entry, portable).
// M1 stub: signatures frozen, bodies land in M7.
export function idle(o: { linked: () => number; held: () => boolean; minutes: number; stop: () => Promise<void> }): { close(): void } {
  void o;
  throw new Error('not built: M7');
}

export function stopSelf(o: { baseUrl: string; id: string; key: () => Promise<string>; fetch?: typeof fetch }): () => Promise<void> {
  void o;
  throw new Error('not built: M7');
}
