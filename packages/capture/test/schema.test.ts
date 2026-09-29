// BK-C1: schema/recorder-protocol-1.json validates every example in docs/capability-kits.md section 6 and every
// line the fake prints, checked with a small in-test validator for the subset the schema uses (type, required,
// properties, enum, pattern, items, oneOf, const). No new dependency.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import { PROTOCOL_SCHEMA_SHA256 } from '../src/constants.ts';
import { fakeRecorder } from '../src/testing/fake-recorder.ts';

type Schema = Record<string, unknown>;

const SCHEMA_PATH = new URL('../schema/recorder-protocol-1.json', import.meta.url);
const SCHEMA = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as Schema;

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function checkType(value: unknown, type: string): boolean {
  switch (type) {
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number';
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return false;
  }
}

function validate(value: unknown, schema: Schema): boolean {
  if ('const' in schema && !deepEqual(value, schema['const'])) return false;
  if ('enum' in schema) {
    const allowed = schema['enum'] as unknown[];
    if (!allowed.some((entry) => deepEqual(entry, value))) return false;
  }
  if ('type' in schema) {
    const types = Array.isArray(schema['type']) ? (schema['type'] as string[]) : [schema['type'] as string];
    if (!types.some((t) => checkType(value, t))) return false;
  }
  if ('pattern' in schema) {
    if (typeof value !== 'string') return false;
    if (!new RegExp(schema['pattern'] as string).test(value)) return false;
  }
  if ('required' in schema) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    for (const key of schema['required'] as string[]) {
      if (!(key in (value as Record<string, unknown>))) return false;
    }
  }
  if ('properties' in schema) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const props = schema['properties'] as Record<string, Schema>;
    for (const [key, sub] of Object.entries(props)) {
      const obj = value as Record<string, unknown>;
      if (key in obj && !validate(obj[key], sub)) return false;
    }
  }
  if ('items' in schema) {
    if (!Array.isArray(value)) return false;
    for (const entry of value) {
      if (!validate(entry, schema['items'] as Schema)) return false;
    }
  }
  if ('oneOf' in schema) {
    const branches = schema['oneOf'] as Schema[];
    const hits = branches.filter((branch) => validate(value, branch));
    if (hits.length !== 1) return false;
  }
  return true;
}

function assertValid(line: string): void {
  const value: unknown = JSON.parse(line);
  assert.ok(validate(value, SCHEMA), `line fails the schema: ${line}`);
}

test('the schema sha256 equals PROTOCOL_SCHEMA_SHA256', () => {
  const bytes = readFileSync(SCHEMA_PATH);
  const sha = createHash('sha256').update(bytes).digest('hex');
  assert.match(PROTOCOL_SCHEMA_SHA256, /^[0-9a-f]{64}$/);
  assert.equal(PROTOCOL_SCHEMA_SHA256, sha);
});

test('the schema uses only the supported subset', () => {
  const allowed = new Set(['$schema', 'title', 'description', 'type', 'required', 'properties', 'enum', 'pattern', 'items', 'oneOf', 'const']);
  const visit = (node: unknown): void => {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return;
    for (const [key, entry] of Object.entries(node as Record<string, unknown>)) {
      assert.ok(allowed.has(key), `schema uses an unsupported keyword: ${key}`);
    }
    const schema = node as Record<string, unknown>;
    if (typeof schema['properties'] === 'object' && schema['properties'] !== null) {
      for (const sub of Object.values(schema['properties'] as Record<string, unknown>)) visit(sub);
    }
    if (schema['items'] !== undefined) visit(schema['items']);
    if (Array.isArray(schema['oneOf'])) {
      for (const branch of schema['oneOf'] as unknown[]) visit(branch);
    }
  };
  visit(SCHEMA);
});

test('every example in section 6 validates', () => {
  assertValid('{"protocol":1,"recorder":{"name":"example-recorder","version":"2.3.0"},"sources":["screen","x11"],"android":false,"events":["own","none"],"planner":{"available":true,"needsKey":true}}');
  assertValid('{"event":"consent-pending"}');
  assertValid('{"event":"recording","take":"/abs/root/take-7"}');
  assertValid('{"event":"done","take":"/abs/root/take-7","seconds":12.4,"warnings":[]}');
  assertValid('{"stopping":true}');
  assertValid('{"out":"/abs/root/take-7/out/take-7.mp4","seconds":12.4,"beats":6,"planner":{"planned_tokens":0,"input_tokens":0,"usd":0,"failed":false},"warnings":[]}');
  assertValid('{"out":null,"seconds":12.4,"beats":6,"planner":{"planned_tokens":1000,"input_tokens":0,"usd":0,"failed":false},"warnings":[]}');
  assertValid('{"error":{"code":"preflight-refused","message":"planned 48000 tokens, cap 40000","hint":"raise --max-tokens","planned":48000,"cap":40000}}');
  for (const code of ['invalid-arguments', 'unsupported-source', 'consent-cancelled', 'consent-timeout', 'capture-stopped', 'already-recording', 'not-recording', 'preflight-refused', 'take-input', 'render-failed', 'internal']) {
    assertValid(JSON.stringify({ error: { code, message: code } }));
  }
  assert.equal(validate(JSON.parse('{}'), SCHEMA), false);
});

test('every line the fake prints validates', async () => {
  const dir = scratchDir('capture-schema-fake');
  const fake = fakeRecorder({ dir, script: { seconds: 1 } });
  const hello = spawnSync(fake.bin, ['capture', 'hello'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(hello.status, 0);
  for (const line of hello.stdout.split('\n').filter((l) => l.trim() !== '')) assertValid(line);
  const root = join(dir, 'takes');
  const stateDir = join(dir, 'state');
  const rec = await new Promise<{ status: number | null; stdout: string }>((resolve, reject) => {
    const child = spawn(fake.bin, ['capture', 'record', '--source', 'screen', '--root', root, '--state-dir', stateDir, '--events', 'none', '--max-seconds', '5']);
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout }));
  });
  assert.equal(rec.status, 0);
  for (const line of rec.stdout.split('\n').filter((l) => l.trim() !== '')) assertValid(line);
  const recording = rec.stdout.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as { event?: string; take?: string }).find((l) => l.event === 'recording');
  assert.ok(recording?.take !== undefined);
  const take = recording.take as string;
  const stopIdle = spawnSync(fake.bin, ['capture', 'stop', '--state-dir', stateDir], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(stopIdle.status, 1);
  for (const line of stopIdle.stdout.split('\n').filter((l) => l.trim() !== '')) assertValid(line);
  const plan = spawnSync(fake.bin, ['capture', 'make', take, '--plan-only', '--no-planner'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(plan.status, 0);
  for (const line of plan.stdout.split('\n').filter((l) => l.trim() !== '')) assertValid(line);
  const made = spawnSync(fake.bin, ['capture', 'make', take, '--no-planner'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(made.status, 0);
  for (const line of made.stdout.split('\n').filter((l) => l.trim() !== '')) assertValid(line);
  fake.script({ consent: 'no' });
  const root2 = join(dir, 'takes2');
  const refused = await new Promise<{ status: number | null; stdout: string }>((resolve, reject) => {
    const child = spawn(fake.bin, ['capture', 'record', '--source', 'screen', '--root', root2, '--state-dir', join(dir, 'state2'), '--events', 'none', '--max-seconds', '5']);
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout }));
  });
  assert.equal(refused.status, 1);
  for (const line of refused.stdout.split('\n').filter((l) => l.trim() !== '')) assertValid(line);
  assert.ok(existsSync(take));
});
