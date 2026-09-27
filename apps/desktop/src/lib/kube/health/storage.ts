import * as i18n from '@/i18n/core';
import type { KubeObject } from '@/types';
import { asObject, asString, createdAt, status } from '../accessors';
import type { References } from './config';
import { makeFinding, nsKey, type Emit } from './context';
import { PENDING_THRESHOLD_MS } from './pods';
import type { HealthInput } from './types';

/** PersistentVolumeClaims: unbound and unmounted claims. */

export function pvcFindings(pvc: KubeObject, now: number, emit: Emit) {
  const phase = asString(status(pvc).phase) || 'Pending';
  if (phase === 'Bound') return;
  // WaitForFirstConsumer claims stay Pending for a moment; only flag old ones.
  if (phase === 'Pending' && now - createdAt(pvc) < PENDING_THRESHOLD_MS) return;
  emit(
    makeFinding(
      'pvc-unbound',
      pvc,
      i18n.t('Claim is {phase}', { phase }),
      '',
      phase === 'Lost' ? 'critical' : undefined,
    ),
  );
}

export function unusedClaimFindings(input: HealthInput, refs: References, emit: Emit) {
  for (const pvc of input.pvcs) {
    if (asString(asObject(pvc.status).phase) !== 'Bound') continue;
    if (refs.claims.has(nsKey(pvc.metadata.namespace, pvc.metadata.name))) continue;
    emit(makeFinding('pvc-unused', pvc, i18n.t('Not mounted by any pod')));
  }
}
