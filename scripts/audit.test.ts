// Tests for scripts/audit.ts: a node's severity is npm's worst advisory for that node itself, which is
// not always the worst advisory its transitive path reaches. Fixtures are trimmed from real `npm audit
// --json` (v2) output. No network.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { assessAudit } from "./audit.ts";

const levels = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };

// Real report shape: a node whose only via entry is an advisory object affecting it directly.
const ipAddress = {
  name: 'ip-address', severity: 'moderate', isDirect: false, effects: [], range: '<=10.7.3',
  nodes: ['node_modules/ip-address'], fixAvailable: true,
  via: [{
    source: 1242883, name: 'ip-address', dependency: 'ip-address',
    title: 'ip-address: Address6 matches a zone identifier in quadratic time',
    url: 'https://github.com/advisories/GHSA-rxp7-6hxx-x8q5', severity: 'moderate', cwe: ['CWE-1333'],
    cvss: { score: 0, vectorString: null }, range: '<=10.7.3',
  }],
};
const minimatch = {
  name: 'minimatch', severity: 'moderate', isDirect: false, effects: ['@expo/fingerprint', 'glob'], range: '<11.0.1',
  nodes: ['node_modules/minimatch'], fixAvailable: { name: 'expo', version: '51.0.39', isSemVerMajor: true },
  via: [{
    source: 1244012, name: 'minimatch', dependency: 'minimatch',
    title: 'minimatch has potential denial of service via globparts amplification',
    url: 'https://github.com/advisories/GHSA-g3hv-75wg-m249', severity: 'moderate', cwe: ['CWE-405'],
    cvss: { score: 0, vectorString: null }, range: '<11.0.1',
  }],
};
const expoConfig = {
  name: '@expo/config', severity: 'moderate', isDirect: false, via: ['minimatch'], effects: ['expo'],
  range: '>=9.1.0-canary-20240628-1ba8152', nodes: ['node_modules/@expo/config'],
  fixAvailable: { name: 'expo', version: '51.0.39', isSemVerMajor: true },
};
const localBuildCache = {
  name: '@expo/local-build-cache-provider', severity: 'low', isDirect: false, via: ['@expo/config'],
  effects: ['expo'], range: '*', nodes: ['node_modules/@expo/local-build-cache-provider'],
  fixAvailable: { name: 'expo', version: '51.0.39', isSemVerMajor: true },
};

function report(vulnerabilities: Record<string, { severity: keyof typeof levels }>) {
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  for (const node of Object.values(vulnerabilities)) counts[node.severity]++;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return JSON.stringify({
    auditReportVersion: 2, vulnerabilities,
    metadata: { vulnerabilities: { ...counts, total }, dependencies: { prod: 0, dev: 0, optional: 0, peer: 0, peerOptional: 0, total } },
  });
}

test('a node whose severity is its own direct advisory is accepted', () => {
  const assessment = assessAudit(report({ 'ip-address': ipAddress }), 0);
  assert.deepEqual(assessment.blocked, []);
  assert.deepEqual(assessment.remaining, { info: 0, low: 0, moderate: 1, high: 0, critical: 0 });
});

test('a node below the worst advisory its transitive path reaches is accepted', () => {
  const nodes = { '@expo/config': expoConfig, minimatch, '@expo/local-build-cache-provider': localBuildCache };
  // The old rule compared against this walk, so the fixture has to reach further than the node's own severity.
  assert.ok(levels.moderate > levels[localBuildCache.severity]);
  const assessment = assessAudit(report(nodes), 0);
  assert.deepEqual(assessment.blocked, []);
  assert.deepEqual(assessment.remaining, { info: 0, low: 0, moderate: 3, high: 0, critical: 0 });
});

test('a node below a direct advisory of its own still fails closed', () => {
  const undermined = { ...ipAddress, severity: 'low' as const };
  assert.throws(() => assessAudit(report({ 'ip-address': undermined }), 0), /Unexplained audit severity/);
});
