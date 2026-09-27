import * as i18n from '@/i18n';
import { useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  CircleCheck,
  CirclePause,
  CirclePlay,
  Hand,
  History,
  Loader2,
  Undo2,
} from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ipc } from '@/lib/ipc';
import { asString, conditions, spec, status, type Condition } from '@/lib/kube/accessors';
import type { StatusTone } from '@/lib/kube/pods';
import { rolloutProgress, type RolloutProgress, type RolloutState } from '@/lib/kube/rollout';
import { toneDot } from '@/lib/kube/workloads';
import { cn } from '@/lib/cn';
import { formatAge } from '@/lib/format';
import { useAppStore } from '@/store/useAppStore';
import { confirmDestructive, runMutation } from '../../actions/guard';
import { useCluster } from '../../data/hooks';
import { refreshPolled } from '../../data/polled';
import { errorText } from '../../util';
import { rolloutHistoryKey, useDetailsTabRequest } from '../detailsTabs';
import { MonoText, Row, Rows, Section } from '../primitives';
import type { SectionProps } from './types';

/**
 * Live rollout status at the top of Deployment / StatefulSet / DaemonSet
 * details: progress bar, kubectl-style status line, strategy, conditions,
 * generation lag, plus Pause/Resume and Undo.
 */
export function RolloutSection({ obj, gvk, ctx, readOnly }: SectionProps) {
  i18n.useLocale();
  const { cluster } = useCluster(ctx.clusterId);
  const [busy, setBusy] = useState<'pause' | 'undo' | null>(null);
  const p = rolloutProgress(obj);
  const ns = obj.metadata.namespace ?? 'default';
  const name = obj.metadata.name;
  const isDeployment = obj.kind === 'Deployment';
  const paused = isDeployment && spec(obj).paused === true;
  const lock = readOnly ? i18n.t('Read-only cluster: changes are blocked') : undefined;
  const revision = isDeployment
    ? obj.metadata.annotations?.['deployment.kubernetes.io/revision']
    : asString(status(obj).updateRevision) || undefined;

  const togglePause = async () => {
    setBusy('pause');
    await runMutation(
      () => ipc.resourcePatch(ctx.clusterId, gvk, ns, name, { spec: { paused: !paused } }, 'merge'),
      paused
        ? i18n.t('Resumed rollout of {name}', { name })
        : i18n.t('Paused rollout of {name}', { name }),
    );
    setBusy(null);
  };

  const undo = async () => {
    setBusy('undo');
    try {
      const history = await ipc.rolloutHistory(ctx.clusterId, gvk, ns, name);
      const current = history.find((r) => r.current);
      const previous = history.find(
        (r) => !r.current && (!current || r.revision < current.revision),
      );
      if (!previous) {
        useAppStore
          .getState()
          .pushToast('info', i18n.t('{name} has no previous revision to roll back to', { name }));
        return;
      }
      confirmDestructive({
        cluster,
        title: i18n.t('Roll back {kind}', { kind: obj.kind }),
        message: i18n.t(
          'Roll back {name} to revision {revision}? Pods are replaced according to the update strategy.',
          { name, revision: previous.revision },
        ),
        confirmLabel: i18n.t('Roll back'),
        typeName: name,
        run: async () => {
          if (
            await runMutation(
              () => ipc.rolloutUndo(ctx.clusterId, gvk, ns, name, previous.revision),
              i18n.t('Rolled back {name} to revision {revision}', {
                name,
                revision: previous.revision,
              }),
            )
          )
            refreshPolled(rolloutHistoryKey(ctx.clusterId, obj.metadata.uid));
        },
      });
    } catch (e) {
      useAppStore.getState().pushToast('error', errorText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section
      title={i18n.t('Rollout')}
      actions={
        <>
          <Button
            size="xs"
            variant="ghost"
            leftIcon={<History className="h-3 w-3" />}
            onClick={() =>
              useDetailsTabRequest
                .getState()
                .open({ clusterId: ctx.clusterId, uid: obj.metadata.uid, tab: 'history' })
            }
          >
            {i18n.t('History')}
          </Button>
          {isDeployment && (
            <Button
              size="xs"
              variant="ghost"
              leftIcon={
                busy === 'pause' ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : paused ? (
                  <CirclePlay className="h-3 w-3" />
                ) : (
                  <CirclePause className="h-3 w-3" />
                )
              }
              disabled={readOnly || busy !== null}
              title={lock}
              onClick={() => void togglePause()}
            >
              {paused ? i18n.t('Resume') : i18n.t('Pause')}
            </Button>
          )}
          <Button
            size="xs"
            variant="ghost"
            leftIcon={
              busy === 'undo' ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Undo2 className="h-3 w-3" />
              )
            }
            disabled={readOnly || paused || busy !== null}
            title={
              lock ??
              (paused
                ? i18n.t('Resume the rollout before rolling back')
                : i18n.t('Roll back to the previous revision'))
            }
            onClick={() => void undo()}
          >
            {i18n.t('Undo')}
          </Button>
        </>
      }
    >
      <StatusLine progress={p} revision={revision} />
      <ProgressBar progress={p} />
      <Legend progress={p} />
      <div className="mt-3">
        <Rows>
          <Row label={i18n.t('Strategy')}>
            <span>
              {p.strategy.type}
              {(p.strategy.maxSurge !== null ||
                p.strategy.maxUnavailable !== null ||
                p.strategy.partition !== null) && (
                <span className="text-fg-dim ml-1.5 font-mono text-[11px]">
                  {[
                    p.strategy.maxSurge !== null && `maxSurge ${p.strategy.maxSurge}`,
                    p.strategy.maxUnavailable !== null &&
                      `maxUnavailable ${p.strategy.maxUnavailable}`,
                    p.strategy.partition !== null && `partition ${p.strategy.partition}`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              )}
            </span>
          </Row>
          {p.generation > 0 && (
            <Row label={i18n.t('Generation')}>
              <span className={cn('tabular-nums', p.observing && 'text-status-starting')}>
                {p.observing
                  ? i18n.t('{generation} (observed {observed})', {
                      generation: p.generation,
                      observed: p.observedGeneration,
                    })
                  : p.generation}
              </span>
            </Row>
          )}
          {isDeployment && spec(obj).minReadySeconds !== undefined && (
            <Row label={i18n.t('Min ready')}>
              <MonoText>{`${asString(spec(obj).minReadySeconds)}s`}</MonoText>
            </Row>
          )}
          {isDeployment && spec(obj).progressDeadlineSeconds !== undefined && (
            <Row label={i18n.t('Progress deadline')}>
              <MonoText>{`${asString(spec(obj).progressDeadlineSeconds)}s`}</MonoText>
            </Row>
          )}
        </Rows>
      </div>
      <ConditionList items={conditions(obj)} now={ctx.now} />
    </Section>
  );
}

const STATE_TONE: Record<RolloutState, string> = {
  complete: 'text-status-running',
  progressing: 'text-accent',
  paused: 'text-status-starting',
  degraded: 'text-status-starting',
  failed: 'text-status-error',
  manual: 'text-fg-muted',
};

function StateIcon({ state }: { state: RolloutState }) {
  const cls = 'h-3.5 w-3.5 shrink-0';
  if (state === 'complete') return <CircleCheck className={cls} />;
  if (state === 'progressing') return <Loader2 className={cn(cls, 'animate-spin')} />;
  if (state === 'paused') return <CirclePause className={cls} />;
  if (state === 'failed' || state === 'degraded') return <AlertTriangle className={cls} />;
  return <Hand className={cls} />;
}

function StatusLine({ progress: p, revision }: { progress: RolloutProgress; revision?: string }) {
  i18n.useLocale();
  const label: Record<RolloutState, string> = {
    complete: i18n.t('Rolled out'),
    progressing: i18n.t('Rolling out…'),
    paused: i18n.t('Paused'),
    degraded: i18n.t('Degraded'),
    failed: i18n.t('Failed'),
    manual: i18n.t('Waiting for pod deletion'),
  };
  return (
    <div className="mb-2.5 flex min-w-0 items-start gap-2">
      <span className={cn('mt-px flex items-center gap-1.5', STATE_TONE[p.state])}>
        <StateIcon state={p.state} />
        <span className="text-[12.5px] font-semibold whitespace-nowrap">{label[p.state]}</span>
      </span>
      <span className="text-fg-muted min-w-0 flex-1 text-[12px] leading-snug">{p.message}</span>
      {revision && (
        <span
          className="bg-fg/6 text-fg-muted max-w-[45%] shrink-0 truncate rounded px-1.5 py-px font-mono text-[10.5px]"
          title={revision}
        >
          {/^\d+$/.test(revision) ? `#${revision}` : revision}
        </span>
      )}
    </div>
  );
}

/** Segments: updated & available, updated but not yet available, old revision; the rest empty. */
function ProgressBar({ progress: p }: { progress: RolloutProgress }) {
  i18n.useLocale();
  const total = Math.max(p.desired, p.total, 1);
  const fresh = p.upToDate;
  const pending = Math.max(0, p.updated - fresh);
  const pct = (n: number) => `${(Math.min(n, total) / total) * 100}%`;
  const segments: Array<[number, string]> = [
    [fresh, 'bg-status-running'],
    [pending, 'bg-status-running/35'],
    [p.old, 'bg-fg-dim/45'],
  ];
  return (
    <div
      role="img"
      aria-label={i18n.t('{updated} of {desired} updated, {available} available', {
        updated: p.updated,
        desired: p.desired,
        available: p.available,
      })}
      className="bg-fg/8 relative flex h-2 w-full gap-px overflow-hidden rounded-full"
    >
      {segments
        .filter(([n]) => n > 0)
        .map(([n, tone]) => (
          <span
            key={tone}
            className={cn('h-full shrink-0 transition-[width] duration-500 ease-out', tone)}
            style={{ width: pct(n) }}
          />
        ))}
      {total > p.desired && p.desired > 0 && (
        <span
          aria-hidden
          className="bg-fg/60 absolute inset-y-0 w-px"
          style={{ left: pct(p.desired) }}
        />
      )}
    </div>
  );
}

function Legend({ progress: p }: { progress: RolloutProgress }) {
  i18n.useLocale();
  const fresh = p.upToDate;
  const pending = Math.max(0, p.updated - fresh);
  const item = (tone: string, label: ReactNode) => (
    <span className="flex items-center gap-1.5">
      <span className={cn('h-2 w-2 rounded-[2px]', tone)} aria-hidden />
      {label}
    </span>
  );
  return (
    <div className="text-fg-muted mt-2 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[11px] tabular-nums">
      {item('bg-status-running', i18n.t('{count} up to date', { count: fresh }))}
      {pending > 0 && item('bg-status-running/35', i18n.t('{count} starting', { count: pending }))}
      {p.old > 0 && item('bg-fg-dim/45', i18n.t('{count} old', { count: p.old }))}
      <span className="text-fg-dim ml-auto">
        {i18n.t('{ready} ready · {desired} desired', { ready: p.ready, desired: p.desired })}
      </span>
    </div>
  );
}

function conditionTone(c: Condition): StatusTone {
  if (c.type === 'ReplicaFailure') return c.status === 'True' ? 'error' : 'muted';
  if (c.reason === 'ProgressDeadlineExceeded') return 'error';
  if (c.status === 'True')
    return c.type === 'Progressing' && c.reason !== 'NewReplicaSetAvailable' ? 'info' : 'success';
  if (c.status === 'False') return 'error';
  return 'warning';
}

function ConditionList({ items, now }: { items: Condition[]; now: number }) {
  i18n.useLocale();
  if (!items.length) return null;
  return (
    <div className="mt-3.5">
      <p className="text-fg-dim mb-1.5 text-[10.5px] font-semibold tracking-[0.08em] uppercase">
        {i18n.t('Conditions')}
      </p>
      <ul className="space-y-1.5">
        {items.map((c) => (
          <li key={c.type} className="flex min-w-0 gap-2 text-[12px]">
            <span
              className={cn('mt-[5px] h-2 w-2 shrink-0 rounded-full', toneDot(conditionTone(c)))}
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="text-fg font-medium">{c.type}</span>
                <Badge tone={c.status === 'True' ? 'neutral' : 'warning'} variant="outline">
                  {c.status}
                </Badge>
                {c.reason && (
                  <span className="text-fg-dim truncate font-mono text-[10.5px]">{c.reason}</span>
                )}
                {c.lastTransitionTime && (
                  <span className="text-fg-dim ml-auto shrink-0 text-[11px] tabular-nums">
                    {formatAge(c.lastTransitionTime, now)}
                  </span>
                )}
              </div>
              {c.message && (
                <p className="text-fg-dim mt-0.5 text-[11px] leading-snug break-words">
                  {c.message}
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
