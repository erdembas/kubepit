import * as i18n from '@/i18n';
import { useLocaleMemo } from '@/i18n';
import { useEffect, useState } from 'react';
import { FolderTree, RefreshCw, ShieldUser } from 'lucide-react';
import { IconButton } from '@/components/ui/IconButton';
import { SearchableSelect } from '@/components/ui/SearchableSelect';
import { formatAge } from '@/lib/format';
import type { SearchableOption } from '@/lib/selectSearch';
import { refreshAccess, useAccessRules } from '@/store/useAccessStore';
import type { ApiResourceInfo } from '@/types';
import { useCluster, useNamespaceNames, useSelectedNamespaces } from '../data/hooks';
import { refreshPolledPrefix } from '../data/polled';
import { useNow } from '../util';
import { CanIForm } from './CanIForm';
import { IdentityCard } from './IdentityCard';
import { PermissionMatrix } from './PermissionMatrix';
import { RbacExplorer } from './RbacExplorer';

/** Namespace picked on the page per cluster, valid while the view scope is unchanged. */
const picked = new Map<string, { scope: string; namespace: string }>();

function initialNamespace(clusterId: string, scope: string) {
  const remembered = picked.get(clusterId);
  return remembered?.scope === scope ? remembered.namespace : scope;
}

/** "My Permissions" (`@access`): identity, a can-i form and the permission matrix. */
export function PermissionsPage({
  clusterId,
  viewKey,
  isActive,
  apiResources,
}: {
  clusterId: string;
  viewKey: string;
  isActive: boolean;
  apiResources: ApiResourceInfo[] | null;
}) {
  i18n.useLocale();
  const { cluster } = useCluster(clusterId);
  const namespaces = useSelectedNamespaces(clusterId, viewKey);
  const names = useNamespaceNames(clusterId, isActive);
  const scope =
    namespaces.length === 1
      ? namespaces[0]!
      : (cluster?.default_namespace ?? namespaces[0] ?? 'default');
  const [namespace, setNamespace] = useState(() => initialNamespace(clusterId, scope));
  const now = useNow(15_000, isActive);
  const { updatedAt, loading } = useAccessRules(clusterId, namespace, isActive);

  // Follow the workbench scope when it changes.
  useEffect(() => setNamespace(initialNamespace(clusterId, scope)), [clusterId, scope]);

  const available = useLocaleMemo(
    () =>
      [...new Set([...(names.data ?? []), ...namespaces, namespace])].sort((a, b) =>
        a.localeCompare(b),
      ),
    [names.data, namespaces, namespace],
  );
  const options: SearchableOption[] = available.map((n) => ({ value: n, label: n }));

  const refresh = () => {
    refreshAccess(clusterId);
    refreshPolledPrefix(`${clusterId}|access-whoami|`);
  };

  if (!cluster) return null;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="border-border/60 flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <span className="bg-accent/10 text-accent flex h-6 w-6 shrink-0 items-center justify-center rounded-md">
          <ShieldUser className="h-3.5 w-3.5" />
        </span>
        <h2 className="text-fg shrink-0 text-[13px] font-semibold">{i18n.t('My Permissions')}</h2>
        <span className="text-fg-dim hidden truncate text-[11px] lg:inline">{cluster.name}</span>
        <div className="ml-auto flex min-w-0 items-center gap-1.5">
          {updatedAt > 0 && (
            <span className="text-fg-dim hidden text-[11px] tabular-nums md:inline">
              {loading
                ? i18n.t('Checking…')
                : i18n.t('Checked {age} ago', { age: formatAge(updatedAt, now) })}
            </span>
          )}
          <SearchableSelect
            value={namespace}
            onChange={(ns) => {
              picked.set(clusterId, { scope, namespace: ns });
              setNamespace(ns);
            }}
            options={options}
            label={i18n.t('Namespace')}
            compact
            leading={<FolderTree className="text-fg-dim h-3.5 w-3.5 shrink-0" />}
            className="max-w-60 font-mono"
            menuWidth={280}
          />
          <IconButton
            label={i18n.t('Refresh permissions')}
            icon={<RefreshCw />}
            onClick={refresh}
          />
        </div>
      </div>
      <div className="overlay-scroll min-h-0 flex-1 overflow-auto">
        <div className="space-y-3 p-4">
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            <IdentityCard cluster={cluster} isActive={isActive} />
            <CanIForm
              key={clusterId}
              clusterId={clusterId}
              namespaces={available}
              defaultNamespace={namespace}
              apiResources={apiResources}
            />
          </div>
          <PermissionMatrix
            clusterId={clusterId}
            namespace={namespace}
            apiResources={apiResources}
          />
          {/* Cluster RBAC: who can…, and what a subject can do. */}
          <RbacExplorer
            key={clusterId}
            clusterId={clusterId}
            namespaces={available}
            defaultNamespace={namespace}
            apiResources={apiResources}
            isActive={isActive}
          />
        </div>
      </div>
    </div>
  );
}
