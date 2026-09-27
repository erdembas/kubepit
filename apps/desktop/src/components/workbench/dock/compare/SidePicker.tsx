import { useLocaleMemo as useMemo } from '@/i18n';
import * as i18n from '@/i18n';
import { SearchableSelect } from '@/components/ui/SearchableSelect';
import { ipc } from '@/lib/ipc';
import { clusterColor, environmentMeta } from '@/lib/clusterMeta';
import type { SearchableOption } from '@/lib/selectSearch';
import { useAppStore } from '@/store/useAppStore';
import type { CompareSide } from '@/store/useDockStore';
import type { Gvk } from '@/types';
import { useNamespaceNames } from '../../data/hooks';
import { usePolled } from '../../data/polled';
import { servedGvk } from './compareData';

const custom = (query: string): SearchableOption | null => {
  const value = query.trim();
  return value ? { value, label: value, description: i18n.t('Use this value') } : null;
};

/** Object names of `gvk` on one cluster/namespace, for name autocomplete. */
function useObjectNames(clusterId: string, gvk: Gvk, namespace: string | null, enabled: boolean) {
  return usePolled<string[]>(
    enabled ? `${clusterId}|compare-names|${gvk.group}/${gvk.plural}|${namespace ?? ''}` : null,
    async () => {
      const served = await servedGvk(clusterId, gvk);
      if (!served) return [];
      const list = await ipc.resourceList(clusterId, served, served.namespaced ? namespace : null);
      return list.items.map((o) => o.metadata.name).sort((a, b) => a.localeCompare(b));
    },
    null,
    enabled,
  );
}

/** Cluster / namespace / name of one compare side. */
export function SidePicker({
  side,
  gvk,
  onChange,
  enabled,
  label,
}: {
  side: CompareSide;
  gvk: Gvk;
  onChange: (side: CompareSide) => void;
  enabled: boolean;
  label: string;
}) {
  i18n.useLocale();
  const clusters = useAppStore((s) => s.clusters);
  const statuses = useAppStore((s) => s.statuses);
  const connected = statuses[side.clusterId]?.state === 'connected';
  const namespaces = useNamespaceNames(side.clusterId, enabled && connected && gvk.namespaced);
  const names = useObjectNames(side.clusterId, gvk, side.namespace, enabled && connected);

  const clusterOptions = useMemo<SearchableOption[]>(
    () =>
      clusters.map((c) => {
        const live = statuses[c.id]?.state === 'connected';
        return {
          value: c.id,
          label: c.name,
          color: clusterColor(c),
          badge: environmentMeta(c.environment)?.short,
          description: live ? c.context : i18n.t('Not connected'),
          disabled: !live && c.id !== side.clusterId,
          keywords: `${c.environment ?? ''} ${c.tags.join(' ')}`,
        };
      }),
    [clusters, statuses, side.clusterId],
  );
  const nsOptions = useMemo<SearchableOption[]>(() => {
    const list = namespaces.data ?? [];
    const all = side.namespace && !list.includes(side.namespace) ? [side.namespace, ...list] : list;
    return all.map((ns) => ({ value: ns, label: ns }));
  }, [namespaces.data, side.namespace]);
  const nameOptions = useMemo<SearchableOption[]>(() => {
    const list = names.data ?? [];
    const all = list.includes(side.name) ? list : [side.name, ...list];
    return all.map((n) => ({
      value: n,
      label: n,
      description: list.includes(n) ? undefined : i18n.t('Not found in this namespace'),
    }));
  }, [names.data, side.name]);

  return (
    <div className="flex max-w-full min-w-0 shrink-0 items-center gap-0.5" aria-label={label}>
      <SearchableSelect
        compact
        label={i18n.t('Cluster')}
        value={side.clusterId}
        options={clusterOptions}
        onChange={(clusterId) => onChange({ ...side, clusterId })}
        className="max-w-[190px] min-w-[120px] font-medium"
        menuWidth={300}
      />
      {gvk.namespaced && (
        <>
          <span className="text-fg-dim/60 text-[12px]">/</span>
          <SearchableSelect
            compact
            label={i18n.t('Namespace')}
            value={side.namespace ?? ''}
            options={nsOptions}
            createOption={custom}
            onChange={(namespace) => onChange({ ...side, namespace })}
            className="max-w-[160px] min-w-[90px] font-mono text-[11.5px]"
            menuWidth={260}
          />
        </>
      )}
      <span className="text-fg-dim/60 text-[12px]">/</span>
      <SearchableSelect
        compact
        label={i18n.t('Name')}
        value={side.name}
        options={nameOptions}
        createOption={custom}
        onChange={(name) => onChange({ ...side, name })}
        className="max-w-[240px] min-w-[120px] font-mono text-[11.5px]"
        menuWidth={320}
      />
    </div>
  );
}
