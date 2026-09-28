import * as i18n from '@/i18n';
import { useEffect } from 'react';
import { CheckCircle2, Copy, Loader2, RotateCcw, Scissors, X, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Dialog } from '@/components/ui/Dialog';
import { cn } from '@/lib/cn';
import { events } from '@/lib/ipc';
import { useCustomActionsStore } from '@/store/useCustomActionsStore';
import { copyText } from '../../util';
import { customActionIcon } from './icons';
import { rerun } from './runCustomAction';
import { useCustomActionRuns, type CustomActionRun } from './runStore';

/**
 * Custom actions glue mounted once in the app overlays: loads the saved
 * actions and follows `customactions://changed`, and renders the
 * confirmation (with the resolved command), the background runs panel and
 * a run's output.
 */
export function CustomActionHost() {
  i18n.useLocale();
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void useCustomActionsStore
      .getState()
      .load()
      .catch(() => undefined);
    void events
      .onCustomActionsChanged((actions) => useCustomActionsStore.getState().setActions(actions))
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return (
    <>
      <ConfirmRun />
      <RunsPanel />
      <RunOutput />
    </>
  );
}

function ConfirmRun() {
  i18n.useLocale();
  const confirm = useCustomActionRuns((s) => s.confirm);
  const close = () => useCustomActionRuns.getState().setConfirm(null);
  if (!confirm || (!confirm.resolved && !confirm.error)) return null;
  const { action, resolved, error } = confirm;
  const lines: string[] = [];
  if (action.description) lines.push(action.description);
  lines.push(
    action.mode === 'open-url'
      ? i18n.t('Open this URL for {target}?', { target: confirm.label })
      : i18n.t('Run this command for {target}?', { target: confirm.label }),
  );
  if (resolved?.missing.length)
    lines.push(
      i18n.t('No value for {placeholders}; they are left empty.', {
        placeholders: resolved.missing.join(', '),
      }),
    );
  if (action.mutating) lines.push(i18n.t('This action changes the cluster.'));
  if (confirm.typeToConfirm) lines.push(i18n.t('This is a production cluster.'));
  if (error) lines.push(error);
  return (
    <ConfirmDialog
      title={i18n.t('Run “{name}”', { name: action.name })}
      message={lines.join('\n\n')}
      details={resolved?.command}
      tone={action.mutating ? 'danger' : error ? 'warning' : 'info'}
      confirmLabel={action.mode === 'open-url' ? i18n.t('Open') : i18n.t('Run')}
      confirmWord={error ? undefined : (confirm.typeToConfirm ?? undefined)}
      onCancel={close}
      onConfirm={() => {
        if (error) return close();
        close();
        confirm.run();
      }}
    />
  );
}

