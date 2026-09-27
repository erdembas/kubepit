import * as i18n from '@/i18n';
import { Lock } from 'lucide-react';
import { clusterColor, clusterInitials, environmentMeta } from '@/lib/clusterMeta';
import { cn } from '@/lib/cn';
import type { ClusterDef } from '@/types';

export function ClusterAvatar({
  cluster,
  size = 'sm',
}: {
  cluster: ClusterDef;
  size?: 'sm' | 'lg';
}) {
  i18n.useLocale();
  return (
    <span
      aria-hidden
      className={cn(
        'flex shrink-0 items-center justify-center font-semibold tracking-tight text-white shadow-[inset_0_0_0_1px_rgb(255_255_255/0.12)]',
        size === 'lg' ? 'h-14 w-14 rounded-2xl text-[18px]' : 'h-6 w-6 rounded-md text-[10px]',
      )}
      style={{ backgroundColor: clusterColor(cluster) }}
    >
      {clusterInitials(cluster.name)}
    </span>
  );
}

export function EnvPill({ cluster }: { cluster: ClusterDef }) {
  i18n.useLocale();
  const env = environmentMeta(cluster.environment);
  if (!env) return null;
  return (
    <span
      className={cn('shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold ring-1', env.pill)}
    >
      {env.label}
    </span>
  );
}

export function ReadOnlyBadge() {
  i18n.useLocale();
  return (
    <span
      title={i18n.t('Read-only cluster: changes are blocked')}
      className="bg-fg/5 text-fg-muted inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium"
    >
      <Lock className="h-2.5 w-2.5" />
      {i18n.t('Read-only')}
    </span>
  );
}
