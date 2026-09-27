import * as i18n from '@/i18n/core';
import type { ClusterDef, ClusterEnvironment, ClusterStatus, ConnState } from '@/types';

/**
 * Environment badge metadata — the Kubepit equivalent of RunHQ's runtime
 * badges (`NODE`, `DOCKER`, …). Production is loud on purpose: every
 * destructive action on a production cluster asks for typed confirmation.
 *
 * Class names are literal so Tailwind's scanner keeps them.
 */
export interface EnvironmentMeta {
  key: ClusterEnvironment;
  label: string;
  short: string;
  /** Text colour for the compact sidebar badge. */
  color: string;
  /** Soft pill for cards and headers. */
  pill: string;
  dot: string;
}

export const ENVIRONMENTS: EnvironmentMeta[] = [
  {
    key: 'production',
    get label() {
      return i18n.t('Production');
    },
    short: 'PROD',
    color: 'text-status-error',
    pill: 'bg-status-error/12 text-status-error ring-status-error/25',
    dot: 'bg-status-error',
  },
  {
    key: 'staging',
    get label() {
      return i18n.t('Staging');
    },
    short: 'STG',
    color: 'text-status-starting',
    pill: 'bg-status-starting/12 text-status-starting ring-status-starting/25',
    dot: 'bg-status-starting',
  },
  {
    key: 'testing',
    get label() {
      return i18n.t('Testing');
    },
    short: 'TEST',
    color: 'text-cat-backend',
    pill: 'bg-cat-backend/12 text-cat-backend ring-cat-backend/25',
    dot: 'bg-cat-backend',
  },
  {
    key: 'development',
    get label() {
      return i18n.t('Development');
    },
    short: 'DEV',
    color: 'text-cat-frontend',
    pill: 'bg-cat-frontend/12 text-cat-frontend ring-cat-frontend/25',
    dot: 'bg-cat-frontend',
  },
  {
    key: 'local',
    get label() {
      return i18n.t('Local');
    },
    short: 'LOCAL',
    color: 'text-status-running',
    pill: 'bg-status-running/12 text-status-running ring-status-running/25',
    dot: 'bg-status-running',
  },
];

export function environmentMeta(env: ClusterEnvironment | null | undefined) {
  return env ? (ENVIRONMENTS.find((e) => e.key === env) ?? null) : null;
}

/** Guess an environment from a context name so imports start sensibly labelled. */
export function guessEnvironment(context: string): ClusterEnvironment | null {
  const c = context.toLowerCase();
  if (/(^|[-_.:/])(prod|prd|production|live)([-_.:/]|$)/.test(c)) return 'production';
  if (/(^|[-_.:/])(stag|stage|staging|stg|preprod|uat)([-_.:/]|$)/.test(c)) return 'staging';
  if (/(^|[-_.:/])(test|testing|qa|sit)([-_.:/]|$)/.test(c)) return 'testing';
  if (/(^|[-_.:/])(dev|develop|development|sandbox)([-_.:/]|$)/.test(c)) return 'development';
  if (/^(kind-|minikube|docker-desktop|rancher-desktop|orbstack|k3d-|colima)/.test(c))
    return 'local';
  return null;
}

/** Palette offered for cluster avatars. */
export const CLUSTER_COLORS = [
  '#fb923c',
  '#3b82f6',
  '#10b981',
  '#a855f7',
  '#ec4899',
  '#06b6d4',
  '#eab308',
  '#ef4444',
  '#64748b',
];

export function clusterColor(cluster: Pick<ClusterDef, 'id' | 'color'>): string {
  if (cluster.color) return cluster.color;
  let hash = 0;
  for (const ch of cluster.id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return CLUSTER_COLORS[hash % CLUSTER_COLORS.length]!;
}

/** Two-letter avatar initials: `prod-eu-west-1` → `PE`, `minikube` → `MI`. */
export function clusterInitials(name: string): string {
  const parts = name
    .replace(/^(arn:aws:eks:[^/]+\/|gke_[^_]+_[^_]+_)/, '')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return (parts[0] ?? name).slice(0, 2).toUpperCase();
}

export function connState(status: ClusterStatus | undefined): ConnState {
  return status?.state ?? 'disconnected';
}

export function isLive(state: ConnState) {
  return state === 'connected' || state === 'connecting';
}

/** All distinct tags across the workspace, sorted. */
export function allTags(clusters: ClusterDef[]): string[] {
  const set = new Set<string>();
  for (const c of clusters) for (const t of c.tags) set.add(t);
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** Short, human server label: strips scheme and default port. */
export function serverLabel(server: string | null | undefined): string {
  if (!server) return '';
  return server.replace(/^https?:\/\//, '').replace(/:443$/, '');
}

/** `arn:aws:eks:eu-west-1:123:cluster/prod` → `prod`; `gke_proj_zone_name` → `name`. */
export function prettyContextName(context: string): string {
  const eks = context.match(/^arn:aws:eks:[^:]+:\d+:cluster\/(.+)$/);
  if (eks?.[1]) return eks[1];
  const gke = context.match(/^gke_[^_]+_[^_]+_(.+)$/);
  if (gke?.[1]) return gke[1];
  return context;
}
