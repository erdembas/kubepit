import * as i18n from '@/i18n';
import { useEffect, useState } from 'react';
import { FileCode2, KeyRound, Loader2, X } from 'lucide-react';
import { SavedForwardDialog } from '@/components/port-forwards/SavedForwardDialog';
import { connectCluster, disconnectCluster } from '@/lib/clusterActions';
import { events, ipc } from '@/lib/ipc';
import { newContextsMessage, pendingNotice, reconnectMessage } from '@/lib/kubeconfigNotice';
import { useAppStore } from '@/store/useAppStore';
import { useConnectivityStore } from '@/store/useConnectivityStore';

/**
 * Connectivity glue mounted once in the app overlays: loads saved port
 * forwards, follows `portforward://saved` and `kubeconfig://changed`, and
 * renders the kubeconfig-change notice and the saved-forward editor.
 */
export function ConnectivityHost() {
  i18n.useLocale();
  const editing = useConnectivityStore((s) => s.editingSaved);

  useEffect(() => {
    let disposed = false;
    const unlisten: Array<() => void> = [];
    void (async () => {
      const saved = await ipc.portForwardSavedList().catch(() => null);
      if (disposed) return;
      if (saved) useConnectivityStore.getState().setSavedForwards(saved);
      unlisten.push(
        await events.onSavedPortForwards((list) =>
          useConnectivityStore.getState().setSavedForwards(list),
        ),
        await events.onKubeconfigChanged((change) =>
          useConnectivityStore.getState().addKubeconfigChange(change),
        ),
      );
      if (disposed) unlisten.forEach((fn) => fn());
    })();
    return () => {
      disposed = true;
      unlisten.forEach((fn) => fn());
    };
  }, []);

  return (
    <>
      <KubeconfigNotice />
      {editing && <SavedForwardDialog key={editing.id} saved={editing} />}
    </>
  );
}

/** Small bottom notice: new contexts on disk, or credentials that changed under a live connection. */
function KubeconfigNotice() {
  i18n.useLocale();
  const notice = useConnectivityStore((s) => s.kubeconfigNotice);
  const clusters = useAppStore((s) => s.clusters);
  const statuses = useAppStore((s) => s.statuses);
  const dataDir = useAppStore((s) => s.appInfo?.data_dir);
  const [reconnecting, setReconnecting] = useState(false);
  const { newContexts, reconnect } = pendingNotice(notice, clusters, statuses);
  if (!newContexts.length && !reconnect.length) return null;

  const clear = (part: 'new_contexts' | 'reconnect') =>
    useConnectivityStore.setState((s) => {
      if (!s.kubeconfigNotice) return {};
      const next = { ...s.kubeconfigNotice, [part]: [] };
      return {
        kubeconfigNotice: next.new_contexts.length || next.reconnect.length ? next : null,
      };
    });
  const review = () => {
    useConnectivityStore.getState().setDiscoverPreselect(newContexts);
    useAppStore.getState().setImportDialogOpen(true);
    clear('new_contexts');
  };
  const reconnectAll = async () => {
    setReconnecting(true);
    try {
      await Promise.all(
        reconnect.map(async (cluster) => {
          await disconnectCluster(cluster.id);
          await connectCluster(cluster.id);
        }),
      );
      clear('reconnect');
    } finally {
      setReconnecting(false);
    }
  };

  return (
    <div
      role="status"
      className="border-border bg-surface-overlay fixed bottom-12 left-1/2 z-[65] flex max-w-[560px] -translate-x-1/2 items-start gap-2 rounded-lg border px-3 py-2 shadow-[0_12px_40px_rgba(0,0,0,0.35)]"
    >
      <div className="min-w-0 flex-1 space-y-1.5">
        {newContexts.length > 0 && (
          <div className="flex items-center gap-2.5">
            <FileCode2 className="text-accent h-3.5 w-3.5 shrink-0" />
            <p className="text-fg min-w-0 flex-1 truncate text-[12px]">
              {newContextsMessage(newContexts, dataDir)}
            </p>
            <button
              type="button"
              onClick={review}
              className="text-accent hover:bg-accent/10 shrink-0 rounded-md px-2 py-0.5 text-[11.5px] font-medium"
            >
              {i18n.t('Review')}
            </button>
          </div>
        )}
        {reconnect.length > 0 && (
          <div className="flex items-center gap-2.5">
            <KeyRound className="text-status-starting h-3.5 w-3.5 shrink-0" />
            <p className="text-fg min-w-0 flex-1 truncate text-[12px]">
              {reconnectMessage(reconnect)}
            </p>
            <button
              type="button"
              disabled={reconnecting}
              onClick={() => void reconnectAll()}
              className="text-accent hover:bg-accent/10 inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-[11.5px] font-medium disabled:opacity-60"
            >
              {reconnecting && <Loader2 className="h-3 w-3 animate-spin" />}
              {i18n.t('Reconnect')}
            </button>
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={() => useConnectivityStore.getState().dismissKubeconfigNotice()}
        aria-label={i18n.t('Dismiss')}
        className="text-fg-dim hover:text-fg mt-0.5 rounded p-0.5"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
