import * as i18n from '@/i18n/core';
import type { LucideIcon } from 'lucide-react';
import type { ApiResourceInfo, Gvk } from '@/types';
import {
  BUILTIN,
  gvkFromApiResource,
  isCustomResource,
  isServed,
  kindKey,
  toGvk,
  type KindDef,
  type NavSectionId,
} from './catalog';
import { gitopsResources, isGitOpsResource } from './gitops/kinds';
import { kindIcon, SECTION_ICONS } from './icons';

/** Navigator tree (Freelens layout) built from the catalog plus discovery. */

export const VIEW_KEYS = {
  clusterOverview: '@overview',
  workloadsOverview: '@workloads',
  resourceMap: '@resource-map',
  portForwards: '@port-forwards',
  helmReleases: '@helm',
  myPermissions: '@access',
  helmCharts: '@helm-charts',
  clusterHealth: '@health',
  apiExplorer: '@explain',
  gitops: '@gitops',
  changes: '@changes',
  security: '@security',
} as const;

export interface NavItem {
  key: string;
  label: string;
  icon: LucideIcon;
  gvk: Gvk | null;
  /** Extra search terms (short names, group). */
  terms: string;
}

export interface NavSubgroup {
  id: string;
  label: string;
  items: NavItem[];
}

export interface NavGroup {
  id: NavSectionId;
  label: string;
  icon: LucideIcon;
  items: NavItem[];
  subgroups: NavSubgroup[];
}

function sectionLabel(id: NavSectionId): string {
  switch (id) {
    case 'cluster':
      return i18n.t('Cluster');
    case 'workloads':
      return i18n.t('Workloads');
    case 'config':
      return i18n.t('Config');
    case 'network':
      return i18n.t('Network');
    case 'storage':
      return i18n.t('Storage');
    case 'access':
      return i18n.t('Access Control');
    case 'helm':
      return i18n.t('Helm');
    case 'gitops':
      return i18n.t('GitOps');
    default:
      return i18n.t('Custom Resources');
  }
}

function kindItem(k: KindDef): NavItem {
  return {
    key: k.key,
    label: k.key === BUILTIN.CustomResourceDefinition.key ? i18n.t('Definitions') : k.title,
    icon: kindIcon(k.key),
    gvk: toGvk(k),
    terms: `${k.kind} ${k.plural} ${k.shortNames.join(' ')} ${k.group}`.toLowerCase(),
  };
}

function viewItem(key: string, label: string, terms: string): NavItem {
  return { key, label, icon: kindIcon(key), gvk: null, terms: terms.toLowerCase() };
}

/** Human label for any view key (header, breadcrumbs, command palette). */
export function viewLabel(key: string, apiResources?: readonly ApiResourceInfo[] | null): string {
  if (key === VIEW_KEYS.clusterOverview) return i18n.t('Cluster Overview');
  if (key === VIEW_KEYS.workloadsOverview) return i18n.t('Workloads Overview');
  if (key === VIEW_KEYS.resourceMap) return i18n.t('Resource Map');
  if (key === VIEW_KEYS.portForwards) return i18n.t('Port Forwarding');
  if (key === VIEW_KEYS.helmReleases) return i18n.t('Helm Releases');
  if (key === VIEW_KEYS.myPermissions) return i18n.t('My Permissions');
  if (key === VIEW_KEYS.helmCharts) return i18n.t('Helm Charts');
  if (key === VIEW_KEYS.clusterHealth) return i18n.t('Cluster Health');
  if (key === VIEW_KEYS.apiExplorer) return i18n.t('API Explorer');
  if (key === VIEW_KEYS.gitops) return i18n.t('GitOps Overview');
  if (key === VIEW_KEYS.changes) return i18n.t('Changes');
  if (key === VIEW_KEYS.security) return i18n.t('Security');
  const builtin = Object.values(BUILTIN).find((k) => k.key === key);
  if (builtin)
    return builtin.key === BUILTIN.CustomResourceDefinition.key
      ? 'CustomResourceDefinitions'
      : builtin.title;
  const crd = apiResources?.find((r) => kindKey(r) === key);
  if (crd) return pluralKind(crd.kind);
  return key.split('.')[0] ?? key;
}

export function pluralKind(kind: string): string {
  if (/(s|x|z|ch|sh)$/.test(kind)) return `${kind}es`;
  if (/[^aeiou]y$/.test(kind)) return `${kind.slice(0, -1)}ies`;
  return `${kind}s`;
}

function resourceItem(r: ApiResourceInfo): NavItem {
  const key = kindKey(r);
  return {
    key,
    label: pluralKind(r.kind),
    icon: kindIcon(key),
    gvk: gvkFromApiResource(r),
    terms: `${r.kind} ${r.plural} ${r.short_names.join(' ')} ${r.group}`.toLowerCase(),
  };
}

