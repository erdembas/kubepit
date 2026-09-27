import * as i18n from '@/i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import { GitCompareArrows, History, Loader2, RefreshCw, Undo2 } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Select } from '@/components/ui/Select';
import { ipc } from '@/lib/ipc';
import { spec } from '@/lib/kube/accessors';
import { changedContainers, containerKey, splitImage } from '@/lib/kube/images';
import { normalizedYaml } from '@/lib/kube/normalize';
import { cn } from '@/lib/cn';
import { formatAge } from '@/lib/format';
import type { ContainerImage, Gvk, KubeObject, RolloutRevision } from '@/types';
import { confirmDestructive, runMutation } from '../actions/guard';
import { DiffView } from '../common/DiffView';
import { useCluster } from '../data/hooks';
import { usePolled } from '../data/polled';
import { useNow } from '../util';
import { requestFor, rolloutHistoryKey, useDetailsTabRequest } from './detailsTabs';

/**
 * Rollout history of a Deployment / StatefulSet / DaemonSet: a timeline of
 * revisions (newest first) with the images each one changed, a diff of any
 * two pod templates (default: the selected revision vs the one before it)
 * and rollback. Refetches whenever the watched object changes.
 */
export function HistoryTab({
  clusterId,
  gvk,
  obj,
  readOnly,
  isActive,
}: {
  clusterId: string;
  gvk: Gvk;
  obj: KubeObject;
  readOnly: boolean;
  isActive: boolean;
}) {
  i18n.useLocale();
  const { cluster } = useCluster(clusterId);
  const now = useNow(30_000, isActive);
  const ns = obj.metadata.namespace ?? 'default';
  const name = obj.metadata.name;
  const history = usePolled(
    rolloutHistoryKey(clusterId, obj.metadata.uid),
    () => ipc.rolloutHistory(clusterId, gvk, ns, name),
    null,
    isActive,
  );
  const { refresh } = history;

  // The watch delivers every status change of the workload; refetch (debounced)
  // so replica counts and new revisions show up while a rollout runs.
  const lastVersion = useRef(obj.metadata.resourceVersion);
  useEffect(() => {
    if (lastVersion.current === obj.metadata.resourceVersion || !isActive) return;
    lastVersion.current = obj.metadata.resourceVersion;
    const timer = window.setTimeout(() => void refresh(), 500);
    return () => window.clearTimeout(timer);
  }, [obj.metadata.resourceVersion, isActive, refresh]);

  const revisions = useMemo(() => history.data ?? [], [history.data]);
  const [selected, setSelected] = useState<number | null>(null);
  const [base, setBase] = useState<number | null>(null);

  // "Roll back…" opens this tab focused on the previous revision vs the current one.
  const request = useDetailsTabRequest((s) => requestFor(s.request, clusterId, obj.metadata.uid));
  useEffect(() => {
    if (!request || !history.data) return;
    if (request.focus === 'rollback') {
      const current = history.data.find((r) => r.current);
      const previous = history.data.find(
        (r) => !r.current && (!current || r.revision < current.revision),
      );
      if (previous) {
        setSelected(previous.revision);
        setBase(current?.revision ?? null);
      }
    }
    useDetailsTabRequest.getState().clear();
  }, [request, history.data]);

  const current = revisions.find((r) => r.current) ?? null;
  const target = revisions.find((r) => r.revision === selected) ?? current ?? revisions[0] ?? null;
  const targetIndex = target ? revisions.indexOf(target) : -1;
  const autoBase =
    targetIndex < 0
      ? null
      : (revisions[targetIndex + 1] ?? (target && !target.current ? current : null));
  const baseRev =
    (base !== null ? revisions.find((r) => r.revision === base && r !== target) : undefined) ??
    autoBase;
  const paused = obj.kind === 'Deployment' && spec(obj).paused === true;
  const limit = spec(obj).revisionHistoryLimit;

  const original = useMemo(() => normalizedYaml(baseRev?.template), [baseRev]);
  const modified = useMemo(() => normalizedYaml(target?.template), [target]);

  const select = (r: RolloutRevision) => {
    setSelected(r.revision);
    setBase(null);
  };

  const rollback = (r: RolloutRevision) =>
    confirmDestructive({
      cluster,
      title: i18n.t('Roll back {kind}', { kind: obj.kind }),
      message: i18n.t(
        'Roll back {name} to revision {revision}? Pods are replaced according to the update strategy.',
        { name, revision: r.revision },
      ),
      confirmLabel: i18n.t('Roll back'),
      typeName: name,
      run: async () => {
        const ok = await runMutation(
          () => ipc.rolloutUndo(clusterId, gvk, ns, name, r.revision),
          i18n.t('Rolled back {name} to revision {revision}', { name, revision: r.revision }),
        );
        if (ok) {
          setSelected(null);
          setBase(null);
          void refresh();
        }
      },
    });

  const rollbackBlocked = readOnly
    ? i18n.t('Read-only cluster: changes are blocked')
    : paused
      ? i18n.t('Resume the rollout before rolling back')
      : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-border/60 text-fg-dim flex h-9 shrink-0 items-center gap-2 border-b px-3 text-[11px]">
        <History className="h-3 w-3" />
        {history.data && (
          <span className="tabular-nums">
            {i18n.plural('{count} revision', '{count} revisions', revisions.length)}
          </span>
        )}
        {typeof limit === 'number' && (
          <>
            <span className="text-fg-dim/40">·</span>
            <span className="tabular-nums">{i18n.t('History limit {limit}', { limit })}</span>
          </>
        )}
        {history.loading && <Loader2 className="h-3 w-3 animate-spin" />}
        <div className="ml-auto flex items-center">
          <IconButton
            size="xs"
            label={i18n.t('Refresh')}
            icon={<RefreshCw />}
            onClick={() => void refresh()}
          />
        </div>
      </div>
      {!history.data ? (
        <div className="text-fg-muted flex flex-1 items-center justify-center gap-2 p-6 text-[12px]">
          {history.error ? (
            <span className="text-status-error text-center break-words">{history.error}</span>
          ) : (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {i18n.t('Loading history…')}
            </>
          )}
        </div>
      ) : revisions.length === 0 ? (
        <EmptyState
          title={i18n.t('No revisions yet')}
          hint={i18n.t('Revisions appear once the controller has rolled out this workload.')}
        />
      ) : (
        <>
          <ol
            aria-label={i18n.t('Revisions')}
            className="overlay-scroll border-border/60 max-h-[46%] shrink-0 overflow-auto border-b py-1"
          >
            {revisions.map((r, i) => (
              <RevisionItem
                key={r.name}
                revision={r}
                previous={revisions[i + 1]}
                first={i === 0}
                last={i === revisions.length - 1}
                selected={r === target}
                isBase={r === baseRev}
                now={now}
                blocked={rollbackBlocked}
                onSelect={() => select(r)}
                onRollback={() => rollback(r)}
              />
            ))}
          </ol>
          <div className="flex min-h-[220px] flex-1 flex-col">
            {target && baseRev ? (
              <DiffView
                original={original}
                modified={modified}
                originalLabel={i18n.t('Revision {revision}', { revision: baseRev.revision })}
                modifiedLabel={i18n.t('Revision {revision}', { revision: target.revision })}
                identicalHint={i18n.t('Both revisions run the same pod template.')}
                actions={
                  <Select
                    value={String(baseRev.revision)}
                    onChange={(v) => setBase(Number(v))}
                    ariaLabel={i18n.t('Compare with')}
                    leading={<GitCompareArrows size={12} />}
                    className="mr-1 h-6 max-w-44"
                    options={revisions
                      .filter((r) => r !== target)
                      .map((r) => ({
                        value: String(r.revision),
                        label: r.current
                          ? i18n.t('Revision {revision} (current)', { revision: r.revision })
                          : i18n.t('Revision {revision}', { revision: r.revision }),
                      }))}
                  />
                }
              />
            ) : (
              <EmptyState
                title={i18n.t('Nothing to compare yet')}
                hint={i18n.t('The next rollout creates a second revision to compare with.')}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}

function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <span className="bg-fg/5 text-fg-dim flex h-9 w-9 items-center justify-center rounded-xl">
        <History className="h-4.5 w-4.5" />
      </span>
      <p className="text-fg text-[12.5px] font-medium">{title}</p>
      <p className="text-fg-dim max-w-sm text-[11.5px]">{hint}</p>
    </div>
  );
}

function RevisionItem({
  revision: r,
  previous,
  first,
  last,
  selected,
  isBase,
  now,
  blocked,
  onSelect,
  onRollback,
}: {
  revision: RolloutRevision;
  previous: RolloutRevision | undefined;
  first: boolean;
  last: boolean;
  selected: boolean;
  isBase: boolean;
  now: number;
  blocked: string | null;
  onSelect: () => void;
  onRollback: () => void;
}) {
  i18n.useLocale();
  const changed = previous ? changedContainers(previous.images, r.images) : new Set<string>();
  const created = r.created ? Date.parse(r.created) : NaN;
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelect();
          }
        }}
        className={cn(
          'group relative flex cursor-pointer gap-3 py-2 pr-3 pl-4 transition outline-none',
          'focus-visible:bg-fg/5',
          selected ? 'bg-accent/8 shadow-[inset_2px_0_0_rgb(var(--accent))]' : 'hover:bg-fg/4',
        )}
      >
        <span aria-hidden className="relative flex w-3 shrink-0 justify-center">
          <span
            className={cn(
              'bg-border absolute w-px',
              first ? 'top-3' : '-top-2',
              last ? 'h-3' : '-bottom-2',
              first && last && 'hidden',
            )}
          />
          <span
            className={cn(
              'ring-surface relative mt-[5px] h-2.5 w-2.5 rounded-full ring-[3px]',
              r.current ? 'bg-status-running' : selected ? 'bg-accent' : 'bg-fg-dim/50',
            )}
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="bg-fg/6 text-fg rounded px-1.5 py-px font-mono text-[10.5px] font-semibold tabular-nums">
              #{r.revision}
            </span>
            {r.current && <Badge tone="success">{i18n.t('current')}</Badge>}
            {isBase && (
              <Badge tone="neutral" variant="outline">
                {i18n.t('base')}
              </Badge>
            )}
            {r.replicas !== null && (r.replicas > 0 || r.current) && (
              <span className="text-fg-dim text-[10.5px] tabular-nums">
                {i18n.t('{ready}/{total} ready', {
                  ready: r.ready_replicas ?? 0,
                  total: r.replicas,
                })}
              </span>
            )}
            <span
              className="text-fg-dim ml-auto shrink-0 text-[11px] tabular-nums"
              title={
                Number.isFinite(created)
                  ? i18n.date(created, { dateStyle: 'medium', timeStyle: 'short' })
                  : undefined
              }
            >
              {r.created ? i18n.t('{age} ago', { age: formatAge(r.created, now) }) : '—'}
            </span>
          </div>
          <p
            className={cn(
              'mt-0.5 truncate text-[11.5px]',
              r.change_cause ? 'text-fg-muted' : 'text-fg-dim italic',
            )}
            title={r.change_cause ?? undefined}
          >
            {r.change_cause ?? i18n.t('No change cause recorded')}
          </p>
          <div className="mt-1 flex flex-wrap gap-1">
            {r.images.map((image) => (
              <ImageChip
                key={containerKey(image)}
                image={image}
                changed={changed.has(containerKey(image))}
              />
            ))}
          </div>
          <p className="text-fg-dim mt-1 truncate font-mono text-[10.5px]" title={r.name}>
            {r.name}
          </p>
        </div>
        {!r.current && (
          <Button
            size="xs"
            variant="ghost"
            leftIcon={<Undo2 className="h-3 w-3" />}
            disabled={blocked !== null}
            title={blocked ?? i18n.t('Roll back to revision {revision}', { revision: r.revision })}
            onClick={(e) => {
              e.stopPropagation();
              onRollback();
            }}
            className={cn(
              'self-start transition-opacity',
              selected
                ? 'opacity-100'
                : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
            )}
          >
            {i18n.t('Roll back')}
          </Button>
        )}
      </div>
    </li>
  );
}

function ImageChip({ image, changed }: { image: ContainerImage; changed: boolean }) {
  i18n.useLocale();
  const { tag, digest } = splitImage(image.image);
  const version = tag || (digest ? digest.slice(0, 19) : 'latest');
  return (
    <span
      title={changed ? i18n.t('{image} (changed)', { image: image.image }) : image.image}
      className={cn(
        'inline-flex max-w-full min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[10.5px] ring-1',
        changed
          ? 'bg-accent/10 text-accent ring-accent/30'
          : 'bg-fg/5 text-fg-muted ring-border/60',
      )}
    >
      <span className={cn('shrink-0', changed ? 'text-accent/75' : 'text-fg-dim')}>
        {image.init ? i18n.t('{name} (init)', { name: image.container }) : image.container}
      </span>
      <span className="truncate">{version}</span>
    </span>
  );
}
