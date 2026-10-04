import type { AndroidShareIntent, ShareIntent, ShareIntentOptions } from '../../src/types.ts';
export function parseJson(value: string, defaultValue?: unknown): unknown;
export function parseShareIntent(value: string | AndroidShareIntent, options: ShareIntentOptions): ShareIntent;
