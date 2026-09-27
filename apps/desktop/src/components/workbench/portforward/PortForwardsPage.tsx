import * as i18n from '@/i18n';
import { ArrowRightLeft, Copy, ExternalLink, Square } from 'lucide-react';
import { IconButton } from '@/components/ui/IconButton';
import { ipc } from '@/lib/ipc';
import { BUILTIN, toGvk } from '@/lib/kube/catalog';
import { cn } from '@/lib/cn';
import { formatAge } from '@/lib/format';
import { useAppStore } from '@/store/useAppStore';
import { navigateTo } from '@/store/useWorkbenchStore';
import type { PortForward, PortForwardState } from '@/types';
import { openExternal } from '../actions/openExternal';
import { runMutation } from '../actions/guard';
import { copyText, useNow } from '../util';

const STATE: Record<PortForwardState, string> = {
  active: 'text-status-running',
  starting: 'text-status-starting',
  error: 'text-status-error',
  stopped: 'text-fg-dim',
};

function stateLabel(state: PortForwardState) {
  switch (state) {
    case 'active':
      return i18n.t('Active');
    case 'starting':
      return i18n.t('Starting');
    case 'error':
      return i18n.t('Error');
    default:
      return i18n.t('Stopped');
  }
}

/** Active port-forwards of this cluster. */
export function PortForwardsPage({
  clusterId,
  isActive,
}: {
  clusterId: string;
  isActive: boolean;
}) {
  i18n.useLocale();
  const all = useAppStore((s) => s.portForwards);
  const forwards = all.filter((f) => f.cluster_id === clusterId);
  const now = useNow(30_000, isActive);
  const stop = (f: PortForward) =>
    void runMutation(
      async () => {
        await ipc.portForwardStop(f.id);
        const store = useAppStore.getState();
        store.setPortForwards(store.portForwards.filter((x) => x.id !== f.id));
      },
      i18n.t('Stopped forwarding localhost:{port}', { port: f.local_port }),
    );
  const template = 'minmax(180px,2fr) minmax(110px,1fr) 80px minmax(180px,1.3fr) 88px 64px 96px';

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="border-border/60 flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <span className="bg-accent/10 text-accent flex h-6 w-6 items-center justify-center rounded-md">
          <ArrowRightLeft className="h-3.5 w-3.5" />
        </span>
        <h2 className="text-fg text-[13px] font-semibold">{i18n.t('Port Forwarding')}</h2>
        <span className="bg-surface-muted text-fg-dim rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums">
          {forwards.length}
        </span>
      </div>
      {!forwards.length ? (
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="max-w-sm text-center">
            <div className="bg-fg/5 text-fg-dim mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-xl">
              <ArrowRightLeft className="h-5 w-5" />
            </div>
            <h3 className="text-fg text-[13.5px] font-semibold">
              {i18n.t('No active port forwards')}
            </h3>
            <p className="text-fg-muted mt-1.5 text-[12px] leading-relaxed">
              {i18n.t(
                'Start one from a pod or service: open its details and choose Port forward, or use a container port button.',
              )}
            </p>
          </div>
        </div>
      ) : (
        <div
          role="table"
          aria-label={i18n.t('Port Forwarding')}
          className="min-h-0 flex-1 overflow-auto"
        >
          <div
            role="row"
            style={{ gridTemplateColumns: template }}
            className="border-border/70 text-fg-dim bg-surface/95 sticky top-0 grid h-8 items-center gap-x-3 border-b px-4 text-[10.5px] font-semibold tracking-[0.08em] uppercase"
          >
            <span role="columnheader">{i18n.t('Name')}</span>
            <span role="columnheader">{i18n.t('Namespace')}</span>
            <span role="columnheader">{i18n.t('Kind')}</span>
            <span role="columnheader">{i18n.t('Ports')}</span>
            <span role="columnheader">{i18n.t('Status')}</span>
            <span role="columnheader" className="text-right">
              {i18n.t('Age')}
            </span>
            <span role="columnheader" className="sr-only">
              {i18n.t('Actions')}
            </span>
          </div>
          {forwards.map((f) => {
            const url = `http://localhost:${f.local_port}`;
            const def = f.kind === 'pod' ? BUILTIN.Pod : BUILTIN.Service;
            return (
              <div
                key={f.id}
                role="row"
                style={{ gridTemplateColumns: template }}
                className="border-border/40 hover:bg-fg/4 group grid h-9 items-center gap-x-3 border-b px-4 text-[12px]"
              >
                <button
                  type="button"
                  role="cell"
                  onClick={() => navigateTo(clusterId, toGvk(def), f.namespace, f.name)}
                  className="text-accent min-w-0 truncate text-left hover:underline"
                >
                  {f.name}
                </button>
                <span role="cell" className="text-fg-muted truncate">
                  {f.namespace}
                </span>
                <span role="cell" className="text-fg-muted">
                  {f.kind === 'pod' ? 'Pod' : 'Service'}
                </span>
                <span role="cell" className="text-fg truncate font-mono text-[11.5px] tabular-nums">
                  {f.remote_port} →{' '}
                  <button
                    type="button"
                    onClick={() => void openExternal(url)}
                    className="text-accent hover:underline"
                  >
                    localhost:{f.local_port}
                  </button>
                </span>
                <span
                  role="cell"
                  className={cn('truncate font-medium', STATE[f.state])}
                  title={f.error ?? undefined}
                >
                  {stateLabel(f.state)}
                </span>
                <span role="cell" className="text-fg-muted text-right tabular-nums">
                  {formatAge(f.created_at, now)}
                </span>
                <span role="cell" className="flex justify-end gap-0.5">
                  <IconButton
                    size="xs"
                    label={i18n.t('Open in browser')}
                    icon={<ExternalLink />}
                    onClick={() => void openExternal(url)}
                  />
                  <IconButton
                    size="xs"
                    label={i18n.t('Copy URL')}
                    icon={<Copy />}
                    onClick={() => void copyText(url, url)}
                  />
                  <IconButton
                    size="xs"
                    tone="danger"
                    label={i18n.t('Stop')}
                    icon={<Square />}
                    onClick={() => stop(f)}
                  />
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
