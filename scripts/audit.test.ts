import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessAudit } from './audit.ts';

const ignored = 'GHSA-86w9-cpqp-85rv';
const advisory = (id = ignored, severity = 'high') => ({ source: 1, name: 'node-forge', dependency: 'node-forge',
  url: `https://github.com/advisories/${id}`, severity, range: '<=1.4.0' });
const node = (name: string, via: unknown[], severity = 'high') => ({ name, via, severity });
function report(vulnerabilities: Record<string, ReturnType<typeof node>>) {
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  for (const v of Object.values(vulnerabilities)) counts[v.severity as keyof typeof counts]++;
  return { auditReportVersion: 2, vulnerabilities, metadata: { vulnerabilities: { ...counts,
    total: Object.values(counts).reduce((a, b) => a + b, 0) } } };
}
const check = (nodes: Parameters<typeof report>[0]) => {
  const value = report(nodes);
  return assessAudit(JSON.stringify(value), Number(value.metadata.vulnerabilities.high + value.metadata.vulnerabilities.critical > 0));
};

test('only exact advisory and its solely affected high paths are excluded', () => {
  const result = check({ 'node-forge': node('node-forge', [advisory()]),
    cert: node('cert', ['node-forge']), expo: node('expo', ['cert']) });
  assert.deepEqual(result.blocked, []);
  assert.deepEqual(result.excludedHighPaths, ['node-forge', 'cert', 'expo']);
  assert.equal(result.remaining.high, 0);
  assert.equal(check({}).excludedHighPaths.length, 0);
});

test('unrelated high and critical vulnerabilities still block', () => {
  for (const severity of ['high', 'critical']) {
    const result = check({ 'node-forge': node('node-forge', [advisory()]),
      other: node('other', [{ ...advisory('GHSA-aaaa-bbbb-cccc', severity), name: 'other', dependency: 'other' }], severity) });
    assert.deepEqual(result.blocked, ['other']);
  }
});

test('another node-forge advisory and its parents are not package-whitelisted', () => {
  const result = check({ 'node-forge': node('node-forge', [advisory(), advisory('GHSA-aaaa-bbbb-cccc')]),
    expo: node('expo', ['node-forge']) });
  assert.deepEqual(result.blocked, ['node-forge', 'expo']);
  assert.deepEqual(result.excludedHighPaths, []);
});

test('mixed paths retain unrelated high and moderate contributions', () => {
  const result = check({ 'node-forge': node('node-forge', [advisory()]),
    uuid: node('uuid', [advisory('GHSA-aaaa-bbbb-cccc', 'moderate')], 'moderate'),
    expo: node('expo', ['node-forge', 'uuid']) });
  assert.deepEqual(result.blocked, []);
  assert.equal(result.remaining.moderate, 2);
  const high = check({ 'node-forge': node('node-forge', [advisory()]), other: node('other', [advisory('GHSA-aaaa-bbbb-cccc')]),
    expo: node('expo', ['node-forge', 'other']) });
  assert.deepEqual(high.blocked, ['other', 'expo']);
});

test('a URL containing the exception is not an exact advisory match', () => {
  const result = check({ 'node-forge': node('node-forge', [{ ...advisory(), url: advisory().url + '?other' }]) });
  assert.deepEqual(result.blocked, ['node-forge']);
});

test('malformed, incomplete, inconsistent and unrecognized reports fail closed', () => {
  for (const text of ['bad json', '{}', 'null', JSON.stringify({ ...report({}), auditReportVersion: 3 }),
    JSON.stringify({ ...report({}), metadata: { vulnerabilities: { high: 1, total: 1 } } })]) {
    assert.throws(() => assessAudit(text, 0));
  }
  for (const value of [node('node-forge', []), node('node-forge', [{ ...advisory(), severity: 'unknown' }]),
    node('node-forge', [{ severity: 'high' }]), node('node-forge', [advisory()], 'low')]) {
    assert.throws(() => check({ 'node-forge': value }));
  }
  assert.throws(() => assessAudit(JSON.stringify(report({})), 1));
});

test('missing or cyclic transitive paths fail closed', () => {
  assert.throws(() => check({ expo: node('expo', ['missing']) }));
  assert.throws(() => check({ a: node('a', ['b']), b: node('b', ['a']) }));
});

test('registry errors, unavailable commands and abnormal exit statuses fail closed', () => {
  const good = report({ 'node-forge': node('node-forge', [advisory()]) });
  for (const status of [null, 2, -1]) assert.throws(() => assessAudit(JSON.stringify(good), status));
  assert.throws(() => assessAudit(JSON.stringify({ ...good, error: { code: 'E503' } }), 1));
});
