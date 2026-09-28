// Classify an engine error message into a person-visible kind, with `until` carried when present (5.8, O8).
export function classify(message: string): { kind: 'signed-out' | 'resting' | 'plan' | 'network' | 'other'; until?: number } {
  throw new Error('not built: O8');
}
