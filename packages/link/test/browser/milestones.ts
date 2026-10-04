// Fixed labels only: no URLs, pairing material, page text or error payloads enter diagnostics.
import type { LinkStatus } from '../../src/index.ts';

export const milestones = [
  'page-loaded', 'module-loaded', 'module-error', 'module-started',
  'offer-pairing', 'offer-paired', 'state-requested', 'state-received',
  'code-pairing', 'code-paired', 'short-state-requested', 'short-state-received', 'report-requested',
] as const;
const statuses: LinkStatus[] = ['connecting', 'online', 'offline', 'refused', 'removed'];
export const allowedMilestones = new Set<string>([
  ...milestones, ...statuses.flatMap((s) => [`offer-${s}`, `code-${s}`]),
]);
type Milestone = typeof milestones[number] | `${'offer' | 'code'}-${LinkStatus}`;

export function milestone(step: Milestone): void {
  void fetch(`/milestone/${step}`, { method: 'POST', keepalive: true }).catch(() => {});
}
