import * as i18n from '@/i18n';
import { useEffect, useState } from 'react';
import { Loader2, ShieldAlert, Undo2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { DiffView } from '@/components/workbench/common/DiffView';
import { refreshPolledPrefix } from '@/components/workbench/data/polled';
import { reviewSides } from '@/components/workbench/dock/editor/review';
import { errorText } from '@/components/workbench/util';
import { targetName } from '@/lib/history/audit';
import { planRevert } from '@/lib/history/revert';
import { ipc } from '@/lib/ipc';
import { useAppStore } from '@/store/useAppStore';
import type { AuditEntry, AuditObject, DryRunResult } from '@/types';

type State =
  | { status: 'loading' }
  | { status: 'ready'; yaml: string; result: DryRunResult }
  | { status: 'unchanged' }
  | { status: 'error'; message: string };

/**
 * Revert one target of an audited action: the live object with exactly
 * the action's changes undone, reviewed with a server-side dry run of the
 * `replace` before anything is written (the live resourceVersion guards
 * against concurrent edits). Read-only clusters can review but not apply.
 */
export function RevertDialog({
  entry,
  object,
  onClose,
}: {
  entry: AuditEntry;
  object: AuditObject;
  onClose: () => void;
}) {
  i18n.useLocale();
  const target = entry.targets[object.target];
  const cluster = useAppStore((s) => s.clusters.find((c) => c.id === entry.cluster_id) ?? null);
  const readOnly = cluster?.read_only ?? false;
  const production = cluster?.environment === 'production';
  const [state, setState] = useState<State>({ status: 'loading' });
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!target?.gvk || !object.before_yaml || !object.after_yaml) {
        setState({ status: 'error', message: i18n.t('This action cannot be reverted.') });
        return;
      }
      try {
        const live = await ipc.resourceGet(
          entry.cluster_id,
          target.gvk,
          target.namespace,
          target.name,
        );
        const plan = planRevert(live, object.before_yaml, object.after_yaml);
        if (cancelled) return;
        if (!plan.ok) {
          setState(
            plan.reason === 'unchanged'
              ? { status: 'unchanged' }
              : {
                  status: 'error',
                  message:
                    plan.reason === 'redacted'
                      ? i18n.t('Redacted values cannot be restored.')
                      : i18n.t('This action cannot be reverted.'),
                },
          );
          return;
        }
        const [result] = await ipc.resourceDryRunYaml(
          entry.cluster_id,
          plan.yaml,
          'replace',
          target.namespace,
        );
        if (cancelled) return;
        if (!result) throw new Error(i18n.t('The dry run returned no result.'));
        setState(
          !result.error && result.operation === 'unchanged'
            ? { status: 'unchanged' }
            : { status: 'ready', yaml: plan.yaml, result },
        );
      } catch (e) {
        if (!cancelled) setState({ status: 'error', message: errorText(e) });
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [entry.cluster_id, object, target]);

  const apply = async () => {
    if (state.status !== 'ready' || !target) return;
    setApplying(true);
    try {
      await ipc.resourceApplyYaml(entry.cluster_id, state.yaml, 'replace', target.namespace);
      useAppStore
        .getState()
        .pushToast(
          'success',
          i18n.t('Reverted {kind} {name}', { kind: target.kind, name: targetName(target) }),
        );
      refreshPolledPrefix('activity|');
      onClose();
    } catch (e) {
      setState({ status: 'error', message: errorText(e) });
    } finally {
      setApplying(false);
    }
  };

  const rejected = state.status === 'ready' ? state.result.error : null;
  const blocked = readOnly
    ? i18n.t('This cluster is read-only. Changes cannot be saved or applied.')
    : rejected
      ? i18n.t('The server rejected the revert.')
      : null;
  const sides = state.status === 'ready' && !rejected ? reviewSides(state.result) : null;

  return (
    <Dialog
      size="xl"
      title={i18n.t('Revert {kind} {name}', {
        kind: target?.kind ?? '',
        name: target ? targetName(target) : '',
      })}
      subtitle={`${entry.cluster_name} · ${entry.context}`}
      onClose={onClose}
      bodyClassName="flex min-h-0 flex-1 flex-col"
      footer={
        <>
          {blocked && <span className="text-fg-dim mr-auto text-[11.5px]">{blocked}</span>}
          {!blocked && production && state.status === 'ready' && (
            <span className="text-status-starting mr-auto flex items-center gap-1.5 text-[11.5px]">
              <ShieldAlert className="h-3.5 w-3.5" />
              {i18n.t('This is a production cluster.')}
            </span>
          )}
          <Button size="sm" variant="ghost" onClick={onClose}>
            {i18n.t('Cancel')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            leftIcon={
              applying ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Undo2 className="h-3.5 w-3.5" />
              )
            }
            disabled={state.status !== 'ready' || !!blocked || applying}
            onClick={() => void apply()}
          >
            {i18n.t('Revert')}
          </Button>
        </>
      }
    >
      <p className="border-border/60 text-fg-muted shrink-0 border-b px-4 py-2 text-[11.5px] leading-relaxed">
        {i18n.t(
          'Only the fields this action changed are set back on the live object; later changes by others stay. Server-side dry run: nothing has been changed yet.',
        )}
      </p>
      <div className="flex h-[440px] min-h-0 flex-col">
        {state.status === 'loading' ? (
          <div className="text-fg-dim flex flex-1 items-center justify-center gap-2 text-[12px]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {i18n.t('Running a server-side dry run…')}
          </div>
        ) : state.status === 'unchanged' ? (
          <div className="text-fg-dim flex flex-1 items-center justify-center p-6 text-center text-[12px]">
            {i18n.t('The live object already matches the state before this action.')}
          </div>
        ) : state.status === 'error' || rejected ? (
          <div className="p-4">
            <div className="border-tone-critical/30 bg-tone-critical/5 text-tone-critical-fg rounded-app-sm border px-3 py-2">
              <p className="mb-1 flex items-center gap-1.5 text-[12px] font-medium">
                <XCircle className="h-3.5 w-3.5 shrink-0" />
                {i18n.t('Nothing was changed.')}
              </p>
              <p className="font-mono text-[11.5px] break-words whitespace-pre-wrap">
                {state.status === 'error' ? state.message : rejected}
              </p>
            </div>
          </div>
        ) : (
          sides && (
            <DiffView
              original={sides.original}
              modified={sides.modified}
              originalLabel={i18n.t('Live')}
              modifiedLabel={i18n.t('After revert')}
            />
          )
        )}
      </div>
    </Dialog>
  );
}
