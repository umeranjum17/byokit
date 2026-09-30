import type { toolBridge } from './tools.ts';
import type { RealtimeTool } from './types.ts';
export type AdapterOptions = { key: string; instructions: string; tools: RealtimeTool[]; bridge: ReturnType<typeof toolBridge>; model?: string; voice?: string; endpoint?: string; redact?: RegExp[]; hangup?: (text: string) => boolean };
