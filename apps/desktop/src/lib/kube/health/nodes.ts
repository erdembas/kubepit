import * as i18n from '@/i18n/core';
import type { KubeObject } from '@/types';
import { conditions, spec } from '../accessors';
import { makeFinding, type Emit } from './context';

/** Node conditions and scheduling state. */

const PRESSURE = new Set(['MemoryPressure', 'DiskPressure', 'PIDPressure', 'NetworkUnavailable']);

export function nodeFindings(node: KubeObject, emit: Emit) {
  const conds = conditions(node);
  const ready = conds.find((c) => c.type === 'Ready');
  if (ready && ready.status !== 'True')
    emit(
      makeFinding(
        'node-not-ready',
        node,
        ready.reason
          ? i18n.t('Node is not ready ({reason})', { reason: ready.reason })
          : i18n.t('Node is not ready'),
      ),
    );
  const pressure = conds.filter((c) => PRESSURE.has(c.type) && c.status === 'True');
  if (pressure.length)
    emit(
      makeFinding(
        'node-pressure',
        node,
        i18n.t('Node reports {conditions}', {
          conditions: pressure.map((c) => c.type).join(', '),
        }),
      ),
    );
  if (spec(node).unschedulable === true)
    emit(makeFinding('node-unschedulable', node, i18n.t('Node is cordoned (unschedulable)')));
}
