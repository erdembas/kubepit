import * as i18n from '@/i18n';
import { ArrowRightLeft } from 'lucide-react';
import { ForwardRowActions, ForwardStateLabel } from '@/components/port-forwards/ForwardRowParts';
import { BUILTIN, toGvk } from '@/lib/kube/catalog';
import { formatAge } from '@/lib/format';
import { forwardRows, forwardTitle, forwardUrl, rowLocalPort } from '@/lib/portForwards';
import { useAppStore } from '@/store/useAppStore';
import { useConnectivityStore } from '@/store/useConnectivityStore';
import { navigateTo } from '@/store/useWorkbenchStore';
import { openExternal } from '../actions/openExternal';
import { useNow } from '../util';

/** Port-forwards of this cluster: running ones and saved ones that are stopped. */
export function PortForwardsPage({
  clusterId,
  isActive,
}: {
  clusterId: string;
  isActive: boolean;
}) {
  i18n.useLocale();
  const live = useAppStore((s) => s.portForwards);
  const saved = useConnectivityStore((s) => s.savedForwards);
  const rows = forwardRows(live, saved, clusterId);
  const now = useNow(30_000, isActive);
  const template = 'minmax(180px,2fr) minmax(110px,1fr) 80px minmax(180px,1.3fr) 88px 64px 156px';

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="border-border/60 flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <span className="bg-accent/10 text-accent flex h-6 w-6 items-center justify-center rounded-md">
          <ArrowRightLeft className="h-3.5 w-3.5" />
        </span>
        <h2 className="text-fg text-[13px] font-semibold">{i18n.t('Port Forwarding')}</h2>
        <span className="bg-surface-muted text-fg-dim rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums">
          {rows.length}
        </span>
      </div>
      {!rows.length ? (
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
          {rows.map((row) => {
            const def = row.kind === 'pod' ? BUILTIN.Pod : BUILTIN.Service;
            const local = rowLocalPort(row);
            const running = row.live && row.live.state !== 'error' && local != null;
            return (
              <div
                key={row.key}
                role="row"
                style={{ gridTemplateColumns: template }}
                className="border-border/40 hover:bg-fg/4 group grid h-9 items-center gap-x-3 border-b px-4 text-[12px]"
              >
                <button
                  type="button"
                  role="cell"
                  title={`${row.kind}/${row.namespace}/${row.name}`}
                  onClick={() => navigateTo(clusterId, toGvk(def), row.namespace, row.name)}
                  className="text-accent min-w-0 truncate text-left hover:underline"
                >
                  {row.saved?.label ? forwardTitle(row.saved) : row.name}
                </button>
                <span role="cell" className="text-fg-muted truncate">
                  {row.namespace}
                </span>
                <span role="cell" className="text-fg-muted">
                  {row.kind === 'pod' ? 'Pod' : 'Service'}
                </span>
                <span role="cell" className="text-fg truncate font-mono text-[11.5px] tabular-nums">
                  {row.remote_port} →{' '}
                  {running ? (
                    <button
                      type="button"
                      onClick={() => void openExternal(forwardUrl(local))}
                      className="text-accent hover:underline"
                    >
                      localhost:{local}
                    </button>
                  ) : (
                    <span className="text-fg-dim">localhost:{local ?? i18n.t('auto')}</span>
                  )}
                </span>
                <span role="cell" className="min-w-0">
                  <ForwardStateLabel row={row} />
                </span>
                <span role="cell" className="text-fg-muted text-right tabular-nums">
                  {row.live ? formatAge(row.live.created_at, now) : '—'}
                </span>
                <ForwardRowActions row={row} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
