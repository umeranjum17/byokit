// Bounded validator shared by generation and the CLI adapter; same subset as runtime structured output.
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
type JsonType = 'null' | 'boolean' | 'number' | 'integer' | 'string' | 'array' | 'object';
type SchemaNode = boolean | OutputSchema;
export type OutputSchema = {
  readonly type?: JsonType | readonly JsonType[];
  readonly properties?: Readonly<Record<string, SchemaNode>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: SchemaNode;
  readonly items?: SchemaNode;
  readonly enum?: readonly JsonValue[];
  readonly const?: JsonValue;
  readonly anyOf?: readonly SchemaNode[];
  readonly oneOf?: readonly SchemaNode[];
  readonly allOf?: readonly SchemaNode[];
  readonly not?: SchemaNode;
  readonly minimum?: number; readonly maximum?: number;
  readonly exclusiveMinimum?: number; readonly exclusiveMaximum?: number;
  readonly minLength?: number; readonly maxLength?: number;
  readonly minItems?: number; readonly maxItems?: number; readonly uniqueItems?: boolean;
  readonly minProperties?: number; readonly maxProperties?: number;
  readonly title?: string; readonly description?: string;
  readonly default?: JsonValue; readonly examples?: readonly JsonValue[];
  readonly $schema?: 'http://json-schema.org/draft-07/schema#';
};

// Only keys present in every possible fixed required-list are guaranteed. A runtime array guarantees none.
type KeysInEveryList<R extends readonly string[]> =
  (R extends unknown ? (key: number extends R['length'] ? never : R[number]) => void : never) extends (key: infer K) => void ? Extract<K, string> : never;
type RequiredKeys<S> = S extends { readonly required: infer R extends readonly string[] } ? KeysInEveryList<R> : never;
type ObjectOutput<S> = S extends { readonly properties: infer P extends Record<string, SchemaNode> }
  ? { -readonly [K in keyof P as K extends RequiredKeys<S> ? K : never]: SchemaOutput<P[K]> }
    & { -readonly [K in keyof P as K extends RequiredKeys<S> ? never : K]?: SchemaOutput<P[K]> }
  : Record<string, unknown>;
type OutputType<T, S> = T extends 'null' ? null : T extends 'boolean' ? boolean
  : T extends 'number' | 'integer' ? number : T extends 'string' ? string
  : T extends 'array' ? (S extends { readonly items: infer I } ? SchemaOutput<I> : unknown)[]
  : T extends 'object' ? ObjectOutput<S> : unknown;
/** Literal schemas infer their output; broad/dynamic schemas and unsupported inference shapes remain unknown. */
export type SchemaOutput<S> = S extends { readonly const: infer V } ? V
  : S extends { readonly enum: readonly (infer V)[] } ? V
  : S extends { readonly type: infer T } ? OutputType<T extends readonly unknown[] ? T[number] : T, S>
  : S extends { readonly anyOf: readonly (infer B)[] } | { readonly oneOf: readonly (infer B)[] } ? SchemaOutput<B>
  : unknown;

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const own = (v: object, k: string): boolean => Object.hasOwn(v, k);
const types = new Set(['null', 'boolean', 'number', 'integer', 'string', 'array', 'object']);
const bounds = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'];
const counts = ['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties'];
const annotations = ['title', 'description', 'default', 'examples', '$schema'];
const keywords = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  'anyOf', 'oneOf', 'allOf', 'not', 'uniqueItems', ...bounds, ...counts, ...annotations]);
export class InvalidSchemaError extends Error {
  readonly code = 'invalid_schema';
  constructor() { super('The output schema is invalid or unsupported.'); this.name = 'InvalidSchemaError'; }
}
function invalid(): never { throw new InvalidSchemaError(); }

function checkSchema(s: unknown, depth = 0): asserts s is SchemaNode {
  if (depth > 32) invalid();
  if (typeof s === 'boolean') return;
  if (!record(s) || Object.keys(s).some((k) => !keywords.has(k))) invalid();
  if (own(s, 'type')) {
    const ts = Array.isArray(s.type) ? s.type : [s.type];
    if (!ts.length || ts.some((t) => !types.has(t)) || new Set(ts).size !== ts.length) invalid();
  }
  for (const k of bounds) if (own(s, k) && (typeof s[k] !== 'number' || !Number.isFinite(s[k]))) invalid();
  for (const k of counts) if (own(s, k) && (typeof s[k] !== 'number' || !Number.isSafeInteger(s[k]) || (s[k] as number) < 0)) invalid();
  for (const k of ['title', 'description']) if (own(s, k) && typeof s[k] !== 'string') invalid();
  if (own(s, '$schema') && s.$schema !== 'http://json-schema.org/draft-07/schema#') invalid();
  if (own(s, 'examples') && !Array.isArray(s.examples)) invalid();
  if (own(s, 'enum') && (!Array.isArray(s.enum) || !s.enum.length)) invalid();
  if (own(s, 'uniqueItems') && typeof s.uniqueItems !== 'boolean') invalid();
  if (own(s, 'required') && (!Array.isArray(s.required) || s.required.some((k) => typeof k !== 'string')
    || new Set(s.required).size !== s.required.length)) invalid();
  if (own(s, 'properties')) {
    if (!record(s.properties)) invalid();
    for (const sub of Object.values(s.properties)) checkSchema(sub, depth + 1);
  }
  for (const k of ['items', 'additionalProperties', 'not']) if (own(s, k)) checkSchema(s[k], depth + 1);
  for (const k of ['anyOf', 'oneOf', 'allOf']) if (own(s, k)) {
    if (!Array.isArray(s[k]) || !s[k].length) invalid();
    for (const sub of s[k]) checkSchema(sub, depth + 1);
  }
}

