import * as i18n from '@/i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Ban,
  CheckCircle2,
  Circle,
  CircleCheck,
  Loader2,
  ShieldAlert,
  TriangleAlert,
  XCircle,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { cn } from '@/lib/cn';
import { formatMoney } from '@/lib/cost';
import { useAppStore } from '@/store/useAppStore';
import type { ClusterId, WorkloadRecommendation } from '@/types';
import { useActionGates, type ActionGate } from '../access/gates';
import {
  batchCounts,
  batchInitialState,
  createBatchSession,
  type BatchRow,
  type BatchRowState,
  type BatchSession,
  type BatchState,
} from './batchApply';
import { NAMED_GATE_LIMIT, rightsizeAction, rightsizeActionId } from './quickApply';

function StateIcon({ state }: { state: BatchRowState }) {
  const cls = 'mt-0.5 h-3.5 w-3.5 shrink-0';
  switch (state) {
    case 'checking':
    case 'applying':
      return <Loader2 className={cn(cls, 'text-accent animate-spin')} />;
    case 'ready':
      return <CircleCheck className={cn(cls, 'text-status-running')} />;
    case 'applied':
      return <CheckCircle2 className={cn(cls, 'text-status-running')} />;
    case 'rejected':
    case 'skipped':
      return <Ban className={cn(cls, 'text-fg-dim')} />;
    case 'failed':
      return <XCircle className={cn(cls, 'text-status-error')} />;
    default:
      return <Circle className={cn(cls, 'text-fg-dim')} />;
  }
}

function stateText(row: BatchRow): string {
  switch (row.state) {
    case 'waiting':
      return i18n.t('Waiting for its dry run');
    case 'checking':
      return i18n.t('Running the dry run…');
    case 'ready':
      return i18n.t('Dry run passed');
    case 'applying':
      return i18n.t('Applying…');
    case 'applied':
      return i18n.t('Applied, updated at the next scan');
    default:
      return row.message ?? i18n.t('Not applied');
  }
}

function RowItem({ row, currency }: { row: BatchRow; currency: string }) {
  const { rec } = row;
  return (
    <li className="rounded-app-sm hover:bg-fg/4 flex min-w-0 items-start gap-2 px-2 py-1.5 text-[12px]">
      <StateIcon state={row.state} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span lang="en" className="text-fg-dim shrink-0 text-[10.5px]">
            {rec.kind}
          </span>
          <span
            className="text-fg min-w-0 truncate font-medium"
            title={`${rec.namespace}/${rec.name}`}
          >
            {rec.name}
          </span>
          <span
            className={cn(
              'ml-auto shrink-0 text-[11px] tabular-nums',
              rec.monthly_delta < 0 ? 'text-status-running' : 'text-status-starting',
            )}
          >
            {i18n.t('{amount} / month', {
              amount: formatMoney(rec.monthly_delta, currency, { signed: true }),
            })}
          </span>
        </div>
        <p className="mt-0.5 flex min-w-0 flex-wrap gap-x-1.5 text-[11px]">
          <span className="text-fg-dim max-w-full truncate">{rec.namespace}</span>
          <span
            className={cn(
              'min-w-0 break-words',
              row.state === 'failed'
                ? 'text-status-error'
                : row.state === 'applied' || row.state === 'ready'
                  ? 'text-status-running'
                  : 'text-fg-dim',
            )}
          >
            {stateText(row)}
          </span>
        </p>
      </div>
    </li>
  );
}

/** Footer status: the progress, then the outcome. */
function statusText(state: BatchState, connected: boolean): string {
  const c = batchCounts(state.rows);
  const total = state.rows.length;
  switch (state.phase) {
    case 'refused':
      return state.refusal ?? '';
    case 'checking':
      return i18n.t('Dry run {done} of {total}…', {
        done: i18n.number(total - c.waiting - c.checking),
        total: i18n.number(total),
      });
    case 'ready':
      if (!c.ready) return i18n.t('No workload passed its dry run.');
      if (!connected) return i18n.t('Connect to the cluster to apply.');
      return i18n.plural(
        '{count} workload passed its dry run',
        '{count} workloads passed their dry run',
        c.ready,
      );
    case 'applying':
      return i18n.t('Applying {done} of {total}…', {
        done: i18n.number(c.applied + c.failed + c.skipped + c.applying),
        total: i18n.number(c.applied + c.failed + c.skipped + c.applying + c.ready),
      });
    case 'done':
      return i18n.t('{applied} applied · {failed} failed · {skipped} not applied', {
        applied: i18n.number(c.applied),
        failed: i18n.number(c.failed),
        skipped: i18n.number(c.skipped + c.rejected + c.ready),
      });
  }
}

/**
 * "Apply {n} high-confidence" (spec §8): each checked one-click row is
 * dry-run in turn with its outcome, then "Apply {n}" patches only the rows
 * whose dry run passed in this dialog, one at a time, through the audited
 * `rightsizing_apply`. Read-only and production clusters are refused
 * (production applies one workload at a time, with the typed
 * confirmation); RBAC denials are listed with their reason. It stops
 * before the next row when the cluster disconnects, on "Stop", or when
 * closed.
 */
