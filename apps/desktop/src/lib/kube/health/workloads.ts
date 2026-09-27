import * as i18n from '@/i18n/core';
import type { KubeObject } from '@/types';
import { asNumber, asObject, asString, condition, createdAt, spec, status } from '../accessors';
import { makeFinding, nsKey, type Emit } from './context';
import type { HealthInput } from './types';

/** Controller-level rules: replica counts and CronJob outcomes. */

/** `Kind/namespace/name` of every HPA scale target. */
function hpaTargets(hpas: readonly KubeObject[]): Set<string> {
  const out = new Set<string>();
  for (const h of hpas) {
    const ref = asObject(spec(h).scaleTargetRef);
    out.add(`${asString(ref.kind)}/${nsKey(h.metadata.namespace, asString(ref.name))}`);
  }
  return out;
}

export function singleReplicaFindings(input: HealthInput, emit: Emit) {
  const scaled = hpaTargets(input.hpas);
  for (const w of [...input.deployments, ...input.statefulSets]) {
    // `spec.replicas` defaults to 1; 0 is a deliberate scale-down.
    if (asNumber(spec(w).replicas, 1) !== 1) continue;
    if (scaled.has(`${w.kind}/${nsKey(w.metadata.namespace, w.metadata.name)}`)) continue;
    emit(makeFinding('workload-single-replica', w, i18n.t('Runs a single replica')));
  }
}

function jobStart(job: KubeObject): number {
  const t = Date.parse(asString(status(job).startTime));
  return Number.isFinite(t) ? t : createdAt(job);
}

export function cronJobFindings(input: HealthInput, emit: Emit) {
  const latest = new Map<string, KubeObject>();
  for (const job of input.jobs) {
    const owner = job.metadata.ownerReferences?.find((r) => r.kind === 'CronJob');
    if (!owner) continue;
    const key = nsKey(job.metadata.namespace, owner.name);
    const current = latest.get(key);
    if (!current || jobStart(job) > jobStart(current)) latest.set(key, job);
  }
  for (const cj of input.cronJobs) {
    const job = latest.get(nsKey(cj.metadata.namespace, cj.metadata.name));
    if (!job) continue;
    const failed = condition(job, 'Failed');
    if (failed?.status !== 'True') continue;
    emit(
      makeFinding(
        'cronjob-last-failed',
        cj,
        failed.reason
          ? i18n.t('The last run {job} failed ({reason})', {
              job: job.metadata.name,
              reason: failed.reason,
            })
          : i18n.t('The last run {job} failed', { job: job.metadata.name }),
      ),
    );
  }
}
