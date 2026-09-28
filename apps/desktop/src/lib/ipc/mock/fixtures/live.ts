import type { KubeObject } from '@/types';
import { allDbs, drop, find, hasWatchers, list, put, type ClusterDb } from './db';
import { touchEvent } from './events';
import { runJob } from './lifecycle';
import { churnSuffix, scaleParams, scalePresetOf, type ScalePresetName } from './scale';
import { nowIso } from './util';

/**
 * Background "liveness" for the demo clusters: the crash-looping pod keeps
 * restarting, a per-minute CronJob spawns pods, node leases renew. Only
 * clusters with open watches tick, so idle previews stay quiet.
 */

let tick = 0;
let timer: number | null = null;

function crashLoop(db: ClusterDb) {
  const pod = find(db, 'pods', 'checkout', 'payment-api-7c9d8b6f5-x2kqp');
  if (!pod || pod.metadata.deletionTimestamp) return;
  const statuses = pod.status?.containerStatuses as Array<Record<string, unknown>> | undefined;
  const main = statuses?.[0];
  if (!main) return;
  const state = main.state as Record<string, unknown>;
  if ('waiting' in state && tick % 5 === 0) {
    main.restartCount = Number(main.restartCount ?? 0) + 1;
    main.state = { running: { startedAt: nowIso() } };
    main.ready = false;
    put(db, pod);
    touchEvent(db, pod, 'Pulled');
  } else if ('running' in state) {
    main.lastState = {
      terminated: {
        reason: 'Error',
        exitCode: 1,
        startedAt: (state.running as { startedAt: string }).startedAt,
        finishedAt: nowIso(),
      },
    };
    main.state = {
      waiting: {
        reason: 'CrashLoopBackOff',
        message: `back-off 5m0s restarting failed container=payment-api pod=${pod.metadata.name}`,
      },
    };
    put(db, pod);
    touchEvent(db, pod, 'BackOff');
  }
}

function cron(db: ClusterDb) {
  if (tick % 15 !== 0) return;
  const cj = find(db, 'cronjobs.batch', 'data', 'metrics-rollup');
  if (!cj || cj.spec?.suspend) return;
  runJob(db, cj, `metrics-rollup-${Math.floor(Date.now() / 60_000)}`);
}

function leases(db: ClusterDb) {
  const all = list(db, 'leases.coordination.k8s.io');
  const lease = all[tick % Math.max(1, all.length)];
  if (!lease) return;
  lease.spec = { ...lease.spec, renewTime: nowIso() };
  put(db, lease);
}

function step() {
  tick++;
  for (const db of allDbs()) {
    if (!hasWatchers(db.id)) continue;
    if (db.profile.troubled) crashLoop(db);
    cron(db);
    leases(db);
  }
}

// `&churn=<n>` (scaled demo clusters only): n pod changes per second, applied
// every 100 ms round-robin over the pods. Nine in ten update a pod's status
// or labels; every tenth deletes a pod and recreates it under a new name, as
// its ReplicaSet would.
const CHURN_TICK_MS = 100;
let churnTimer: number | null = null;
let churnDue = 0;
let churnSeq = 0;
const churnCursor = new Map<string, number>();

function churnPod(db: ClusterDb, preset: ScalePresetName, pod: KubeObject) {
  churnSeq++;
  if (churnSeq % 10 === 0) {
    drop(db, pod);
    const owner = pod.metadata.ownerReferences?.[0]?.name ?? pod.metadata.name;
    const next = structuredClone(pod);
    next.metadata = {
      ...next.metadata,
      name: `${owner}-${churnSuffix(preset, churnSeq)}`,
      uid: '',
      creationTimestamp: nowIso(),
    };
    next.status = { ...next.status, startTime: nowIso() };
    put(db, next);
  } else if (churnSeq % 2 === 0) {
    const conditions = (pod.status?.conditions as Array<Record<string, unknown>>) ?? [];
    pod.status = {
      ...pod.status,
      conditions: conditions.map((c) =>
        c.type === 'Ready' ? { ...c, lastProbeTime: nowIso() } : c,
      ),
    };
    put(db, pod);
  } else {
    pod.metadata.labels = { ...pod.metadata.labels, 'perf.kubepit.dev/churn': String(churnSeq) };
    put(db, pod);
  }
}

function churnStep(perTick: number) {
  churnDue += perTick;
  const count = Math.floor(churnDue);
  if (!count) return;
  churnDue -= count;
  for (const db of allDbs()) {
    const preset = scalePresetOf(db.id);
    if (!preset || !hasWatchers(db.id)) continue;
    const pods = list(db, 'pods');
    if (!pods.length) continue;
    let cursor = churnCursor.get(db.id) ?? 0;
    for (let i = 0; i < count; i++) churnPod(db, preset, pods[cursor++ % pods.length]!);
    churnCursor.set(db.id, cursor % pods.length);
  }
}

export function ensureLiveness() {
  if (timer === null) timer = window.setInterval(step, 4000);
  const { churn } = scaleParams(location.search);
  if (churn > 0 && churnTimer === null)
    churnTimer = window.setInterval(() => churnStep(churn / 10), CHURN_TICK_MS);
}
