import * as i18n from '@/i18n/core';
import { formatAge } from '@/lib/format';
import type { KubeObject } from '@/types';
import { asString, condition, createdAt, status } from '../accessors';
import { podContainers } from '../pods';
import { makeFinding, type Emit } from './context';

/** Runtime state of pods: crash loops, image pulls, restarts and long pending phases. */

export const RESTART_THRESHOLD = 5;
export const PENDING_THRESHOLD_MS = 5 * 60_000;

const PULL_REASONS = new Set([
  'ImagePullBackOff',
  'ErrImagePull',
  'InvalidImageName',
  'ErrImageNeverPull',
]);

export function podStatusFindings(pod: KubeObject, now: number, emit: Emit) {
  if (pod.metadata.deletionTimestamp) return;
  const phase = asString(status(pod).phase);
  if (phase === 'Succeeded' || phase === 'Failed') return;
  let broken = false;
  for (const c of podContainers(pod)) {
    if (c.state === 'waiting' && c.reason === 'CrashLoopBackOff') {
      broken = true;
      emit(
        makeFinding(
          'pod-crashloop',
          pod,
          i18n.t('Container {container} is crash looping (CrashLoopBackOff)', {
            container: c.name,
          }),
          c.name,
        ),
      );
      continue;
    }
    if (c.state === 'waiting' && c.reason && PULL_REASONS.has(c.reason)) {
      broken = true;
      emit(
        makeFinding(
          'pod-image-pull',
          pod,
          i18n.t('Container {container} cannot pull {image} ({reason})', {
            container: c.name,
            image: c.image,
            reason: c.reason,
          }),
          c.name,
        ),
      );
      continue;
    }
    if (c.restarts >= RESTART_THRESHOLD) {
      const message = i18n.plural(
        'Container {container} restarted {count} time',
        'Container {container} restarted {count} times',
        c.restarts,
        { container: c.name },
      );
      const reason = c.lastTermination?.reason;
      emit(
        makeFinding(
          'pod-restarts',
          pod,
          reason ? `${message} (${reason})` : message,
          c.name,
          c.restarts >= RESTART_THRESHOLD * 10 ? 'critical' : undefined,
        ),
      );
    }
  }
  if (phase === 'Pending' && !broken) {
    const since = createdAt(pod);
    if (since && now - since > PENDING_THRESHOLD_MS) {
      const scheduled = condition(pod, 'PodScheduled');
      const age = formatAge(since, now);
      emit(
        makeFinding(
          'pod-pending',
          pod,
          scheduled?.status === 'False' && (scheduled.message || scheduled.reason)
            ? i18n.t('Pending for {age}: {reason}', {
                age,
                reason: scheduled.message || scheduled.reason || '',
              })
            : i18n.t('Pending for {age}', { age }),
        ),
      );
    }
  }
}
