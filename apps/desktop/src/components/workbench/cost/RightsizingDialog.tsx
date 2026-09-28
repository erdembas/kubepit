import * as i18n from '@/i18n';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowRight,
  Loader2,
  RefreshCw,
  ScanSearch,
  ShieldAlert,
  TriangleAlert,
} from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Choice';
import { Dialog } from '@/components/ui/Dialog';
import { IconButton } from '@/components/ui/IconButton';
import { formatMoney } from '@/lib/cost';
import { cn } from '@/lib/cn';
import { ipc } from '@/lib/ipc';
import {
  changesOf,
  confidenceLabel,
  cpuText,
  hasOptionalLimitChanges,
  isChanged,
  limitRatio,
  memoryText,
  warningText,
  workloadGvk,
} from '@/lib/kube/rightsizing/model';
import { useAppStore } from '@/store/useAppStore';
import type {
  ContainerRecommendation,
  DryRunResult,
  KubeObject,
  ResourceChange,
  WorkloadRecommendation,
} from '@/types';
import { useActionGates } from '../access/gates';
import { requiredAccess } from '../actions/access';
import { runMutation } from '../actions/guard';
import { DiffView } from '../common/DiffView';
import { reviewSides } from '../dock/editor/review';
import { GitOpsNotice } from '../gitops/ManagedNotice';
import { errorText } from '../util';
import { refreshRightsizing } from './useCost';
import { CONFIDENCE_TONE } from './tones';

const CHANGE_TONE: Record<ResourceChange, string> = {
  increase: 'text-status-starting',
  decrease: 'text-status-running',
  set: 'text-accent',
  unchanged: 'text-fg-dim',
};

/** `current → recommended` of one value, or the unchanged value. */
export function ChangeCell({
  current,
  next,
  change,
  format,
}: {
  current: number | null;
  next: number | null;
  change: ResourceChange;
  format: (v: number | null) => string;
}) {
  if (!isChanged(change))
    return <span className="text-fg-muted tabular-nums">{format(current)}</span>;
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1 tabular-nums">
      <span className="text-fg-dim decoration-fg-dim/50 line-through">{format(current)}</span>
      <ArrowRight className="text-fg-dim h-3 w-3 shrink-0" aria-hidden />
      <span className={cn('font-medium', CHANGE_TONE[change])}>{format(next)}</span>
    </span>
  );
}

/** "raised ×2" tag of a limit that follows its request. */
export function RaisedTag({ ratio }: { ratio: string | null }) {
  i18n.useLocale();
  return (
    <span
      className="bg-status-starting/10 text-status-starting rounded px-1.5 py-px text-[10px] font-medium whitespace-nowrap"
      title={i18n.t('Raised with the request, keeping the current limit-to-request ratio')}
    >
      {ratio ? i18n.t('raised {ratio}', { ratio }) : i18n.t('raised')}
    </span>
  );
}

function ValueRow({
  label,
  current,
  next,
  change,
  format,
  raised,
  ratio,
}: {
  label: string;
  current: number | null;
  next: number | null;
  change: ResourceChange;
  format: (v: number | null) => string;
  raised?: boolean;
  ratio?: string | null;
}) {
  return (
    <>
      <dt className="text-fg-dim truncate">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <ChangeCell current={current} next={next} change={change} format={format} />
        {raised && <RaisedTag ratio={ratio ?? null} />}
      </dd>
    </>
  );
}

