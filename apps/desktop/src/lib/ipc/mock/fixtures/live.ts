import { allDbs, find, hasWatchers, list, put, type ClusterDb } from './db';
import { touchEvent } from './events';
import { runJob } from './lifecycle';
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

export function ensureLiveness() {
  if (timer !== null) return;
  timer = window.setInterval(step, 4000);
}
