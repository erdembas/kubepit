import type { KubeObject } from '@/types';
import {
  asArray,
  asNumber,
  asObject,
  asString,
  condition,
  isObject,
  spec,
  status,
  type JsonObject,
} from './accessors';

/**
 * Pod helpers: kubectl-compatible STATUS column, container states and
 * the small health signals the tables show.
 */

export type ContainerStateKind = 'running' | 'waiting' | 'terminated' | 'unknown';

export interface ContainerInfo {
  name: string;
  init: boolean;
  image: string;
  spec: JsonObject;
  state: ContainerStateKind;
  reason: string | null;
  message: string | null;
  exitCode: number | null;
  ready: boolean;
  started: boolean;
  restarts: number;
  startedAt: string | null;
  lastTermination: { reason: string; exitCode: number | null; finishedAt: string | null } | null;
}

function containerStatusMap(obj: KubeObject, key: string) {
  const map = new Map<string, JsonObject>();
  for (const s of asArray(status(obj)[key])) if (isObject(s)) map.set(asString(s.name), s);
  return map;
}

function toInfo(c: JsonObject, s: JsonObject | undefined, init: boolean): ContainerInfo {
  const state = asObject(s?.state);
  const last = asObject(asObject(s?.lastState).terminated);
  let kind: ContainerStateKind = 'unknown';
  let detail: JsonObject = {};
  if (isObject(state.running)) {
    kind = 'running';
    detail = state.running;
  } else if (isObject(state.waiting)) {
    kind = 'waiting';
    detail = state.waiting;
  } else if (isObject(state.terminated)) {
    kind = 'terminated';
    detail = state.terminated;
  }
  return {
    name: asString(c.name),
    init,
    image: asString(c.image),
    spec: c,
    state: kind,
    reason: asString(detail.reason) || null,
    message: asString(detail.message) || null,
    exitCode: kind === 'terminated' ? asNumber(detail.exitCode, 0) : null,
    ready: s?.ready === true,
    started: s?.started === true,
    restarts: asNumber(s?.restartCount, 0),
    startedAt: asString(detail.startedAt) || null,
    lastTermination: Object.keys(last).length
      ? {
          reason: asString(last.reason) || 'Terminated',
          exitCode: last.exitCode === undefined ? null : asNumber(last.exitCode),
          finishedAt: asString(last.finishedAt) || null,
        }
      : null,
  };
}

export function podContainers(obj: KubeObject): ContainerInfo[] {
  const initStatus = containerStatusMap(obj, 'initContainerStatuses');
  const mainStatus = containerStatusMap(obj, 'containerStatuses');
  const s = spec(obj);
  const init = asArray(s.initContainers)
    .filter(isObject)
    .map((c) => toInfo(c, initStatus.get(asString(c.name)), true));
  const main = asArray(s.containers)
    .filter(isObject)
    .map((c) => toInfo(c, mainStatus.get(asString(c.name)), false));
  return [...init, ...main];
}

export function containerNames(obj: KubeObject, includeInit = true): string[] {
  const s = spec(obj);
  const names = asArray(s.containers)
    .filter(isObject)
    .map((c) => asString(c.name));
  if (!includeInit) return names;
  return [
    ...names,
    ...asArray(s.initContainers)
      .filter(isObject)
      .map((c) => asString(c.name)),
  ];
}

export function podRestarts(obj: KubeObject): number {
  let total = 0;
  for (const s of asArray(status(obj).containerStatuses))
    if (isObject(s)) total += asNumber(s.restartCount, 0);
  return total;
}