export function BatchApplyDialog({
  clusterId,
  recs,
  currency = 'USD',
  onClose,
}: {
  clusterId: ClusterId;
  /** The rows to apply (`batchTargets`); fixed when the dialog opens. */
  recs: readonly WorkloadRecommendation[];
  currency?: string;
  onClose: () => void;
}) {
  i18n.useLocale();
  const [rows] = useState(recs);
  const readOnly = useAppStore((s) => !!s.clusters.find((c) => c.id === clusterId)?.read_only);
  const connected = useAppStore((s) => s.statuses[clusterId]?.state === 'connected');

  const named = rows.length <= NAMED_GATE_LIMIT;
  const actions = useMemo(() => {
    const byId = new Map(rows.map((rec) => [rightsizeActionId(rec, named), rec]));
    return [...byId.values()].map((rec) => rightsizeAction(rec, { named }));
  }, [rows, named]);
  const gates = useActionGates(clusterId, actions, readOnly);
  const gatesRef = useRef<ReadonlyMap<string, ActionGate>>(gates);
  gatesRef.current = gates;

  const [state, setState] = useState<BatchState>(() => batchInitialState(clusterId, rows));
  const session = useRef<BatchSession | null>(null);
  useEffect(() => {
    const s = createBatchSession(clusterId, rows, {
      blocked: (rec) => {
        const gate = gatesRef.current.get(rightsizeActionId(rec, named));
        return gate?.reason === 'permission' ? gate.message : null;
      },
    });
    session.current = s;
    setState(s.getState());
    const off = s.subscribe(setState);
    void s.check();
    return () => {
      off();
      s.dispose();
      if (session.current === s) session.current = null;
    };
  }, [clusterId, rows, named]);

  const counts = batchCounts(state.rows);
  const total = state.rows.length;
  const applying = state.phase === 'applying';
  const progress =
    state.phase === 'checking'
      ? (total - counts.waiting - counts.checking) / Math.max(1, total)
      : applying
        ? (counts.applied + counts.failed + counts.skipped) /
          Math.max(
            1,
            counts.applied + counts.failed + counts.skipped + counts.applying + counts.ready,
          )
        : null;
  const canApply = state.phase === 'ready' && counts.ready > 0 && connected;
  const status = statusText(state, connected);
  const close = () => {
    // The workload being patched finishes; nothing after it is applied.
    session.current?.stop();
    onClose();
  };

  const dialog = (
    <Dialog
      title={i18n.t('Apply high-confidence recommendations')}
      subtitle={i18n.plural('{count} workload', '{count} workloads', total)}
      size="md"
      onClose={close}
      footer={
        <>
          <span
            className="text-fg-dim mr-auto min-w-0 truncate text-[11px] tabular-nums"
            role="status"
            title={status}
          >
            {status}
          </span>
          {applying ? (
            <Button variant="secondary" size="sm" onClick={() => session.current?.stop()}>
              {i18n.t('Stop')}
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={close}>
              {state.phase === 'done' || state.phase === 'refused'
                ? i18n.t('Close')
                : i18n.t('Cancel')}
            </Button>
          )}
          {state.phase !== 'done' && state.phase !== 'refused' && (
            <Button
              variant="primary"
              size="sm"
              disabled={!canApply}
              onClick={() => void session.current?.apply()}
              leftIcon={
                applying ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Zap className="h-3.5 w-3.5" />
                )
              }
            >
              {i18n.t('Apply {count}', { count: i18n.number(counts.ready + counts.applying) })}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3">
        {state.refusal ? (
          <div className="border-status-starting/30 bg-status-starting/8 text-fg-muted flex items-start gap-2 rounded-lg border px-3 py-2 text-[11.5px]">
            <ShieldAlert className="text-status-starting mt-0.5 h-3.5 w-3.5 shrink-0" />
            {state.refusal}
          </div>
        ) : (
          <p className="text-fg-muted text-[12px]">
            {i18n.t(
              'Each workload is dry-run on the server first. Only the ones whose dry run passes are applied, one at a time; their pods are replaced by a rollout.',
            )}
          </p>
        )}
        {state.stopped && (
          <div className="border-status-starting/30 bg-status-starting/8 text-fg-muted flex items-start gap-2 rounded-lg border px-3 py-2 text-[11.5px]">
            <TriangleAlert className="text-status-starting mt-0.5 h-3.5 w-3.5 shrink-0" />
            {state.stopped}
          </div>
        )}
        {progress != null && (
          <div
            className="bg-fg/8 h-1 overflow-hidden rounded-full"
            role="progressbar"
            aria-label={applying ? i18n.t('Applying') : i18n.t('Dry runs')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
          >
            <div
              className="bg-accent h-full rounded-full transition-[width] duration-300"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
        )}
        <ul
          aria-label={i18n.t('Workloads')}
          className="border-border/60 max-h-[360px] overflow-y-auto rounded-lg border p-1"
        >
          {state.rows.map((row) => (
            <RowItem key={row.key} row={row} currency={currency} />
          ))}
        </ul>
      </div>
    </Dialog>
  );
  return createPortal(dialog, document.body);
}
