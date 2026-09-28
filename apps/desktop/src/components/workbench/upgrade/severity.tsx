import * as i18n from '@/i18n/core';
import { OctagonAlert, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { BadgeTone } from '@/components/ui/Badge';
import type { UpgradeSeverity } from '@/types';

/** Visual language of upgrade findings (literal class names for Tailwind's scanner). */

export const SEVERITY_ICON: Record<UpgradeSeverity, LucideIcon> = {
  blocker: OctagonAlert,
  warning: TriangleAlert,
};

export const SEVERITY_TEXT: Record<UpgradeSeverity, string> = {
  blocker: 'text-status-error',
  warning: 'text-status-starting',
};

export const SEVERITY_FILL: Record<UpgradeSeverity, string> = {
  blocker: 'bg-status-error',
  warning: 'bg-status-starting',
};

export const SEVERITY_BADGE: Record<UpgradeSeverity, BadgeTone> = {
  blocker: 'critical',
  warning: 'warning',
};

export function severityLabel(severity: UpgradeSeverity): string {
  return severity === 'blocker' ? i18n.t('Blockers') : i18n.t('Warnings');
}
