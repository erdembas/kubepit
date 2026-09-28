import * as i18n from '@/i18n/core';
import { formatMoney } from '@/lib/cost';
import type { KubeObject } from '@/types';
import { cpuText, healthVerdict, memoryText, reportDays } from '../rightsizing/model';
import { makeFinding, nsKey, type Emit } from './context';
import type { HealthInput } from './types';

/**
 * Efficiency findings from the right-sizing report (when one was loaded):
 * only large, confident deltas (`healthVerdict`), one finding per workload,
 * so the report never floods the Health view.
 */
export function rightsizingFindings(input: HealthInput, emit: Emit) {
  const report = input.rightsizing;
  if (!report) return;
  const byKey = new Map<string, KubeObject>();
  const add = (kind: string, list: readonly KubeObject[]) => {
    for (const o of list) byKey.set(`${kind}|${nsKey(o.metadata.namespace, o.metadata.name)}`, o);
  };
  add('Deployment', input.deployments);
  add('StatefulSet', input.statefulSets);
  add('DaemonSet', input.daemonSets);
  const days = reportDays(report);
  for (const rec of report.workloads) {
    const verdict = healthVerdict(rec);
    if (!verdict) continue;
    const obj = byKey.get(`${rec.kind}|${nsKey(rec.namespace, rec.name)}`);
    if (!obj) continue;
    if (verdict === 'over') {
      const percent = i18n.number(-rec.monthly_delta / rec.monthly_current, {
        style: 'percent',
        maximumFractionDigits: 0,
      });
      emit(
        makeFinding(
          'workload-overprovisioned',
          obj,
          i18n.plural(
            'Requests could shrink by {percent} based on {count} day of usage, saving about {amount} a month.',
            'Requests could shrink by {percent} based on {count} days of usage, saving about {amount} a month.',
            days,
            {
              percent,
              amount: formatMoney(-rec.monthly_delta, report.currency),
            },
          ),
        ),
      );
      continue;
    }
    const hot =
      rec.containers.find((c) => c.usage && c.memory !== 'unchanged') ??
      rec.containers.find((c) => c.usage && c.cpu !== 'unchanged');
    if (!hot?.usage) continue;
    const memory = hot.memory !== 'unchanged';
    emit(
      makeFinding(
        'workload-underprovisioned',
        obj,
        memory
          ? i18n.t(
              'Container {container} peaks at {usage} of memory with a {request} request; recommended {recommended}.',
              {
                container: hot.name,
                usage: memoryText(hot.usage.memory_max),
                request: memoryText(hot.current.memory_request),
                recommended: memoryText(hot.recommended.memory_request),
              },
            )
          : i18n.t(
              'Container {container} uses {usage} CPU (p95) with a {request} request; recommended {recommended}.',
              {
                container: hot.name,
                usage: cpuText(hot.usage.cpu_p95),
                request: cpuText(hot.current.cpu_request),
                recommended: cpuText(hot.recommended.cpu_request),
              },
            ),
        hot.name,
      ),
    );
  }
}
