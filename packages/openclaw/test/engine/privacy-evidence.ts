// Fixture-only byte evidence. No gateway events or clipped output stand in for full provider bodies.
import { createHash } from 'node:crypto';

export function scanCapabilities(value: unknown, capabilities: ReadonlySet<string>): { checked: number; matches: string[] } {
  const text = JSON.stringify(value);
  if (text === undefined || capabilities.size === 0 || [...capabilities].some(value => !value))
    throw new Error('privacy evidence unavailable');
  return { checked: capabilities.size, matches: [...capabilities].filter(value => text.includes(value))
    .map(value => createHash('sha256').update(value).digest('hex')) };
}
