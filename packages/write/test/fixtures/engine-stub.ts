// A stand-in for the engine package that speaks its wire (the committed protocol 1 schema): flat requests, validated
// against the schema before anything answers, `hello` outside the schema. Answers come from the kit's fake engine, so
// the contract runs over the real wire shape without the engine. Every schema violation is recorded.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fakeEngine } from '../../src/testing/index.ts';
import type { EngineRequest } from '../../src/types.ts';

type Schema = Record<string, unknown>;

export const schema = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../schema/engine-protocol-1.json', import.meta.url)), 'utf8'),
) as Schema;

/** The first reason `value` breaks `node`, for the keywords the protocol schema uses; null when it conforms. */
function breaks(value: unknown, node: Schema, at: string): string | null {
  if (typeof node.$ref === 'string') return breaks(value, (schema.$defs as Record<string, Schema>)[node.$ref.replace('#/$defs/', '')]!, at);
  if ('const' in node && value !== node.const) return `${at} must be ${JSON.stringify(node.const)}`;
  if (Array.isArray(node.enum) && !node.enum.includes(value)) return `${at} must be one of ${node.enum.join(', ')}`;
  const type = node.type;
  if (type === 'string' && typeof value !== 'string') return `${at} must be a string`;
  if (type === 'boolean' && typeof value !== 'boolean') return `${at} must be a boolean`;
  if (type === 'array') {
    if (!Array.isArray(value)) return `${at} must be an array`;
    if (typeof node.minItems === 'number' && value.length < node.minItems) return `${at} needs ${node.minItems}+ items`;
    for (const [i, item] of value.entries()) {
      const why = breaks(item, node.items as Schema, `${at}[${i}]`);
      if (why) return why;
    }
  }
  if (type === 'object' || node.properties) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return `${at} must be an object`;
    const props = (node.properties ?? {}) as Record<string, Schema>;
    for (const key of (node.required ?? []) as string[]) if (!(key in value)) return `${at}.${key} is required`;
    for (const [key, v] of Object.entries(value)) {
      if (!(key in props)) {
        if (node.additionalProperties === false) return `${at}.${key} is not allowed`;
        continue;
      }
      const why = breaks(v, props[key]!, `${at}.${key}`);
      if (why) return why;
    }
  }
  return null;
}

/** Why a wire request breaks the schema: its verb's `oneOf` branch decides. */
export function wireBreaks(request: unknown): string | null {
  const verb = (request as { verb?: unknown })?.verb;
  const branch = (schema.oneOf as Schema[]).find((b) => b.title === verb);
  return branch ? breaks(request, branch, 'request') : `no schema branch for verb ${JSON.stringify(verb)}`;
}

export type Stub = {
  Protocol: { handle(request: unknown): Promise<unknown>; hello(): Promise<unknown> };
  wire: unknown[];
  violations: string[];
};

export function engineStub(o: { protocol?: number; version?: string } = {}): Stub {
  const fake = fakeEngine({ version: '0.1.0', ...o });
  const wire: unknown[] = [];
  const violations: string[] = [];
  return {
    wire,
    violations,
    Protocol: {
      hello: () => fake.handle({ verb: 'hello', params: {} }),
      handle: async (request: unknown) => {
        wire.push(request);
        const why = wireBreaks(request);
        if (why) {
          violations.push(why);
          return { error: { code: 'bad-request', message: why } };
        }
        const { verb, ...params } = request as { verb: string };
        return fake.handle({ verb, params } as EngineRequest);
      },
    },
  };
}
