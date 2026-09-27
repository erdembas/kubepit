import * as i18n from '@/i18n/core';
import type { BadgeTone } from '@/components/ui/Badge';
import type { ManifestSourceKind } from '@/types';
import type { Badge, Filter } from './model';

export const BADGE_TONE: Record<Badge, BadgeTone> = {
  create: 'success',
  update: 'info',
  unchanged: 'neutral',
  error: 'critical',
};

/** Short cell label (`kubectl diff` vocabulary). */
export function badgeLabel(badge: Badge): string {
  if (badge === 'create') return i18n.t('New');
  if (badge === 'update') return i18n.t('Changed');
  if (badge === 'unchanged') return i18n.t('Unchanged');
  return i18n.t('Error');
}

export function filterLabel(filter: Filter): string {
  if (filter === 'all') return i18n.t('All');
  if (filter === 'error') return i18n.t('Errors');
  return badgeLabel(filter);
}

export function kindLabel(kind: ManifestSourceKind): string {
  if (kind === 'plain') return i18n.t('Plain YAML');
  if (kind === 'kustomize') return 'Kustomize';
  if (kind === 'helm') return i18n.t('Helm chart');
  return i18n.t('Detect');
}

/** Last segment of a path (folder or file name). */
export function baseName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() || path
  );
}
