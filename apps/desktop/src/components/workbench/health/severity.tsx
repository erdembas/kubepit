import { CircleAlert, Info, OctagonAlert, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { BadgeTone } from '@/components/ui/Badge';
import { resolveRef } from '@/lib/kube/catalog';
import type { Category, FindingRef, Severity } from '@/lib/kube/health';
import { navigateTo } from '@/store/useWorkbenchStore';
import type { ApiResourceInfo } from '@/types';

/** Visual language of health findings (literal class names for Tailwind's scanner). */

export const SEVERITY_ICON: Record<Severity, LucideIcon> = {
  critical: OctagonAlert,
  warning: TriangleAlert,
  info: Info,
};

export const SEVERITY_TEXT: Record<Severity, string> = {
  critical: 'text-status-error',
  warning: 'text-status-starting',
  info: 'text-cat-frontend',
};

export const SEVERITY_FILL: Record<Severity, string> = {
  critical: 'bg-status-error',
  warning: 'bg-status-starting',
  info: 'bg-cat-frontend',
};

export const SEVERITY_BADGE: Record<Severity, BadgeTone> = {
  critical: 'critical',
  warning: 'warning',
  info: 'info',
};

export const CATEGORY_FILL: Record<Category, string> = {
  reliability: 'bg-cat-backend',
  security: 'bg-cat-database',
  efficiency: 'bg-cat-infra',
  hygiene: 'bg-cat-tooling',
};

export const GenericFindingIcon = CircleAlert;

/** Score tint: green from 80, amber from 60, red below. */
export function scoreStroke(score: number): string {
  if (score >= 80) return 'stroke-status-running';
  if (score >= 60) return 'stroke-status-starting';
  return 'stroke-status-error';
}

export function scoreText(score: number): string {
  if (score >= 80) return 'text-status-running';
  if (score >= 60) return 'text-status-starting';
  return 'text-status-error';
}

/** Opens the object of a finding in its kind's tab (details panel selected). */
export function openFindingObject(
  clusterId: string,
  ref: FindingRef,
  apiResources: readonly ApiResourceInfo[] | null,
) {
  const gvk = resolveRef(ref.apiVersion, ref.kind, apiResources);
  if (gvk) navigateTo(clusterId, gvk, ref.namespace, ref.name);
}
