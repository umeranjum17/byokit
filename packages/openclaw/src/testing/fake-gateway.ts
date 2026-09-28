// The fake Gateway (5.11): an in-memory transport double driven by default handlers and scripts. Built in O7.
import type { KitOptions } from '../kit.ts';
import type { GatewayTransport } from '../types.ts';

export function fakeGateway(script?: unknown): {
  factory: KitOptions['transport'];
  calls: { method: string; params: unknown }[];
  emit(event: string, payload?: unknown): void;
  failNext(method: string, message: string): void;
  drop(why: string): void;
  handle(method: string, fn: (params: unknown) => unknown): void;
} & { transport: GatewayTransport } {
  throw new Error('not built: O7');
}
