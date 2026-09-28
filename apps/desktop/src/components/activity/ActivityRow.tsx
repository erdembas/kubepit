import * as i18n from '@/i18n';
import { useState, type KeyboardEvent } from 'react';
import {
  Check,
  ChevronRight,
  ExternalLink,
  FlaskConical,
  Loader2,
  Undo2,
  UserRound,
  X,
} from 'lucide-react';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { DiffView } from '@/components/workbench/common/DiffView';
import { usePolled } from '@/components/workbench/data/polled';
import { openAndConnect } from '@/lib/clusterActions';
import { clusterColor } from '@/lib/clusterMeta';
import { cn } from '@/lib/cn';
import { formatAge } from '@/lib/format';
import {
  actionLabel,
  actionTone,
  formatDuration,
  isHelmTarget,
  requestSummary,
  resultText,
  targetKey,
  targetName,
  type ActionTone,
} from '@/lib/history/audit';
import { ipc } from '@/lib/ipc';
import { openObject } from '@/lib/navigation';
import { useAppStore } from '@/store/useAppStore';
import { useWorkbenchStore, VIEW } from '@/store/useWorkbenchStore';
import type { AuditDetail, AuditEntry, AuditObject, AuditTarget } from '@/types';

const TONE: Record<ActionTone, BadgeTone> = {
  danger: 'critical',
  change: 'info',
  neutral: 'neutral',
};

/** Open a target in its cluster's workbench (Helm releases in the Helm view). */
export function openTarget(clusterId: string, target: AuditTarget) {
  if (isHelmTarget(target)) {
    openAndConnect(clusterId);
    const store = useWorkbenchStore.getState();
    store.setActiveKind(clusterId, VIEW.helmReleases);
    store.select(clusterId, VIEW.helmReleases, {
      key: VIEW.helmReleases,
      namespace: target.namespace ?? '',
      name: target.name,
    });
    return;
  }
  openObject(clusterId, target.gvk?.kind ?? target.kind, target.namespace, target.name);
}

/** Targets that no longer exist after the action cannot be opened. */
function openable(entry: AuditEntry): boolean {
  return (
    entry.action !== 'delete' && entry.action !== 'helm-uninstall' && entry.action !== 'node-shell'
  );
}

