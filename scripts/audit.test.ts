import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessAudit, loadBracesAdvisory } from './audit.ts';
import { readFileSync } from 'node:fs';

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
const check = (nodes: Parameters<typeof report>[0], metadata?: unknown, now?: number) => {
  const value = report(nodes);
  return assessAudit(JSON.stringify(value), Number(value.metadata.vulnerabilities.high + value.metadata.vulnerabilities.critical > 0), metadata, now);
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

test('missing or rootless cyclic transitive paths fail closed', () => {
  assert.throws(() => check({ expo: node('expo', ['missing']) }));
  assert.throws(() => check({ a: node('a', ['b']), b: node('b', ['a']) }));
});

test('registry errors, unavailable commands and abnormal exit statuses fail closed', () => {
  const good = report({ 'node-forge': node('node-forge', [advisory()]) });
  for (const status of [null, 2, -1]) assert.throws(() => assessAudit(JSON.stringify(good), status));
  assert.throws(() => assessAudit(JSON.stringify({ ...good, error: { code: 'E503' } }), 1));
});

const bracesId = 'GHSA-vfj7-8cjw-p6xm';
const braces = { ...advisory(bracesId), name: 'braces', dependency: 'braces', range: '<=3.0.3' };
const unpatched = { ghsa_id: bracesId, vulnerabilities: [{ package: { ecosystem: 'npm', name: 'braces' },
  vulnerable_version_range: '<= 3.0.3', first_patched_version: null }] };
const beforeExpiry = Date.parse('2026-11-01T23:59:59.999Z');
const bracesNode = (a = braces) => ({ braces: node('braces', [a]) });

test('braces exception matches only exact GHSA, package, dependency and affected range', () => {
  assert.deepEqual(check(bracesNode(), unpatched, beforeExpiry).blocked, []);
  for (const a of [{ ...braces, name: 'other' }, { ...braces, dependency: 'other' },
    { ...braces, range: '<=3.0.4' }, { ...braces, url: braces.url + '?other' },
    { ...braces, url: advisory('GHSA-aaaa-bbbb-cccc').url }]) {
    assert.deepEqual(check(bracesNode(a), unpatched, beforeExpiry).blocked, ['braces']);
  }
});

test('expiry has a hard UTC boundary and a patched version closes the exception', () => {
  for (const now of [Date.parse('2026-11-02T00:00:00Z'), Date.parse('2027-01-01'), NaN]) {
    assert.throws(() => check(bracesNode(), unpatched, now), /expired/);
  }
  const patched = { ...unpatched, vulnerabilities: [{ ...unpatched.vulnerabilities[0], first_patched_version: { identifier: '3.0.4' } }] };
  assert.throws(() => check(bracesNode(), patched, beforeExpiry), /patched release/);
});

test('unavailable or malformed authoritative metadata never approves braces', async () => {
  for (const metadata of [undefined, null, {}, { ...unpatched, ghsa_id: ignored },
    { ...unpatched, vulnerabilities: [] }, { ...unpatched, vulnerabilities: [unpatched.vulnerabilities[0], unpatched.vulnerabilities[0]] },
    ...[undefined, false, ''].map(first_patched_version => ({ ...unpatched,
      vulnerabilities: [{ ...unpatched.vulnerabilities[0], first_patched_version }] })),
    { ...unpatched, vulnerabilities: [{ package: { ecosystem: 'npm', name: 'other' }, first_patched_version: null }] },
    { ...unpatched, vulnerabilities: [{ ...unpatched.vulnerabilities[0], vulnerable_version_range: '<= 3.0.4' }] },
    { ...unpatched, vulnerabilities: [{ package: unpatched.vulnerabilities[0].package, vulnerable_version_range: '<= 3.0.3' }] }]) {
    assert.throws(() => check(bracesNode(), metadata, beforeExpiry));
  }
  await assert.rejects(loadBracesAdvisory(async () => { throw new Error('network unavailable'); }));
  await assert.rejects(loadBracesAdvisory(async () => new Response('{}', { status: 503 })));
  await assert.rejects(loadBracesAdvisory(async () => new Response('invalid json')));
  assert.deepEqual(await loadBracesAdvisory(async input => {
    assert.equal(input, `https://api.github.com/advisories/${bracesId}`);
    return Response.json(unpatched);
  }), unpatched);
});

const retained = readFileSync(new URL('./fixtures/audit-expo-braces.json', import.meta.url), 'utf8');
test('retained Metro/ReactNative cyclic report passes only with exact braces exception', () => {
  assert.throws(() => assessAudit(retained, 1), /metadata/);
  const accepted = assessAudit(retained, 1, unpatched, beforeExpiry);
  assert.deepEqual(accepted.blocked, []);
  console.log('retained fixture ACCEPT:', JSON.stringify(accepted));
  for (const severity of ['high', 'critical']) {
    const modified = JSON.parse(retained);
    modified.vulnerabilities['metro-config'].via.push({ ...advisory('GHSA-aaaa-bbbb-cccc', severity),
      name: 'metro-config', dependency: 'metro-config', range: '*' });
    // Critical propagates through every node reaching the cycle; preserve valid report counts.
    if (severity === 'critical') {
      const reaches = (name: string, seen = new Set<string>()): boolean => {
        if (name === 'metro-config') return true;
        if (seen.has(name)) return false;
        seen.add(name);
        return modified.vulnerabilities[name].via.some((v: unknown) => typeof v === 'string' && reaches(v, seen));
      };
      for (const name of Object.keys(modified.vulnerabilities)) if (reaches(name)) modified.vulnerabilities[name].severity = 'critical';
    }
    const altered = JSON.stringify(report(modified.vulnerabilities));
    const rejected = assessAudit(altered, 1, unpatched, beforeExpiry);
    assert.ok(rejected.blocked.includes('metro-config'));
    assert.ok(rejected.blocked.includes('metro'));
    console.log(`retained fixture + cycle ${severity} REJECT:`, JSON.stringify(rejected.blocked));
  }
  for (const text of [retained.slice(0, -20), JSON.stringify({ ...JSON.parse(retained), error: { code: 'E503' } })]) {
    assert.throws(() => assessAudit(text, 1, unpatched, beforeExpiry));
    console.log('invalid/truncated retained fixture REJECT');
  }
});

test('cycles still require explained per-node severity and existing paths', () => {
  assert.throws(() => check({ a: node('a', ['b'], 'moderate'), b: node('b', ['a', advisory()]) }));
  assert.throws(() => check({ a: node('a', ['b', 'missing']), b: node('b', ['a', advisory()]) }));
});
