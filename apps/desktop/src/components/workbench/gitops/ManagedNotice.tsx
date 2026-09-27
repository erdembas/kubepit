import * as i18n from '@/i18n';
import { useMemo } from 'react';
import YAML from 'yaml';
import { GitBranch } from 'lucide-react';
import { isObject } from '@/lib/kube/accessors';
import { cn } from '@/lib/cn';
import { navigateTo } from '@/store/useWorkbenchStore';
import type { ClusterId, KubeObject } from '@/types';
import { ownerLabel, ownerWarning, useGitOpsOwner, type ResolvedOwner } from './owner';

/** Open the owning Application / Kustomization / HelmRelease (when it lives in this cluster). */
function openOwner(clusterId: ClusterId, owner: ResolvedOwner) {
  if (!owner.gvk || !owner.obj) return;
  navigateTo(clusterId, owner.gvk, owner.obj.metadata.namespace ?? null, owner.obj.metadata.name);
}

const TONE = {
  revert: 'border-tone-warning/30 bg-tone-warning/8 text-tone-warning-fg',
  drift: 'border-tone-info/30 bg-tone-info/8 text-tone-info-fg',
  paused: 'border-border/60 bg-fg/[0.03] text-fg-muted',
} as const;

/** "Managed by GitOps" badge for the details header; links to the owner. */
export function GitOpsBadge({
  clusterId,
  obj,
  isActive,
}: {
  clusterId: ClusterId;
  obj: KubeObject;
  isActive: boolean;
}) {
  i18n.useLocale();
  const owner = useGitOpsOwner(clusterId, obj, isActive);
  if (!owner) return null;
  const warning = ownerWarning(owner);
  const linkable = !!owner.gvk && !!owner.obj;
  return (
    <button
      type="button"
      onClick={() => openOwner(clusterId, owner)}
      disabled={!linkable}
      title={linkable ? `${warning.text}\n${i18n.t('Click to open it.')}` : warning.text}
      aria-label={i18n.t('Managed by {owner}', { owner: ownerLabel(owner) })}
      className={cn(
        'mt-1 inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-px text-[10.5px] font-medium transition-colors',
        TONE[warning.severity],
        linkable ? 'hover:brightness-110' : 'cursor-default',
      )}
    >
      <GitBranch className="h-3 w-3 shrink-0" />
      <span className="truncate">{ownerLabel(owner)}</span>
    </button>
  );
}

/**
 * Warning strip for flows that change an object (edit, scale, set image).
 * `banner` spans a dock editor; `inline` sits inside a dialog body.
 */
export function GitOpsNotice({
  clusterId,
  obj,
  variant = 'inline',
}: {
  clusterId: ClusterId;
  obj: KubeObject | null;
  variant?: 'inline' | 'banner';
}) {
  i18n.useLocale();
  const owner = useGitOpsOwner(clusterId, obj, true);
  if (!owner) return null;
  const warning = ownerWarning(owner);
  const linkable = !!owner.gvk && !!owner.obj;
  return (
    <div
      role="note"
      className={cn(
        'flex shrink-0 items-start gap-2 text-[11.5px]',
        TONE[warning.severity],
        variant === 'banner' ? 'border-b px-3 py-1.5' : 'rounded-lg border px-3 py-2',
      )}
    >
      <GitBranch className="mt-0.5 h-3 w-3 shrink-0" />
      <span className="min-w-0 flex-1 break-words">{warning.text}</span>
      {linkable && (
        <button
          type="button"
          onClick={() => openOwner(clusterId, owner)}
          className="shrink-0 font-medium underline-offset-2 hover:underline"
        >
          {i18n.t('Open {kind}', { kind: owner.ref.kind })}
        </button>
      )}
    </div>
  );
}

/** Same notice for an editor that only has the object's YAML. */
export function GitOpsYamlNotice({ clusterId, yaml }: { clusterId: ClusterId; yaml: string }) {
  const obj = useMemo(() => {
    if (!yaml) return null;
    try {
      const doc: unknown = YAML.parse(yaml);
      return isObject(doc) && isObject(doc.metadata) ? (doc as unknown as KubeObject) : null;
    } catch {
      return null;
    }
  }, [yaml]);
  return <GitOpsNotice clusterId={clusterId} obj={obj} variant="banner" />;
}