function duration(ms: number) {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function RunStatusIcon({ run }: { run: CustomActionRun }) {
  if (run.status === 'running')
    return <Loader2 className="text-accent h-3.5 w-3.5 shrink-0 animate-spin" />;
  if (run.status === 'done')
    return <CheckCircle2 className="text-status-running h-3.5 w-3.5 shrink-0" />;
  return <XCircle className="text-status-error h-3.5 w-3.5 shrink-0" />;
}

/** Background runs, bottom left so toasts (bottom right) never cover them. */
function RunsPanel() {
  i18n.useLocale();
  const runs = useCustomActionRuns((s) => s.runs);
  if (!runs.length) return null;
  return (
    <div
      role="region"
      aria-label={i18n.t('Custom action runs')}
      className="pointer-events-none fixed bottom-12 left-4 z-[60] flex w-[320px] max-w-[calc(100vw-2rem)] flex-col gap-1.5"
    >
      {runs.map((run) => {
        const Icon = customActionIcon(run.action.icon);
        return (
          <div
            key={run.id}
            className="border-border bg-surface-overlay animate-fade-in pointer-events-auto flex items-center gap-2 rounded-lg border px-2.5 py-2 shadow-[0_12px_40px_rgba(0,0,0,0.35)]"
          >
            <RunStatusIcon run={run} />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-1.5">
                <Icon className="text-fg-dim h-3 w-3 shrink-0" />
                <span className="text-fg truncate text-[12px] font-medium">{run.action.name}</span>
              </div>
              <p className="text-fg-dim truncate font-mono text-[10.5px]">
                {run.label}
                {run.result ? ` · ${duration(run.result.duration_ms)}` : ''}
              </p>
            </div>
            {run.status !== 'running' && (
              <button
                type="button"
                onClick={() => useCustomActionRuns.getState().openOutput(run.id)}
                className="text-accent hover:bg-accent/10 shrink-0 rounded-md px-2 py-0.5 text-[11.5px] font-medium"
              >
                {i18n.t('Output')}
              </button>
            )}
            <button
              type="button"
              onClick={() => useCustomActionRuns.getState().dismissRun(run.id)}
              aria-label={i18n.t('Dismiss')}
              className="text-fg-dim hover:text-fg shrink-0 rounded p-0.5"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function OutputBlock({ label, text, tone }: { label: string; text: string; tone?: 'error' }) {
  i18n.useLocale();
  return (
    <section>
      <div className="mb-1 flex items-center justify-between">
        <h4 className="text-fg-dim text-[10.5px] font-semibold tracking-[0.08em] uppercase">
          {label}
        </h4>
        <button
          type="button"
          onClick={() => void copyText(text, label)}
          className="text-fg-dim hover:text-fg inline-flex items-center gap-1 rounded px-1 text-[11px]"
        >
          <Copy className="h-3 w-3" />
          {i18n.t('Copy')}
        </button>
      </div>
      <pre
        className={cn(
          'border-border bg-surface-muted/40 max-h-[40vh] overflow-auto rounded-md border p-2.5 font-mono text-[11.5px] leading-[1.55] whitespace-pre',
          tone === 'error' ? 'text-status-error' : 'text-fg',
        )}
      >
        {text}
      </pre>
    </section>
  );
}

function RunOutput() {
  i18n.useLocale();
  const run = useCustomActionRuns((s) => s.runs.find((r) => r.id === s.openRunId) ?? null);
  const close = () => useCustomActionRuns.getState().openOutput(null);
  if (!run) return null;
  const result = run.result;
  const status = !result
    ? (run.error ?? i18n.t('Running…'))
    : result.timed_out
      ? i18n.t('Timed out after {duration}', { duration: duration(result.duration_ms) })
      : i18n.t('Exit code {code} · {duration}', {
          code: result.exit_code ?? '?',
          duration: duration(result.duration_ms),
        });
  return (
    <Dialog
      title={run.action.name}
      subtitle={run.label}
      size="lg"
      onClose={close}
      footer={
        <>
          <Button
            variant="ghost"
            size="sm"
            leftIcon={<RotateCcw className="h-3.5 w-3.5" />}
            onClick={() => {
              close();
              rerun(run.id);
            }}
          >
            {i18n.t('Run again')}
          </Button>
          <Button variant="primary" size="sm" onClick={close}>
            {i18n.t('Close')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <RunStatusIcon run={run} />
          <span
            className={cn(
              'text-[12px]',
              run.status === 'failed' ? 'text-status-error' : 'text-fg-muted',
            )}
          >
            {status}
          </span>
          {result?.truncated && (
            <span className="text-fg-dim inline-flex items-center gap-1 text-[11px]">
              <Scissors className="h-3 w-3" />
              {i18n.t('Output was shortened')}
            </span>
          )}
        </div>
        {result && <OutputBlock label={i18n.t('Command')} text={result.command} />}
        {result?.stdout && <OutputBlock label={i18n.t('Output')} text={result.stdout} />}
        {result?.stderr && (
          <OutputBlock label={i18n.t('Errors')} text={result.stderr} tone="error" />
        )}
        {result && !result.stdout && !result.stderr && (
          <p className="text-fg-dim text-[12px]">{i18n.t('The command printed nothing.')}</p>
        )}
      </div>
    </Dialog>
  );
}
