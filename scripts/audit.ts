import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Temporary policy, not a fix: CONTRIBUTING.md#dependency-audit-exception.
// 2026-10-02; remove via byk-audit-exception-remove when upstream is patched.
const exception = 'https://github.com/advisories/GHSA-86w9-cpqp-85rv';
const levels = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 } as const;
type Severity = keyof typeof levels;
type Advisory = { url: string; severity: Severity };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function severity(v: unknown): Severity {
  if (typeof v !== 'string' || !Object.hasOwn(levels, v)) throw new Error('Invalid audit severity');
  return v as Severity;
}

/** Validate npm audit v2 and remove only the exact advisory's severity contribution. */
export function assessAudit(text: string, status: number | null) {
  const report: unknown = JSON.parse(text);
  if ((status !== 0 && status !== 1) || !record(report) || 'error' in report || report.auditReportVersion !== 2 ||
      !record(report.vulnerabilities) || !record(report.metadata) || !record(report.metadata.vulnerabilities)) {
    throw new Error('Unavailable or malformed audit report');
  }
  const nodes = report.vulnerabilities, counts = report.metadata.vulnerabilities;
  const original = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  for (const [name, node] of Object.entries(nodes)) {
    if (!record(node) || node.name !== name || !Array.isArray(node.via) || !node.via.length) throw new Error('Invalid audit node');
    original[severity(node.severity)]++;
  }
  for (const level of Object.keys(levels) as Severity[]) {
    if (counts[level] !== original[level]) throw new Error('Incomplete audit counts');
  }
  if (counts.total !== Object.values(original).reduce((a, b) => a + b, 0) ||
      status !== Number(original.high + original.critical > 0)) throw new Error('Inconsistent audit status');

  const memo = new Map<string, Advisory[]>(), active = new Set<string>();
  function roots(name: string): Advisory[] {
    const cached = memo.get(name);
    if (cached) return cached;
    const node = nodes[name];
    if (!record(node) || !Array.isArray(node.via) || active.has(name)) throw new Error('Missing or cyclic audit path');
    active.add(name);
    const result: Advisory[] = [];
    for (const via of node.via) {
      if (typeof via === 'string') { result.push(...roots(via)); continue; }
      if (!record(via) || typeof via.url !== 'string' || !via.url || typeof via.name !== 'string' ||
          typeof via.dependency !== 'string' || typeof via.range !== 'string' || !Number.isInteger(via.source)) {
        throw new Error('Invalid audit advisory');
      }
      result.push({ url: via.url, severity: severity(via.severity) });
    }
    if (Math.max(...result.map(a => levels[a.severity])) !== levels[severity(node.severity)]) {
      throw new Error('Unexplained audit severity');
    }
    active.delete(name); memo.set(name, result);
    return result;
  }
  const remaining = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  const blocked: string[] = [], excludedHighPaths: string[] = [];
  for (const [name, node] of Object.entries(nodes)) {
    const all = roots(name), kept = all.filter(a => a.url !== exception);
    const rank = Math.max(-1, ...kept.map(a => levels[a.severity]));
    if (rank >= 0) {
      const level = (Object.keys(levels) as Severity[]).find(s => levels[s] === rank)!;
      remaining[level]++;
      if (rank >= levels.high) blocked.push(name);
    }
    if (record(node) && levels[severity(node.severity)] >= levels.high && rank < levels.high) excludedHighPaths.push(name);
  }
  return { exception, excludedHighPaths, remaining, blocked };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = spawnSync('npm', ['audit', '--audit-level=high', '--json'], { encoding: 'utf8', timeout: 120_000 });
    if (result.error || result.signal) throw new Error('Audit command unavailable');
    const assessment = assessAudit(result.stdout, result.status);
    console.log(JSON.stringify(assessment, null, 2));
    process.exitCode = assessment.blocked.length ? 1 : 0;
  } catch {
    console.error('Dependency audit failed: unavailable, erroneous or malformed report.');
    process.exitCode = 1;
  }
}