/** Per container: every value that changes (limits raised with their requests called out) and the strategy's caveats. */
export function ContainerChanges({
  containers,
  includeLimits,
}: {
  containers: readonly ContainerRecommendation[];
  includeLimits: boolean;
}) {
  i18n.useLocale();
  return (
    <div className="border-border/60 divide-border/50 divide-y overflow-hidden rounded-lg border">
      {containers.map((c) => {
        const memoryLimitChange =
          includeLimits || c.memory_limit_raised ? c.memory_limit : 'unchanged';
        const showCpuLimit = isChanged(c.cpu_limit) || c.current.cpu_limit != null;
        return (
          <div key={c.name} className="space-y-1.5 px-3 py-2.5 text-[12px]">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="text-fg truncate font-medium" title={c.name}>
                {c.name}
              </span>
              {c.usage && (
                <Badge tone={CONFIDENCE_TONE[c.confidence]} size="xs">
                  {confidenceLabel(c.confidence)}
                </Badge>
              )}
              <span className="text-fg-dim ml-auto text-[10.5px] tabular-nums">
                {c.usage
                  ? i18n.t('p95 {cpu} · peak {memory}', {
                      cpu: cpuText(c.usage.cpu_p95),
                      memory: memoryText(c.usage.memory_max),
                    })
                  : i18n.t('No usage data')}
              </span>
            </div>
            <dl className="grid grid-cols-[minmax(92px,128px)_minmax(0,1fr)] gap-x-3 gap-y-1">
              <ValueRow
                label={i18n.t('CPU request')}
                current={c.current.cpu_request}
                next={c.recommended.cpu_request}
                change={c.cpu}
                format={cpuText}
              />
              {showCpuLimit && (
                <ValueRow
                  label={i18n.t('CPU limit')}
                  current={c.current.cpu_limit}
                  next={c.recommended.cpu_limit}
                  change={c.cpu_limit}
                  format={cpuText}
                  raised={c.cpu_limit_raised}
                  ratio={limitRatio(
                    c.current.cpu_request ?? c.current.cpu_limit,
                    c.current.cpu_limit,
                  )}
                />
              )}
              <ValueRow
                label={i18n.t('Memory request')}
                current={c.current.memory_request}
                next={c.recommended.memory_request}
                change={c.memory}
                format={memoryText}
              />
              <ValueRow
                label={i18n.t('Memory limit')}
                current={c.current.memory_limit}
                next={c.recommended.memory_limit}
                change={memoryLimitChange}
                format={memoryText}
                raised={c.memory_limit_raised}
                ratio={limitRatio(
                  c.current.memory_request ?? c.current.memory_limit,
                  c.current.memory_limit,
                )}
              />
            </dl>
            {c.warnings.length > 0 && (
              <ul className="space-y-0.5">
                {c.warnings.map((w) => (
                  <li key={w.code} className="text-fg-muted flex items-start gap-1.5 text-[11px]">
                    <TriangleAlert className="text-status-starting mt-0.5 h-3 w-3 shrink-0" />
                    <span className="min-w-0">{warningText(w)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

type Review =
  | { status: 'loading' }
  | { status: 'ready'; result: DryRunResult }
  | { status: 'error'; message: string };

/**
 * Apply a right-sizing recommendation: the changes per container, a
 * server-side dry run shown as a live → after diff, then the patch
 * (blocked on read-only clusters, typed confirmation on production).
 */
export function RightsizingDialog({
  clusterId,
  rec,
  currency,
  onClose,
}: {
  clusterId: string;
  rec: WorkloadRecommendation;
  currency: string;
  onClose: () => void;
}) {
  i18n.useLocale();
  const cluster = useAppStore((s) => s.clusters.find((c) => c.id === clusterId));
  const readOnly = !!cluster?.read_only;
  const production = cluster?.environment === 'production';
  const gvk = useMemo(() => workloadGvk(rec.kind), [rec.kind]);
  const cronJob = rec.kind === 'CronJob';
  const [includeLimits, setIncludeLimits] = useState(true);
  const changes = useMemo(() => changesOf(rec, { includeLimits }), [rec, includeLimits]);
  const optionalLimits = hasOptionalLimitChanges(rec);
  const [live, setLive] = useState<KubeObject | null>(null);
  const [review, setReview] = useState<Review>({ status: 'loading' });
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const target = useMemo(
    () => ({ kind: rec.kind, namespace: rec.namespace, name: rec.name }),
    [rec.kind, rec.namespace, rec.name],
  );

  const runReview = useCallback(() => {
    const id = ++seq.current;
    if (!changes.length) {
      setReview({ status: 'error', message: i18n.t('Nothing to change') });
      return;
    }
    setReview({ status: 'loading' });
    ipc
      .rightsizingApply(clusterId, target, changes, true)
      .then((result) => {
        if (id !== seq.current) return;
        setReview({ status: 'ready', result });
        if (result.live) setLive(result.live);
      })
      .catch((e: unknown) => {
        if (id === seq.current) setReview({ status: 'error', message: errorText(e) });
      });
  }, [clusterId, target, changes]);

  useEffect(() => {
    runReview();
  }, [runReview]);

  const gateObj = useMemo<KubeObject>(
    () =>
      live ?? {
        apiVersion: `${gvk.group}/${gvk.version}`,
        kind: rec.kind,
        metadata: { name: rec.name, namespace: rec.namespace, uid: rec.uid },
      },
    [live, rec, gvk],
  );
  const gate = useActionGates(
    clusterId,
    useMemo(
      () => [
        { id: 'rightsize', mutating: true, access: requiredAccess('rightsize', gateObj, gvk) },
      ],
      [gateObj, gvk],
    ),
    readOnly,
  ).get('rightsize');

  const sides = useMemo(
    () => (review.status === 'ready' ? reviewSides(review.result) : null),
    [review],
  );

  const apply = async () => {
    setBusy(true);
    const ok = await runMutation(
      () => ipc.rightsizingApply(clusterId, target, changes, false),
      i18n.t('Right-sized {name}', { name: rec.name }),
    );
    setBusy(false);
    if (ok) {
      refreshRightsizing(clusterId);
      onClose();
    }
  };
  const submit = () => {
    if (production) {
      useAppStore.getState().requestConfirm({
        title: i18n.t('Apply recommendation'),
        message: cronJob
          ? i18n.t(
              'Change the resources of {kind} {name} on a production cluster? Jobs created from now on use the new values; running Jobs keep theirs.',
              { kind: rec.kind, name: rec.name },
            )
          : i18n.t(
              'Change the resources of {kind} {name} on a production cluster? Its pods are replaced according to the update strategy.',
              { kind: rec.kind, name: rec.name },
            ),
        confirmLabel: i18n.t('Apply'),
        tone: 'danger',
        typeToConfirm: rec.name,
        onConfirm: apply,
      });
    } else void apply();
  };

  const blocked = gate?.blocked
    ? (gate.message ?? i18n.t('Read-only cluster: changes are blocked'))
    : !changes.length
      ? i18n.t('Nothing to change')
      : review.status === 'error'
        ? i18n.t('Fix the dry-run error first')
        : null;
  const delta = rec.monthly_delta;

  const dialog = (
    <Dialog
      title={i18n.t('Apply right-sizing')}
      subtitle={`${rec.kind} · ${rec.namespace}/${rec.name}`}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <span className="text-fg-dim mr-auto min-w-0 truncate text-[11px]" title={blocked ?? ''}>
            {blocked ??
              (delta < 0
                ? i18n.t('Saves about {amount} a month', {
                    amount: formatMoney(-delta, currency),
                  })
                : i18n.t('Adds about {amount} a month', { amount: formatMoney(delta, currency) }))}
          </span>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {i18n.t('Cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!!blocked || busy || review.status !== 'ready'}
            onClick={submit}
            title={blocked ?? undefined}
            leftIcon={busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : undefined}
          >
            {i18n.t('Apply')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <GitOpsNotice clusterId={clusterId} obj={live} />
        {readOnly && (
          <div className="border-status-starting/30 bg-status-starting/8 text-fg-muted flex items-start gap-2 rounded-lg border px-3 py-2 text-[11.5px]">
            <ShieldAlert className="text-status-starting mt-0.5 h-3.5 w-3.5 shrink-0" />
            {i18n.t(
              'This cluster is read-only: you can review the change, but it cannot be applied.',
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
          <Badge tone={CONFIDENCE_TONE[rec.confidence]}>{confidenceLabel(rec.confidence)}</Badge>
          <span className="text-fg-dim">
            {cronJob
              ? i18n.t('Applies to the Job template: Jobs created from now on use the new values.')
              : i18n.plural(
                  'Applies to {count} replica; pods are replaced by a rollout.',
                  'Applies to {count} replicas; pods are replaced by a rollout.',
                  rec.replicas,
                )}
          </span>
        </div>
        <ContainerChanges containers={rec.containers} includeLimits={includeLimits} />
        {optionalLimits && (
          <label className="text-fg-muted flex cursor-pointer items-start gap-2 text-[12px]">
            <Checkbox
              checked={includeLimits}
              onChange={(e) => setIncludeLimits(e.target.checked)}
            />
            <span>
              {i18n.t('Also adjust memory limits')}
              <span className="text-fg-dim block text-[11px]">
                {i18n.t('Limits a new request would exceed are always raised with it.')}
              </span>
            </span>
          </label>
        )}
        <div className="border-border/60 overflow-hidden rounded-lg border">
          <div className="border-border/60 bg-fg/[0.02] flex items-center gap-2 border-b px-3 py-1.5">
            <ScanSearch className="text-accent h-3.5 w-3.5 shrink-0" />
            <span className="text-fg text-[12px] font-medium">{i18n.t('Review changes')}</span>
            <span className="text-fg-dim min-w-0 truncate text-[11px]">
              {i18n.t('Server-side dry run: nothing has been changed yet')}
            </span>
            <IconButton
              className="ml-auto"
              size="xs"
              label={i18n.t('Run the dry run again')}
              icon={<RefreshCw />}
              disabled={review.status === 'loading'}
              onClick={runReview}
            />
          </div>
          <div className="flex h-[320px] min-h-0 flex-col">
            {review.status === 'loading' ? (
              <div className="text-fg-muted flex flex-1 items-center justify-center gap-2 text-[12px]">
                <Loader2 className="h-4 w-4 animate-spin" />
                {i18n.t('Running the dry run…')}
              </div>
            ) : review.status === 'error' ? (
              <p className="text-status-error p-3 text-[12px] break-words">{review.message}</p>
            ) : sides ? (
              <DiffView
                className="min-h-0 flex-1"
                original={sides.original}
                modified={sides.modified}
                originalLabel={i18n.t('Live')}
                modifiedLabel={i18n.t('After apply')}
              />
            ) : null}
          </div>
        </div>
      </div>
    </Dialog>
  );
  return createPortal(dialog, document.body);
}
