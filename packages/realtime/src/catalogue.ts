import data from './catalogue.json' with { type: 'json' };
import type { RealtimeProviderId, RealtimeUsage } from './types.ts';
export type RealtimeProviderInfo = { id: RealtimeProviderId; name: string; billing: 'subscription' | 'api'; planSignIn: boolean; terms: 'grey' | 'allowed'; why?: string; source: string; inputRate: number; outputRate: number; usage: RealtimeUsage['basis'] };
export const providers = data as readonly RealtimeProviderInfo[];
