import * as i18n from '@/i18n';
import type { Coverage, NpSelection, Protocol, ReachState } from '@/lib/kube/netpol';

/** Literal class names (Tailwind scans them) and labels shared by the simulator UI. */

export const COVERAGE_TEXT: Record<Coverage, string> = {
  all: 'text-status-running',
  some: 'text-status-starting',
  none: 'text-status-error',
};

export const COVERAGE_DOT: Record<Coverage, string> = {
  all: 'bg-status-running',
  some: 'bg-status-starting',
  none: 'bg-status-error',
};

export const COVERAGE_FILL: Record<Coverage, string> = {
  all: 'fill-status-running/75',
  some: 'fill-status-starting/75',
  none: 'fill-status-error/60',
};

export const REACH_STROKE: Record<ReachState, string> = {
  source: 'stroke-accent',
  allowed: 'stroke-status-running',
  partial: 'stroke-status-starting',
  denied: 'stroke-status-error',
};

export const REACH_FILL: Record<ReachState, string> = {
  source: 'fill-accent',
  allowed: 'fill-status-running',
  partial: 'fill-status-starting',
  denied: 'fill-status-error',
};

export const REACH_DOT: Record<ReachState, string> = {
  source: 'bg-accent',
  allowed: 'bg-status-running',
  partial: 'bg-status-starting',
  denied: 'bg-status-error',
};

export function coverageLabel(c: Coverage): string {
  switch (c) {
    case 'all':
      return i18n.t('Allowed');
    case 'some':
      return i18n.t('Partly allowed');
    default:
      return i18n.t('Denied');
  }
}

export function reachLabel(s: ReachState): string {
  switch (s) {
    case 'source':
      return i18n.t('Source');
    case 'allowed':
      return i18n.t('Allowed');
    case 'partial':
      return i18n.t('Partly allowed');
    default:
      return i18n.t('Denied');
  }
}

export const PROTOCOL_OPTIONS: Array<{ value: Protocol; label: string }> = [
  { value: 'TCP', label: 'TCP' },
  { value: 'UDP', label: 'UDP' },
  { value: 'SCTP', label: 'SCTP' },
];

/** Typed port text → query port (number, named port, or null for declared ports). */
export function parsePortInput(text: string): number | string | null | 'invalid' {
  const t = text.trim();
  if (!t) return null;
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    return n >= 1 && n <= 65535 ? n : 'invalid';
  }
  return /^[a-z0-9]([a-z0-9-]{0,13}[a-z0-9])?$/i.test(t) ? t : 'invalid';
}

/** Short text of a selection: `checkout/payment-api`, `Deployment web/storefront`, `0.0.0.0/0`. */
export function selectionText(sel: NpSelection): string {
  switch (sel.type) {
    case 'pod':
      return `${sel.namespace}/${sel.name}`;
    case 'workload':
      return `${sel.kind} ${sel.namespace}/${sel.name}`;
    case 'namespace':
      return sel.name;
    case 'service':
      return `Service ${sel.namespace}/${sel.name}`;
    case 'external':
      return sel.cidr;
  }
}