/** One audited action; expands to its details, targets and before/after diff. */
export function ActivityRow({
  entry,
  now,
  expanded,
  onToggle,
  onRevert,
}: {
  entry: AuditEntry;
  now: number;
  expanded: boolean;
  onToggle: () => void;
  onRevert: (entry: AuditEntry, object: AuditObject) => void;
}) {
  i18n.useLocale();
  const cluster = useAppStore((s) => s.clusters.find((c) => c.id === entry.cluster_id) ?? null);
  const first = entry.targets[0];
  const more = entry.targets.length - 1;
  const failed = entry.outcome === 'error';
  const summary = requestSummary(entry);
  const result = resultText(entry);
  const label = `${actionLabel(entry.action)} ${first ? `${first.kind} ${targetName(first)}` : ''}`;
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onToggle();
    }
  };
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={label}
        onClick={onToggle}
        onKeyDown={onKeyDown}
        className={cn(
          'group flex cursor-pointer items-start gap-2.5 py-2 pr-3 pl-3 transition outline-none',
          'focus-visible:bg-fg/5',
          expanded ? 'bg-accent/8 shadow-[inset_2px_0_0_rgb(var(--accent))]' : 'hover:bg-fg/4',
        )}
      >
        <time
          dateTime={new Date(entry.ts).toISOString()}
          title={`${i18n.date(entry.ts, { dateStyle: 'medium', timeStyle: 'medium' })} · ${i18n.t('{age} ago', { age: formatAge(entry.ts, now) })}`}
          className="text-fg-dim w-[52px] shrink-0 pt-0.5 font-mono text-[11px] tabular-nums"
        >
          {i18n.date(entry.ts, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </time>
        <span
          aria-label={failed ? i18n.t('Failed') : i18n.t('Succeeded')}
          className={cn(
            'mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full',
            failed
              ? 'bg-status-error/12 text-status-error'
              : 'bg-status-running/12 text-status-running',
          )}
        >
          {failed ? (
            <X className="h-3 w-3" strokeWidth={2.5} />
          ) : (
            <Check className="h-3 w-3" strokeWidth={2.5} />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <Badge tone={TONE[actionTone(entry.action)]} size="xs" className="shrink-0">
              {actionLabel(entry.action)}
            </Badge>
            {entry.dry_run && (
              <Badge tone="neutral" size="xs" className="shrink-0" icon={<FlaskConical />}>
                {i18n.t('dry run')}
              </Badge>
            )}
            {first && (
              <span className="min-w-0 truncate text-[12.5px]">
                <span className="text-fg-dim text-[11px]">{first.kind}</span>{' '}
                <span className="text-fg font-medium">
                  {first.namespace && <span className="text-fg-muted">{first.namespace}/</span>}
                  {first.name}
                </span>
                {more > 0 && (
                  <span className="text-fg-dim ml-1 text-[11px]">
                    {i18n.plural('+{count} more', '+{count} more', more)}
                  </span>
                )}
              </span>
            )}
            <span className="ml-auto flex shrink-0 items-center gap-2 pl-2">
              {entry.revertible && (
                <Undo2
                  className="text-fg-dim hidden h-3 w-3 @lg:block"
                  aria-label={i18n.t('Can be reverted')}
                />
              )}
              <span className="text-fg-muted flex min-w-0 items-center gap-1.5 text-[11px]">
                <span
                  aria-hidden
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: cluster ? clusterColor(cluster) : 'rgb(var(--fg-dim))' }}
                />
                <span className="max-w-[140px] truncate" title={entry.context}>
                  {entry.cluster_name}
                </span>
              </span>
              {entry.identity && (
                <span
                  className="text-fg-dim hidden max-w-[160px] items-center gap-1 truncate text-[11px] @2xl:flex"
                  title={entry.identity}
                >
                  <UserRound className="h-3 w-3 shrink-0" />
                  <span className="truncate">{entry.identity}</span>
                </span>
              )}
              <span className="text-fg-dim hidden w-14 text-right font-mono text-[10.5px] tabular-nums @xl:inline">
                {formatDuration(entry.duration_ms)}
              </span>
              <ChevronRight
                aria-hidden
                className={cn(
                  'text-fg-dim h-3.5 w-3.5 transition-transform',
                  expanded && 'rotate-90',
                )}
              />
            </span>
          </div>
          {(summary || failed || result) && (
            <p className="mt-0.5 min-w-0 truncate text-[11.5px]">
              {failed ? (
                <span className="text-status-error" title={entry.error ?? undefined}>
                  {entry.error}
                </span>
              ) : (
                <span className="text-fg-muted font-mono">
                  {[summary, result].filter(Boolean).join(' · ')}
                </span>
              )}
            </p>
          )}
        </div>
      </div>
      {expanded && <ActivityDetail entry={entry} onRevert={onRevert} />}
    </li>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-fg-dim text-[10px] font-semibold tracking-[0.08em] uppercase">{label}</dt>
      <dd className="text-fg mt-0.5 min-w-0 truncate text-[12px]">{children}</dd>
    </div>
  );
}

