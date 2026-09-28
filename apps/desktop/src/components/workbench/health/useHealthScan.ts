import * as i18n from '@/i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import { BUILTIN, gvkFromApiResource, isServed, toGvk, type KindDef } from '@/lib/kube/catalog';
import {
  scanHealthAsync,
  summarize,
  type Finding,
  type HealthInput,
  type HealthKind,
  type HealthScan,
  type HealthSummary,
} from '@/lib/kube/health';
import { useHealthIgnores, useHealthStore } from '@/store/useHealthStore';
import type { ApiResourceInfo, Gvk } from '@/types';
import { restartWatch, useWatch, type WatchSnapshot } from '../data/watchCache';
import { useCostPrefs } from '../cost/prefs';
import { useRightsizing } from '../cost/useCost';
import { useNow } from '../util';

/**
 * Feeds the health engine from the shared watch cache. Lists are watched
 * with the same keys as the resource tables, so an open Pods tab and the
 * health view share one backend watch. Scans run after every list has
 * synced (or failed), at most every few seconds, in slices off the render
 * path; identical inputs reuse the cached scan across components.
 */

const KINDS: ReadonlyArray<[HealthKind, KindDef]> = [
  ['pods', BUILTIN.Pod],
  ['deployments', BUILTIN.Deployment],
  ['statefulSets', BUILTIN.StatefulSet],
  ['daemonSets', BUILTIN.DaemonSet],
  ['jobs', BUILTIN.Job],
  ['cronJobs', BUILTIN.CronJob],
  ['services', BUILTIN.Service],
  ['ingresses', BUILTIN.Ingress],
  ['configMaps', BUILTIN.ConfigMap],
  ['secrets', BUILTIN.Secret],
  ['serviceAccounts', BUILTIN.ServiceAccount],
  ['pvcs', BUILTIN.PersistentVolumeClaim],
  ['pdbs', BUILTIN.PodDisruptionBudget],
  ['hpas', BUILTIN.HorizontalPodAutoscaler],
  ['nodes', BUILTIN.Node],
  // Security: Pod Security labels and RBAC objects.
  ['namespaces', BUILTIN.Namespace],
  ['roles', BUILTIN.Role],
  ['clusterRoles', BUILTIN.ClusterRole],
  ['roleBindings', BUILTIN.RoleBinding],
  ['clusterRoleBindings', BUILTIN.ClusterRoleBinding],
];

const THROTTLE_MS = 3_000;
/** Scan with whatever loaded when a list never syncs (slow or huge cluster). */
const SYNC_TIMEOUT_MS = 10_000;

interface Cached {
  signature: string;
  scan: HealthScan;
}
const scans = new Map<string, Cached>();
const lastRun = new Map<string, number>();
const inflight = new Set<string>();

export interface ListIssue {
  kind: HealthKind;
  title: string;
  forbidden: boolean;
  error: string;
}

export interface HealthScanState {
  scan: HealthScan | null;
  summary: HealthSummary | null;
  /** Lists synced so far (initial load progress). */
  progress: { loaded: number; total: number };
  issues: ListIssue[];
  scanning: boolean;
  rescan: () => void;
}

function scanKey(clusterId: string, namespaces: readonly string[]) {
  return `${clusterId}|${[...namespaces].sort().join(',')}`;
}

function indexByUid(findings: readonly Finding[]): Map<string, Finding[]> {
  const map = new Map<string, Finding[]>();
  for (const f of findings) {
    const list = map.get(f.ref.uid);
    if (list) list.push(f);
    else map.set(f.ref.uid, [f]);
  }
  return map;
}