// Equality is structural: JSON objects have no key order, including enum/const values and unique array items.
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equal(v, b[i]));
  if (record(a) && record(b)) return Object.keys(a).length === Object.keys(b).length
    && Object.keys(a).every((k) => own(b, k) && equal(a[k], b[k]));
  return false;
}

function hasType(v: unknown, t: JsonType): boolean {
  if (t === 'null') return v === null;
  if (t === 'array') return Array.isArray(v);
  if (t === 'object') return record(v);
  if (t === 'integer') return typeof v === 'number' && Number.isInteger(v);
  return typeof v === t && (t !== 'number' || Number.isFinite(v));
}

function matches(s: SchemaNode, v: unknown): boolean {
  if (typeof s === 'boolean') return s;
  if (s.type !== undefined && !(Array.isArray(s.type) ? s.type : [s.type]).some((t) => hasType(v, t))) return false;
  if (own(s, 'const') && !equal(s.const, v)) return false;
  if (s.enum && !s.enum.some((e) => equal(e, v))) return false;
  if (s.allOf && !s.allOf.every((sub) => matches(sub, v))) return false;
  if (s.anyOf && !s.anyOf.some((sub) => matches(sub, v))) return false;
  if (s.oneOf && s.oneOf.filter((sub) => matches(sub, v)).length !== 1) return false;
  if (s.not !== undefined && matches(s.not, v)) return false;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || (s.minimum !== undefined && v < s.minimum) || (s.maximum !== undefined && v > s.maximum)
      || (s.exclusiveMinimum !== undefined && v <= s.exclusiveMinimum) || (s.exclusiveMaximum !== undefined && v >= s.exclusiveMaximum)) return false;
  }
  if (typeof v === 'string') {
    const length = [...v].length;
    if ((s.minLength !== undefined && length < s.minLength) || (s.maxLength !== undefined && length > s.maxLength)) return false;
  }
  if (Array.isArray(v)) {
    if ((s.minItems !== undefined && v.length < s.minItems) || (s.maxItems !== undefined && v.length > s.maxItems)) return false;
    if (s.items !== undefined && !v.every((item) => matches(s.items!, item))) return false;
    if (s.uniqueItems && v.some((item, i) => v.slice(0, i).some((other) => equal(item, other)))) return false;
  }
  if (record(v)) {
    const keys = Object.keys(v);
    if ((s.minProperties !== undefined && keys.length < s.minProperties) || (s.maxProperties !== undefined && keys.length > s.maxProperties)) return false;
    if (s.required?.some((k) => !own(v, k))) return false;
    for (const k of keys) {
      const sub = s.properties && own(s.properties, k) ? s.properties[k] : s.additionalProperties;
      if (sub !== undefined && !matches(sub, v[k])) return false;
    }
  }
  return true;
}

/** Snapshot a JSON-only schema before any await; no mutation can change the prompt or its validation. */
export function outputSchema(value: unknown): { json: string; prompt: string; parse(text: string): { data: unknown } | undefined } {
  let json: string | undefined;
  try {
    json = JSON.stringify(value, (_key, v: unknown) => {
      if (v === undefined || typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint'
        || (typeof v === 'number' && !Number.isFinite(v))) invalid();
      return v;
    });
  } catch { invalid(); }
  if (!json || json.length > 65_536 || new TextEncoder().encode(json).length > 65_536) invalid();
  const schema: unknown = JSON.parse(json);
  if (!record(schema)) invalid(); // the public run contract requires an object at its root
  checkSchema(schema);
  return {
    json,
    prompt: `Return only one JSON value matching this JSON Schema, with no markdown or surrounding text.\n${json}`,
    parse: (text) => {
      try {
        const data: unknown = JSON.parse(text, (_key, value: unknown) => {
          if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('invalid number');
          return value;
        });
        return matches(schema, data) ? { data } : undefined;
      } catch { return undefined; }
    },
  };
}