/** Same algorithm as `kubectl get pods` STATUS (printers.printPod). */
export function podStatus(obj: KubeObject): string {
  const st = status(obj);
  let reason = asString(st.reason) || asString(st.phase) || 'Unknown';
  let initializing = false;
  const initStatuses = asArray(st.initContainerStatuses).filter(isObject);
  const initCount = asArray(spec(obj).initContainers).length;
  for (let i = 0; i < initStatuses.length; i++) {
    const cs = initStatuses[i]!;
    const state = asObject(cs.state);
    const term = asObject(state.terminated);
    const wait = asObject(state.waiting);
    if (isObject(state.terminated) && asNumber(term.exitCode, 0) === 0) continue;
    if (isObject(state.terminated)) {
      const r = asString(term.reason);
      const signal = asNumber(term.signal, 0);
      reason = r
        ? `Init:${r}`
        : signal
          ? `Init:Signal:${signal}`
          : `Init:ExitCode:${asNumber(term.exitCode, 0)}`;
    } else if (
      isObject(state.waiting) &&
      asString(wait.reason) &&
      asString(wait.reason) !== 'PodInitializing'
    ) {
      reason = `Init:${asString(wait.reason)}`;
    } else {
      reason = `Init:${i}/${initCount}`;
    }
    initializing = true;
    break;
  }
  if (!initializing) {
    let hasRunning = false;
    const statuses = asArray(st.containerStatuses).filter(isObject);
    for (let i = statuses.length - 1; i >= 0; i--) {
      const cs = statuses[i]!;
      const state = asObject(cs.state);
      const wait = asObject(state.waiting);
      const term = asObject(state.terminated);
      if (asString(wait.reason)) reason = asString(wait.reason);
      else if (asString(term.reason)) reason = asString(term.reason);
      else if (isObject(state.terminated)) {
        const signal = asNumber(term.signal, 0);
        reason = signal ? `Signal:${signal}` : `ExitCode:${asNumber(term.exitCode, 0)}`;
      } else if (cs.ready === true && isObject(state.running)) hasRunning = true;
    }
    if (reason === 'Completed' && hasRunning) {
      reason = condition(obj, 'Ready')?.status === 'True' ? 'Running' : 'NotReady';
    }
  }
  if (obj.metadata.deletionTimestamp) {
    reason = asString(st.reason) === 'NodeLost' ? 'Unknown' : 'Terminating';
  }
  return reason;
}

export type StatusTone = 'success' | 'warning' | 'error' | 'info' | 'muted';

const ERROR_REASONS =
  /CrashLoopBackOff|Error|Failed|BackOff|ErrImage|OOMKilled|Evicted|CreateContainer|InvalidImageName|ContainerCannotRun|DeadlineExceeded|Signal|ExitCode/;

export function podStatusTone(value: string): StatusTone {
  if (value === 'Running') return 'success';
  if (value === 'Completed' || value === 'Succeeded') return 'muted';
  if (value === 'Terminating') return 'info';
  if (value === 'Unknown') return 'muted';
  if (ERROR_REASONS.test(value)) return 'error';
  return 'warning';
}

/** Buckets for overview charts. */
export type PodPhaseBucket = 'running' | 'pending' | 'failed' | 'succeeded' | 'terminating';

export function podBucket(obj: KubeObject): PodPhaseBucket {
  const value = podStatus(obj);
  if (value === 'Terminating') return 'terminating';
  if (value === 'Completed' || value === 'Succeeded') return 'succeeded';
  const tone = podStatusTone(value);
  if (tone === 'error') return 'failed';
  if (value === 'Running') return 'running';
  return 'pending';
}

export function podIsReady(obj: KubeObject): boolean {
  return condition(obj, 'Ready')?.status === 'True';
}

/** Human-readable problems for the warning icon column. */
export function podIssues(obj: KubeObject): string[] {
  const out: string[] = [];
  const phase = asString(status(obj).phase);
  const scheduled = condition(obj, 'PodScheduled');
  if (scheduled?.status === 'False' && scheduled.message) out.push(scheduled.message);
  for (const c of podContainers(obj)) {
    if (
      c.state === 'waiting' &&
      c.reason &&
      !['ContainerCreating', 'PodInitializing'].includes(c.reason)
    )
      out.push(`${c.name}: ${c.reason}${c.message ? ` — ${c.message}` : ''}`);
    else if (c.state === 'terminated' && c.exitCode && !c.init)
      out.push(`${c.name}: ${c.reason ?? 'Terminated'} (exit ${c.exitCode})`);
    else if (c.state === 'running' && !c.ready && !c.init && phase === 'Running')
      out.push(`${c.name}: not ready`);
  }
  return out;
}

export function podQos(obj: KubeObject): string {
  return asString(status(obj).qosClass) || '—';
}

export function podNode(obj: KubeObject): string {
  return asString(spec(obj).nodeName);
}

export function containerTone(c: ContainerInfo): string {
  if (c.state === 'running')
    return c.ready ? 'bg-status-running' : 'bg-status-running/40 ring-1 ring-status-running/70';
  if (c.state === 'waiting')
    return c.reason && ERROR_REASONS.test(c.reason) ? 'bg-status-error' : 'bg-status-starting';
  if (c.state === 'terminated') return c.exitCode ? 'bg-status-error' : 'bg-fg-dim/60';
  return 'bg-fg-dim/30';
}
