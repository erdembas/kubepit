import * as i18n from '@/i18n';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { kindKey, resolveKindName } from '@/lib/kube/catalog';
import { kindIcon } from '@/lib/kube/icons';
import type { HelmPreviewChange } from '@/types';

/** Small pieces shared by the deploy dialog's previews. */

export function kindIconFor(kind: string) {
  const gvk = resolveKindName(kind);
  return kindIcon(gvk ? kindKey(gvk) : kind);
}

const CHANGE_TONE: Record<HelmPreviewChange, BadgeTone> = {
  added: 'success',
  changed: 'warning',
  removed: 'critical',
  unchanged: 'neutral',
};

export function changeLabel(change: HelmPreviewChange): string {
  switch (change) {
    case 'added':
      return i18n.t('Added');
    case 'changed':
      return i18n.t('Changed');
    case 'removed':
      return i18n.t('Removed');
    default:
      return i18n.t('Unchanged');
  }
}

export function ChangeBadge({ change, count }: { change: HelmPreviewChange; count?: number }) {
  i18n.useLocale();
  const label = changeLabel(change);
  return (
    <Badge tone={CHANGE_TONE[change]} size="xs">
      {count === undefined ? label : `${label} ${count}`}
    </Badge>
  );
}