export function useHealthScan(
  clusterId: string,
  namespaces: string[],
  enabled: boolean,
  apiResources: readonly ApiResourceInfo[] | null,
): HealthScanState {
  const locale = i18n.useLocale();
  const ignores = useHealthIgnores(clusterId);
  const key = scanKey(clusterId, namespaces);

  const gvks = useMemo(() => {
    const out = {} as Record<HealthKind, Gvk | null>;
    for (const [kind, def] of KINDS) out[kind] = isServed(def, apiResources) ? toGvk(def) : null;
    const cert = apiResources?.find(
      (r) => r.group === 'cert-manager.io' && r.kind === 'Certificate',
    );
    out.certificates = cert ? gvkFromApiResource(cert) : null;
    return out;
  }, [apiResources]);

  // One hook per list keeps the hook order stable; unserved kinds watch nothing.
  const snaps: Record<HealthKind, WatchSnapshot> = {
    pods: useWatch(clusterId, gvks.pods, namespaces, enabled),
    deployments: useWatch(clusterId, gvks.deployments, namespaces, enabled),
    statefulSets: useWatch(clusterId, gvks.statefulSets, namespaces, enabled),
    daemonSets: useWatch(clusterId, gvks.daemonSets, namespaces, enabled),
    jobs: useWatch(clusterId, gvks.jobs, namespaces, enabled),
    cronJobs: useWatch(clusterId, gvks.cronJobs, namespaces, enabled),
    services: useWatch(clusterId, gvks.services, namespaces, enabled),
    ingresses: useWatch(clusterId, gvks.ingresses, namespaces, enabled),
    configMaps: useWatch(clusterId, gvks.configMaps, namespaces, enabled),
    secrets: useWatch(clusterId, gvks.secrets, namespaces, enabled),
    serviceAccounts: useWatch(clusterId, gvks.serviceAccounts, namespaces, enabled),
    pvcs: useWatch(clusterId, gvks.pvcs, namespaces, enabled),
    pdbs: useWatch(clusterId, gvks.pdbs, namespaces, enabled),
    hpas: useWatch(clusterId, gvks.hpas, namespaces, enabled),
    nodes: useWatch(clusterId, gvks.nodes, namespaces, enabled),
    certificates: useWatch(clusterId, gvks.certificates, namespaces, enabled),
    namespaces: useWatch(clusterId, gvks.namespaces, namespaces, enabled),
    roles: useWatch(clusterId, gvks.roles, namespaces, enabled),
    clusterRoles: useWatch(clusterId, gvks.clusterRoles, namespaces, enabled),
    roleBindings: useWatch(clusterId, gvks.roleBindings, namespaces, enabled),
    clusterRoleBindings: useWatch(clusterId, gvks.clusterRoleBindings, namespaces, enabled),
  };
  // Cost insight: right-sizing findings (efficiency) when a report is available.
  const rightsizing = useRightsizing(
    clusterId,
    namespaces,
    null,
    useCostPrefs((s) => s.settings),
    useCostPrefs((s) => s.strategy),
    enabled,
  ).data;
  const kinds = Object.keys(snaps) as HealthKind[];
  const watched = kinds.filter((k) => gvks[k]);
  const settled = watched.filter((k) => snaps[k].synced || snaps[k].status === 'error');

  const [startedAt, setStartedAt] = useState(() => Date.now());
  // The sync timeout counts from when the view became visible with this scope.
  useEffect(() => {
    if (enabled) setStartedAt(Date.now());
  }, [key, enabled]);
  const clock = useNow(enabled && settled.length < watched.length ? 2_000 : 60_000, enabled);
  const ready =
    !!apiResources && (settled.length === watched.length || clock - startedAt > SYNC_TIMEOUT_MS);

  const [nonce, setNonce] = useState(0);
  const signature = [
    locale,
    nonce,
    Math.floor(clock / 60_000),
    rightsizing?.computed_at ?? 0,
    ...kinds.map((k) => `${gvks[k] ? 1 : 0}:${snaps[k].version}:${snaps[k].synced ? 1 : 0}`),
  ].join('|');

  const snapsRef = useRef(snaps);
  snapsRef.current = snaps;
  const rightsizingRef = useRef(rightsizing);
  rightsizingRef.current = rightsizing;
  const [result, setResult] = useState<Cached | null>(() => scans.get(key) ?? null);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    setResult(scans.get(key) ?? null);
  }, [key]);

  // Scans are not cancelled by newer data (a busy cluster would starve them);
  // only leaving the view or changing its scope stops the one in flight.
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const c = new AbortController();
    controller.current = c;
    return () => {
      c.abort();
      setScanning(false);
    };
  }, [key, enabled]);

  useEffect(() => {
    if (!enabled || !ready) return;
    const hit = scans.get(key);
    if (hit?.signature === signature) {
      setResult(hit);
      return;
    }
    const signal = controller.current?.signal;
    let timer = 0;
    const attempt = () => {
      if (signal?.aborted) return;
      // One scan per scope at a time; retry shortly while another one runs.
      if (inflight.has(key)) {
        timer = window.setTimeout(attempt, 400);
        return;
      }
      inflight.add(key);
      lastRun.set(key, Date.now());
      const current = snapsRef.current;
      const loaded = new Set<HealthKind>();
      const lists = {} as Record<HealthKind, WatchSnapshot['items']>;
      for (const k of kinds) {
        const s = current[k];
        if (!gvks[k] || (s.synced && s.status !== 'error')) loaded.add(k);
        lists[k] = gvks[k] && s.status !== 'error' ? s.items : [];
      }
      const input: HealthInput = {
        ...lists,
        loaded,
        now: Date.now(),
        rightsizing: rightsizingRef.current ?? null,
      };
      setScanning(true);
      scanHealthAsync(input, signal)
        .then((scan) => {
          const cached = { signature, scan };
          scans.set(key, cached);
          if (signal?.aborted) return;
          setResult(cached);
          useHealthStore.getState().publishScan(clusterId, {
            namespaces: [...namespaces],
            byUid: indexByUid(scan.findings),
            computedAt: scan.computedAt,
          });
        })
        .catch((error: unknown) => {
          if (!(error instanceof DOMException && error.name === 'AbortError'))
            console.error('health scan failed', error);
        })
        .finally(() => {
          inflight.delete(key);
          if (!signal?.aborted) setScanning(false);
        });
    };
    timer = window.setTimeout(
      attempt,
      Math.max(0, (lastRun.get(key) ?? 0) + THROTTLE_MS - Date.now()),
    );
    return () => window.clearTimeout(timer);
    // `signature` captures the lists, locale and clock by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, ready, enabled, key]);

  const summary = useMemo(
    () => (result ? summarize(result.scan, ignores) : null),
    // Titles in groups are resolved at render time; the summary only needs the locale via the scan.
    [result, ignores],
  );

  const issues: ListIssue[] = watched
    .filter((k) => snaps[k].status === 'error')
    .map((k) => ({
      kind: k,
      title: gvks[k]!.kind,
      forbidden: snaps[k].forbidden,
      error: snaps[k].error ?? '',
    }));

  return {
    scan: result?.scan ?? null,
    summary,
    progress: { loaded: settled.length, total: watched.length },
    issues,
    scanning,
    rescan: () => {
      for (const k of watched) restartWatch(clusterId, gvks[k]!, namespaces);
      lastRun.delete(key);
      setNonce((n) => n + 1);
    },
  };
}
