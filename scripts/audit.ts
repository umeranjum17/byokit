import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Temporary policy, not a fix: CONTRIBUTING.md#dependency-audit-exception.
// 2026-10-02; remove via byk-audit-exception-remove when upstream is patched.
const exception = 'https://github.com/advisories/GHSA-86w9-cpqp-85rv';
const levels = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 } as const;
type Severity = keyof typeof levels;
const bracesException = {
  ghsa: 'GHSA-vfj7-8cjw-p6xm', package: 'braces', range: '<=3.0.3',
  reason: 'Accepted build-tool DoS risk via developer-config glob patterns, no user input, no patched release exists; not newly proved input safety.',
  expires: '2026-11-02T00:00:00.000Z',
} as const;
type Advisory = { url: string; severity: Severity; name: string; dependency: string; range: string };

export async function loadBracesAdvisory(fetcher: typeof fetch = fetch): Promise<unknown> {
  const response = await fetcher(`https://api.github.com/advisories/${bracesException.ghsa}`, {
    headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error('Braces advisory metadata unavailable');
  return response.json();
}

function approveBraces(metadata: unknown, now: number) {
  if (!Number.isFinite(now) || now >= Date.parse(bracesException.expires)) throw new Error('Braces exception expired');
  if (!record(metadata) || metadata.ghsa_id !== bracesException.ghsa ||
      !Array.isArray(metadata.vulnerabilities) || metadata.vulnerabilities.length !== 1) {
    throw new Error('Invalid braces advisory metadata');
  }
  const v: unknown = metadata.vulnerabilities[0];
  if (!record(v) || !record(v.package) || v.package.ecosystem !== 'npm' || v.package.name !== bracesException.package ||
      v.vulnerable_version_range !== '<= 3.0.3' || !Object.hasOwn(v, 'first_patched_version')) {
    throw new Error('Invalid braces advisory metadata');
  }
  if (v.first_patched_version !== null) throw new Error('Braces exception closed: patched release or invalid patch metadata');
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function severity(v: unknown): Severity {
  if (typeof v !== 'string' || !Object.hasOwn(levels, v)) throw new Error('Invalid audit severity');
  return v as Severity;
}

/** Validate npm audit v2 and remove only the exact advisory's severity contribution. */
export function assessAudit(text: string, status: number | null, bracesMetadata?: unknown, now = Date.now()) {
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

  const memo = new Map<string, Advisory[]>();
  function roots(name: string): Advisory[] {
    const cached = memo.get(name);
    if (cached) return cached;
    // ponytail: per-node graph walk is O(V*(V+E)); use SCCs if audit size makes this costly.
    const visited = new Set<string>(), pending = [name], result: Advisory[] = [];
    while (pending.length) {
      const current = pending.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      const node = nodes[current];
      if (!record(node) || !Array.isArray(node.via)) throw new Error('Missing audit path');
      for (const via of node.via) {
        if (typeof via === 'string') { pending.push(via); continue; }
        if (!record(via) || typeof via.url !== 'string' || !via.url || typeof via.name !== 'string' ||
            typeof via.dependency !== 'string' || typeof via.range !== 'string' || !Number.isInteger(via.source)) {
          throw new Error('Invalid audit advisory');
        }
        result.push({ url: via.url, severity: severity(via.severity), name: via.name, dependency: via.dependency, range: via.range });
      }
    }
    const node = nodes[name] as Record<string, unknown>;
    if (Math.max(...result.map(a => levels[a.severity])) !== levels[severity(node.severity)]) {
      throw new Error('Unexplained audit severity');
    }
    memo.set(name, result);
    return result;
  }
  const remaining = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  const blocked: string[] = [], excludedHighPaths: string[] = [];
  for (const [name, node] of Object.entries(nodes)) {
    const all = roots(name), kept = all.filter(a => {
      if (a.url === exception) return false;
      if (a.url !== `https://github.com/advisories/${bracesException.ghsa}` || a.name !== bracesException.package ||
          a.dependency !== bracesException.package || a.range !== bracesException.range) return true;
      approveBraces(bracesMetadata, now);
      return false;
    });
    const rank = Math.max(-1, ...kept.map(a => levels[a.severity]));
    if (rank >= 0) {
      const level = (Object.keys(levels) as Severity[]).find(s => levels[s] === rank)!;
      remaining[level]++;
      if (rank >= levels.high) blocked.push(name);
    }
    if (record(node) && levels[severity(node.severity)] >= levels.high && rank < levels.high) excludedHighPaths.push(name);
  }
  return { exception, bracesException, excludedHighPaths, remaining, blocked };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = spawnSync('npm', ['audit', '--audit-level=high', '--json'], { encoding: 'utf8', timeout: 120_000 });
    if (result.error || result.signal) {
      throw new Error(`npm audit could not run: ${result.error?.message ?? `killed by signal ${result.signal}`}`);
    }
    const report: unknown = JSON.parse(result.stdout);
    const hasBraces = record(report) && record(report.vulnerabilities) && Object.values(report.vulnerabilities).some(node =>
      record(node) && Array.isArray(node.via) && node.via.some(via => record(via) &&
        via.url === `https://github.com/advisories/${bracesException.ghsa}`));
    const metadata = hasBraces ? await loadBracesAdvisory() : undefined;
    const assessment = assessAudit(result.stdout, result.status, metadata);
    console.log(JSON.stringify(assessment, null, 2));
    process.exitCode = assessment.blocked.length ? 1 : 0;
  } catch (error) {
    // Unavailable tool, not an advisory finding: keep failing closed, but show the raw cause.
    console.error(`Dependency audit tool unavailable: ${error instanceof Error ? error.message : String(error)}`);
    console.error('No audit report means no verification, so the gate fails. This is a tool failure, not an advisory.');
    process.exitCode = 1;
  }
}
