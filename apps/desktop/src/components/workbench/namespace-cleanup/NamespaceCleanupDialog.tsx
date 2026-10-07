import * as i18n from '@/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Bomb, Loader2, RefreshCw } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Input';
import { isTauri } from '@/lib/ipc/invoke';
import { ipc } from '@/lib/ipc';
import { useAppStore } from '@/store/useAppStore';
import type { NamespaceCleanupPlan, NamespaceCleanupResult } from '@/types/namespaceCleanup';
import { confirmDestructive } from '../actions/guard';
import { cleanupMessage } from './model';

/**
 * "Empty a namespace": a multi-step destructive flow. The preview is
 * read-only; the run is gated four times — three explicit acknowledgements,
 * typing the namespace name, the app-wide destructive confirm (type-to-confirm
 * on production clusters), and the backend's own confirmation check.
 */
export function NamespaceCleanupDialog({
  clusterId,
  namespace,
  onClose,
}: {
  clusterId: string;
  namespace: string;
  onClose: () => void;
}) {
  i18n.useLocale();
  const cluster = useAppStore((state) => state.clusters.find((item) => item.id === clusterId));
  const [plan, setPlan] = useState<NamespaceCleanupPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [acks, setAcks] = useState([false, false, false]);
  const [result, setResult] = useState<NamespaceCleanupResult | null>(null);
  const generation = useRef(0);
  const close = () => {
    if (useAppStore.getState().confirm) return;
    generation.current++;
    onClose();
  };
  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    setError(null);
    setTyped('');
    setAcks([false, false, false]);
    setPlan(null);
    setResult(null);
    try {
      const value = await ipc.namespaceCleanupPreview(clusterId, namespace);
      if (generation.current === current) setPlan(value);
    } catch (e) {
      if (generation.current === current) setError(cleanupMessage(e));
    } finally {
      if (generation.current === current) setLoading(false);
    }
  }, [clusterId, namespace]);
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);

  const read_only = !!cluster?.read_only || !!plan?.read_only;
  const acked = acks.every(Boolean);
  const armed =
    !!plan &&
    !result &&
    plan.total_objects > 0 &&
    acked &&
    typed.trim() === plan.namespace &&
    !read_only &&
    !busy;

  const purge = () => {
    if (!plan || !armed) return;
    const current = generation.current;
    confirmDestructive({
      cluster,
      title: i18n.t('Empty namespace'),
      confirmLabel: i18n.t('Delete everything'),
      typeName: plan.namespace,
      message: i18n.t(
        'Permanently delete all {count} objects in namespace {namespace}? There is no undo and no trash.',
        { count: plan.total_objects, namespace: plan.namespace },
      ),
      run: async () => {
        if (generation.current !== current) return;
        const latest = useAppStore.getState();
        if (latest.clusters.find((item) => item.id === clusterId)?.read_only) {
          setError(cleanupMessage('read-only'));
          return;
        }
        if (latest.statuses[clusterId]?.state !== 'connected') {
          setError(cleanupMessage('disconnected'));
          return;
        }
        setBusy(true);
        setError(null);
        try {
          const done = await ipc.namespaceCleanupRun(clusterId, {
            namespace: plan.namespace,
            confirm_name: typed.trim(),
          });
          if (generation.current !== current) return;
          setResult(done);
          latest.pushToast(
            'success',
            i18n.plural('Deleted {count} object', 'Deleted {count} objects', done.deleted),
          );
        } catch (e) {
          if (generation.current === current) setError(cleanupMessage(e));
        } finally {
          if (generation.current === current) setBusy(false);
        }
      },
    });
  };

  return (
    <Dialog
      title={i18n.t('Empty namespace')}
      subtitle={namespace}
      size="lg"
      onClose={close}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {i18n.t('Close')}
          </Button>
          <Button
            variant="secondary"
            disabled={loading || busy}
            leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
            onClick={() => void load()}
          >
            {i18n.t('Refresh plan')}
          </Button>
          {!result && (
            <Button
              variant="danger"
              disabled={!armed}
              onClick={purge}
              leftIcon={busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : undefined}
            >
              {busy ? i18n.t('Deleting…') : i18n.t('Delete everything')}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4 text-[12px]">
        <p className="text-fg-muted">
          {i18n.t(
            'This permanently deletes every resource in namespace {namespace} — workloads, ConfigMaps, Secrets, Services, Ingresses, PersistentVolumeClaims and custom resources. Nothing is kept back.',
            { namespace },
          )}
        </p>
        <Danger>
          {i18n.t(
            'This action can never be undone. Kubepit has no trash and no undo for deleted objects; PersistentVolumeClaims take their data with them.',
          )}
        </Danger>
        {!isTauri && (
          <Notice>
            {i18n.t('Demo purge runs against fixture data; no real cluster is changed.')}
          </Notice>
        )}
        {loading && (
          <p role="status" className="text-fg-dim flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            {i18n.t('Reading the namespace inventory…')}
          </p>
        )}
        {error && (
          <p role="alert" className="text-status-error whitespace-pre-wrap">
            {error}
          </p>
        )}
        {plan && (
          <>
            <div className="text-fg-dim flex flex-wrap gap-x-5 gap-y-1 text-[11px]">
              <span>
                {i18n.t('Checked {time}', {
                  time: new Date(plan.checked_at).toLocaleTimeString(),
                })}
              </span>
              <span>{i18n.plural('{count} object', '{count} objects', plan.total_objects)}</span>
              <span>{i18n.t('{count} kinds', { count: plan.kinds.length })}</span>
            </div>
            {read_only && <Notice>{cleanupMessage('read-only')}</Notice>}
            {plan.warnings.map((warning) => (
              <Notice key={warning}>{cleanupMessage(warning)}</Notice>
            ))}
            {plan.total_objects === 0 ? (
              <p className="text-fg-muted">
                {i18n.t('The namespace is empty; there is nothing to delete.')}
              </p>
            ) : (
              <section>
                <Heading>{i18n.t('What will be deleted')}</Heading>
                <p className="text-fg-dim mt-1 text-[11px]">
                  {i18n.t(
                    'Kinds are deleted in order: controllers first, ordinary resources, then unmanaged Pods, data last.',
                  )}
                </p>
                <div className="border-border/60 mt-2 overflow-x-auto rounded-md border">
                  <table className="w-full text-left text-[11px]">
                    <thead className="bg-fg/3 text-fg-dim">
                      <tr>
                        <th className="p-2">{i18n.t('Kind')}</th>
                        <th className="w-16 p-2 text-right">{i18n.t('Objects')}</th>
                        <th className="p-2">{i18n.t('Names')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {plan.kinds.map((kind) => (
                        <tr
                          key={`${kind.gvk.group}/${kind.gvk.kind}`}
                          className="border-border/40 border-t"
                        >
                          <td className="p-2 font-mono">{kind.gvk.kind}</td>
                          <td className="p-2 text-right tabular-nums">{kind.count}</td>
                          <td className="text-fg-dim p-2 font-mono break-all">
                            {kind.names.join(', ')}
                            {kind.count > kind.names.length &&
                              ` +${kind.count - kind.names.length}`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
            {!result && plan.total_objects > 0 && (
              <section className="border-border/60 space-y-3 border-t pt-4">
                <Heading>{i18n.t('Acknowledge to continue')}</Heading>
                {[
                  i18n.t(
                    'I understand that every resource listed above will be permanently deleted.',
                  ),
                  i18n.t(
                    'I understand that PersistentVolumeClaims and their data will be deleted and cannot be restored.',
                  ),
                  i18n.t(
                    'I understand that this action cannot be undone, and I am authorized to empty this namespace.',
                  ),
                ].map((label, index) => (
                  <label key={index} className="text-fg-muted flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={acks[index] ?? false}
                      disabled={busy}
                      onChange={(event) =>
                        setAcks((prev) =>
                          prev.map((value, i) => (i === index ? event.target.checked : value)),
                        )
                      }
                      className="accent-accent mt-0.5"
                    />
                    <span>{label}</span>
                  </label>
                ))}
                <Field
                  label={i18n.t('Type the namespace name to confirm')}
                  hint={<span className="font-mono">{plan.namespace}</span>}
                >
                  <Input
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    disabled={busy}
                    placeholder={plan.namespace}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoComplete="off"
                    autoCorrect="off"
                    mono
                  />
                </Field>
                <p className="text-fg-dim text-[11px]">
                  {i18n.t('Deleting asks once more before it runs. The namespace itself is kept.')}
                </p>
              </section>
            )}
            {result && (
              <section className="border-border/60 space-y-3 border-t pt-4">
                <Heading>{i18n.t('Deletion report')}</Heading>
                <p className="text-fg-muted">
                  {i18n.t('{deleted} deleted · {gone} already gone · {failed} failed', {
                    deleted: result.deleted,
                    gone: result.already_gone,
                    failed: result.failed,
                  })}
                </p>
                {result.failed > 0 && <Danger>{cleanupMessage('partial')}</Danger>}
                {result.kinds
                  .filter((kind) => kind.errors.length)
                  .map((kind) => (
                    <pre
                      key={`${kind.gvk.group}/${kind.gvk.kind}`}
                      className="text-status-error border-status-error/20 bg-status-error/5 rounded-md border p-2 font-mono text-[11px] whitespace-pre-wrap"
                    >
                      {kind.gvk.kind}:{'\n'}
                      {kind.errors.join('\n')}
                    </pre>
                  ))}
              </section>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-fg-muted text-[11px] font-semibold tracking-wider uppercase">{children}</h3>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-status-starting/20 bg-status-starting/5 text-status-starting flex items-start gap-2 rounded-md border px-3 py-2 text-[11px]">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

function Danger({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-status-error/20 bg-status-error/5 text-status-error flex items-start gap-2 rounded-md border px-3 py-2 text-[11.5px]">
      <Bomb className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}
