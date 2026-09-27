import * as i18n from '@/i18n';
import { TriangleAlert } from 'lucide-react';
import { asNumber, asObject, asString, field, lastTimestamp } from '@/lib/kube/accessors';
import { resolveRef } from '@/lib/kube/catalog';
import { formatAge } from '@/lib/format';
import { navigateTo } from '@/store/useWorkbenchStore';
import type { ApiResourceInfo, KubeObject } from '@/types';

/** Recent Warning events; clicking one opens the involved object. */
export function WarningList({
  clusterId,
  events,
  apiResources,
  now,
  limit = 12,
}: {
  clusterId: string;
  events: KubeObject[];
  apiResources: ApiResourceInfo[] | null;
  now: number;
  limit?: number;
}) {
  i18n.useLocale();
  if (!events.length)
    return (
      <p className="text-fg-dim px-4 py-8 text-center text-[12px]">
        {i18n.t('No warnings. Everything looks healthy.')}
      </p>
    );
  return (
    <ul className="divide-border/60 divide-y">
      {events.slice(0, limit).map((e) => {
        const io = asObject(field(e, 'involvedObject'));
        const open = () => {
          const gvk = resolveRef(
            asString(io.apiVersion) || undefined,
            asString(io.kind),
            apiResources,
          );
          if (gvk) navigateTo(clusterId, gvk, asString(io.namespace) || null, asString(io.name));
        };
        const count = asNumber(field(e, 'count'), 1);
        return (
          <li key={e.metadata.uid}>
            <button
              type="button"
              onClick={open}
              className="hover:bg-fg/4 flex w-full items-start gap-2.5 px-4 py-2.5 text-left transition-colors"
            >
              <TriangleAlert className="text-status-starting mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-[12px]">
                  <span className="text-fg font-medium">{asString(field(e, 'reason'))}</span>
                  <span className="text-fg-dim truncate text-[11px]">
                    {asString(io.kind)} {asString(io.namespace) ? `${asString(io.namespace)}/` : ''}
                    {asString(io.name)}
                  </span>
                  {count > 1 && (
                    <span className="text-fg-dim bg-fg/5 shrink-0 rounded px-1 text-[10px] tabular-nums">
                      ×{count}
                    </span>
                  )}
                </span>
                <span className="text-fg-muted mt-0.5 line-clamp-2 block text-[11.5px] leading-relaxed">
                  {asString(field(e, 'message'))}
                </span>
              </span>
              <span className="text-fg-dim shrink-0 text-[11px] tabular-nums">
                {formatAge(lastTimestamp(e), now)}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