function ActivityDetail({
  entry,
  onRevert,
}: {
  entry: AuditEntry;
  onRevert: (entry: AuditEntry, object: AuditObject) => void;
}) {
  i18n.useLocale();
  const detail = usePolled<AuditDetail>(
    entry.has_diff ? `activity|detail|${entry.id}` : null,
    () => ipc.historyAuditGet(entry.id),
    null,
  );
  const objects = detail.data?.objects ?? [];
  const [selected, setSelected] = useState(0);
  const object = objects[Math.min(selected, objects.length - 1)];
  const summary = requestSummary(entry);
  const result = resultText(entry);
  const canOpen = openable(entry);
  return (
    <div className="border-border/60 bg-surface-muted/30 border-y">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2.5 px-4 py-3 @lg:grid-cols-2 @3xl:grid-cols-4">
        <Field label={i18n.t('Cluster')}>
          <span title={entry.context}>{entry.cluster_name}</span>
          <span className="text-fg-dim ml-1.5 font-mono text-[10.5px]">{entry.context}</span>
        </Field>
        <Field label={i18n.t('Identity')}>
          {entry.identity ?? <span className="text-fg-dim">{i18n.t('Unknown')}</span>}
        </Field>
        <Field label={i18n.t('Started')}>
          {i18n.date(entry.ts, { dateStyle: 'medium', timeStyle: 'medium' })}
        </Field>
        <Field label={i18n.t('Duration')}>{formatDuration(entry.duration_ms)}</Field>
        {summary && <Field label={i18n.t('Parameters')}>{summary}</Field>}
        {result && (
          <Field label={i18n.t('Result')}>
            <span className="font-mono text-[11.5px]">{result}</span>
          </Field>
        )}
      </dl>
      {entry.error && (
        <p className="border-status-error/25 bg-status-error/5 text-status-error mx-4 mb-3 rounded-md border px-3 py-2 font-mono text-[11.5px] break-words whitespace-pre-wrap">
          {entry.error}
        </p>
      )}
      <div className="px-4 pb-3">
        <h4 className="text-fg-dim mb-1 text-[10px] font-semibold tracking-[0.08em] uppercase">
          {i18n.plural('{count} target', '{count} targets', entry.targets.length)}
        </h4>
        <ul className="space-y-0.5">
          {entry.targets.map((t, i) => (
            <li key={targetKey(t, i)} className="flex min-w-0 items-center gap-2 text-[12px]">
              <span
                className="text-fg-dim w-28 shrink-0 truncate text-[11px]"
                title={t.api_version}
              >
                {t.kind}
              </span>
              <span className="text-fg min-w-0 truncate font-mono text-[11.5px]">
                {targetName(t)}
              </span>
              {t.error && (
                <span className="text-status-error min-w-0 truncate text-[11px]" title={t.error}>
                  {t.error}
                </span>
              )}
              {canOpen && (
                <button
                  type="button"
                  onClick={() => openTarget(entry.cluster_id, t)}
                  className="text-fg-dim hover:text-accent ml-auto flex shrink-0 items-center gap-1 text-[11px]"
                >
                  <ExternalLink className="h-3 w-3" />
                  {i18n.t('Open')}
                </button>
              )}
            </li>
          ))}
        </ul>
        {entry.request && Object.keys(entry.request).length > 0 && (
          <details className="mt-2">
            <summary className="text-fg-dim hover:text-fg cursor-pointer text-[11px]">
              {i18n.t('Request')}
            </summary>
            <pre className="border-border/60 bg-surface text-fg-muted mt-1 max-h-48 overflow-auto rounded-md border p-2 font-mono text-[11px] leading-relaxed">
              {JSON.stringify(entry.request, null, 2)}
            </pre>
          </details>
        )}
      </div>
      {entry.has_diff &&
        (!detail.data ? (
          <div className="text-fg-muted flex h-20 items-center justify-center gap-2 text-[12px]">
            {detail.error ? (
              <span className="text-status-error px-4 text-center break-words">{detail.error}</span>
            ) : (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {i18n.t('Loading…')}
              </>
            )}
          </div>
        ) : (
          object && (
            <div className="border-border/60 border-t">
              {objects.length > 1 && (
                <div className="flex flex-wrap gap-1 px-3 pt-2" role="tablist">
                  {objects.map((o, i) => {
                    const t = entry.targets[o.target];
                    return (
                      <button
                        key={o.target}
                        type="button"
                        role="tab"
                        aria-selected={i === selected}
                        onClick={() => setSelected(i)}
                        className={cn(
                          'rounded-md px-2 py-0.5 font-mono text-[11px] transition',
                          i === selected
                            ? 'bg-fg/8 text-fg'
                            : 'text-fg-dim hover:bg-fg/5 hover:text-fg',
                        )}
                      >
                        {t ? `${t.kind}/${t.name}` : o.target}
                      </button>
                    );
                  })}
                </div>
              )}
              <ObjectDiff entry={entry} object={object} onRevert={onRevert} />
            </div>
          )
        ))}
    </div>
  );
}

function ObjectDiff({
  entry,
  object,
  onRevert,
}: {
  entry: AuditEntry;
  object: AuditObject;
  onRevert: (entry: AuditEntry, object: AuditObject) => void;
}) {
  i18n.useLocale();
  if (object.omitted)
    return (
      <p className="text-fg-dim px-4 py-3 text-[11.5px]">
        {i18n.t('This object was too large to keep in the history.')}
      </p>
    );
  const labels = !object.before_yaml
    ? [i18n.t('Did not exist'), i18n.t('After')]
    : !object.after_yaml
      ? [i18n.t('Before'), entry.action === 'delete' ? i18n.t('Deleted') : i18n.t('After')]
      : [i18n.t('Before'), i18n.t('After')];
  return (
    <div className="flex h-[340px] min-h-0 flex-col">
      <DiffView
        original={object.before_yaml ?? ''}
        modified={object.after_yaml ?? ''}
        originalLabel={labels[0]!}
        modifiedLabel={labels[1]!}
        identicalHint={i18n.t('Only bookkeeping fields changed.')}
        actions={
          object.revertible ? (
            <Button
              size="xs"
              variant="secondary"
              leftIcon={<Undo2 className="h-3 w-3" />}
              onClick={() => onRevert(entry, object)}
              title={i18n.t('Review a revert of this change')}
            >
              {i18n.t('Revert…')}
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}