/** GitOps (Argo CD, Flux): only when discovery serves one of their kinds. */
function gitopsGroup(apiResources: readonly ApiResourceInfo[] | null): NavGroup | null {
  const served = gitopsResources(apiResources);
  if (!served.length) return null;
  const minor = (r: ApiResourceInfo) =>
    r.group === 'notification.toolkit.fluxcd.io' || r.group === 'image.toolkit.fluxcd.io';
  const subgroups = new Map<string, NavItem[]>();
  for (const r of served.filter(minor))
    subgroups.set(r.group, [...(subgroups.get(r.group) ?? []), resourceItem(r)]);
  return {
    id: 'gitops',
    label: sectionLabel('gitops'),
    icon: SECTION_ICONS.gitops,
    items: [
      viewItem(VIEW_KEYS.gitops, i18n.t('Overview'), 'gitops argo argocd flux sync overview'),
      ...served.filter((r) => !minor(r)).map(resourceItem),
    ],
    subgroups: [...subgroups.entries()].map(([group, list]) => ({
      id: `gitops:${group}`,
      label: group,
      items: list,
    })),
  };
}

export function buildNav(apiResources: readonly ApiResourceInfo[] | null): NavGroup[] {
  const served = (k: KindDef) => isServed(k, apiResources);
  const items = (section: NavSectionId) =>
    Object.values(BUILTIN)
      .filter((k) => k.section === section && served(k))
      .map(kindItem);

  const groups: NavGroup[] = [
    {
      id: 'cluster',
      label: sectionLabel('cluster'),
      icon: SECTION_ICONS.cluster,
      items: [
        viewItem(VIEW_KEYS.clusterOverview, i18n.t('Overview'), 'overview cluster dashboard'),
        viewItem(
          VIEW_KEYS.clusterHealth,
          i18n.t('Health'),
          'health checks popeye lint score findings certificates tls expiry',
        ),
        viewItem(
          VIEW_KEYS.security,
          i18n.t('Security'),
          'security trivy vulnerabilities cve images compliance exposed secrets pod security standards pss',
        ),
        viewItem(
          VIEW_KEYS.changes,
          i18n.t('Changes'),
          'changes timeline history audit diff what changed incident',
        ),
        ...items('cluster'),
        viewItem(
          VIEW_KEYS.apiExplorer,
          i18n.t('API Explorer'),
          'api explorer explain schema openapi fields crd',
        ),
      ],
      subgroups: [],
    },
    {
      id: 'workloads',
      label: sectionLabel('workloads'),
      icon: SECTION_ICONS.workloads,
      items: [
        viewItem(VIEW_KEYS.workloadsOverview, i18n.t('Overview'), 'overview workloads'),
        viewItem(
          VIEW_KEYS.resourceMap,
          i18n.t('Resource Map'),
          'resource map topology graph relationships dependencies',
        ),
        ...items('workloads'),
      ],
      subgroups: [],
    },
    {
      id: 'config',
      label: sectionLabel('config'),
      icon: SECTION_ICONS.config,
      items: items('config'),
      subgroups: [],
    },
    {
      id: 'network',
      label: sectionLabel('network'),
      icon: SECTION_ICONS.network,
      items: [
        ...items('network'),
        viewItem(VIEW_KEYS.portForwards, i18n.t('Port Forwarding'), 'port forward pf'),
      ],
      subgroups: [],
    },
    {
      id: 'storage',
      label: sectionLabel('storage'),
      icon: SECTION_ICONS.storage,
      items: items('storage'),
      subgroups: [],
    },
    {
      id: 'access',
      label: sectionLabel('access'),
      icon: SECTION_ICONS.access,
      items: [
        viewItem(
          VIEW_KEYS.myPermissions,
          i18n.t('My Permissions'),
          'my permissions rbac can-i whoami access review',
        ),
        ...items('access'),
      ],
      subgroups: [],
    },
    {
      id: 'helm',
      label: sectionLabel('helm'),
      icon: SECTION_ICONS.helm,
      items: [
        viewItem(VIEW_KEYS.helmCharts, i18n.t('Charts'), 'helm charts repositories install hub'),
        viewItem(VIEW_KEYS.helmReleases, i18n.t('Releases'), 'helm releases charts'),
      ],
      subgroups: [],
    },
  ];
  const gitops = gitopsGroup(apiResources);
  if (gitops) groups.push(gitops);

  const byGroup = new Map<string, NavItem[]>();
  const seen = new Set<string>();
  for (const r of apiResources ?? []) {
    if (!isCustomResource(r) || r.group === 'metrics.k8s.io' || isGitOpsResource(r)) continue;
    const key = kindKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    const list = byGroup.get(r.group) ?? [];
    list.push({
      key,
      label: pluralKind(r.kind),
      icon: kindIcon(key),
      gvk: gvkFromApiResource(r),
      terms: `${r.kind} ${r.plural} ${r.short_names.join(' ')} ${r.group}`.toLowerCase(),
    });
    byGroup.set(r.group, list);
  }
  groups.push({
    id: 'custom',
    label: sectionLabel('custom'),
    icon: SECTION_ICONS.custom,
    items: items('custom'),
    subgroups: [...byGroup.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([group, list]) => ({
        id: `crd:${group}`,
        label: group,
        items: list.sort((a, b) => a.label.localeCompare(b.label)),
      })),
  });
  return groups;
}

/** Flat list of every navigable item (pins, quick jump, keyboard navigation). */
export function flattenNav(groups: NavGroup[]): NavItem[] {
  return groups.flatMap((g) => [...g.items, ...g.subgroups.flatMap((s) => s.items)]);
}
