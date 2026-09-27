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
import { kindIcon, SECTION_ICONS } from './icons';

/** Navigator tree (Freelens layout) built from the catalog plus discovery. */

export const VIEW_KEYS = {
  clusterOverview: '@overview',
  workloadsOverview: '@workloads',
  portForwards: '@port-forwards',
  helmReleases: '@helm',
  helmCharts: '@helm-charts',
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
  if (key === VIEW_KEYS.portForwards) return i18n.t('Port Forwarding');
  if (key === VIEW_KEYS.helmReleases) return i18n.t('Helm Releases');
  if (key === VIEW_KEYS.helmCharts) return i18n.t('Helm Charts');
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
        ...items('cluster'),
      ],
      subgroups: [],
    },
    {
      id: 'workloads',
      label: sectionLabel('workloads'),
      icon: SECTION_ICONS.workloads,
      items: [
        viewItem(VIEW_KEYS.workloadsOverview, i18n.t('Overview'), 'overview workloads'),
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
      items: items('access'),
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

  const byGroup = new Map<string, NavItem[]>();
  const seen = new Set<string>();
  for (const r of apiResources ?? []) {
    if (!isCustomResource(r) || r.group === 'metrics.k8s.io') continue;
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
