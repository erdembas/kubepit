import * as i18n from '@/i18n/core';
import type { KubeObject } from '@/types';
import { asArray, asNumber, asObject, asString, isObject, spec, status } from '../accessors';
import { matchesSelector, parseSelector } from '../selectors';
import { groupByNamespace, makeFinding, nsKey, podSpecOf, type Emit } from './context';
import type { HealthInput } from './types';

/** PodDisruptionBudgets and HorizontalPodAutoscalers. */

export function pdbFindings(pdb: KubeObject, emit: Emit) {
  const st = status(pdb);
  if (st.disruptionsAllowed === undefined) return;
  const expected = asNumber(st.expectedPods);
  if (expected > 0 && asNumber(st.disruptionsAllowed) === 0)
    emit(
      makeFinding(
        'pdb-blocks-drain',
        pdb,
        i18n.plural(
          'Allows no disruption of its {count} pod; node drains will block',
          'Allows no disruption of its {count} pods; node drains will block',
          expected,
        ),
      ),
    );
}

export function pdbCoverageFindings(input: HealthInput, emit: Emit) {
  const byNs = groupByNamespace(input.pods);
  for (const pdb of input.pdbs) {
    const selector = parseSelector(spec(pdb).selector);
    const pods = byNs.get(pdb.metadata.namespace ?? '') ?? [];
    if (selector && pods.some((p) => matchesSelector(selector, p.metadata.labels))) continue;
    emit(makeFinding('pdb-no-pods', pdb, i18n.t('Selector matches no pods')));
  }
}

function usesCpuUtilization(hpa: KubeObject): boolean {
  const s = spec(hpa);
  if (s.targetCPUUtilizationPercentage !== undefined) return true;
  return asArray(s.metrics)
    .filter(isObject)
    .some((m) => {
      const res = asObject(m.resource ?? m.containerResource);
      return asString(res.name) === 'cpu' && asString(asObject(res.target).type) !== 'AverageValue';
    });
}

export function hpaFindings(input: HealthInput, emit: Emit) {
  const targets = new Map<string, KubeObject>();
  for (const w of [...input.deployments, ...input.statefulSets])
    targets.set(`${w.kind}/${nsKey(w.metadata.namespace, w.metadata.name)}`, w);
  for (const hpa of input.hpas) {
    const ref = asObject(spec(hpa).scaleTargetRef);
    const kind = asString(ref.kind);
    const name = asString(ref.name);
    if (kind !== 'Deployment' && kind !== 'StatefulSet') continue;
    const target = targets.get(`${kind}/${nsKey(hpa.metadata.namespace, name)}`);
    if (!target) {
      emit(
        makeFinding(
          'hpa-missing-target',
          hpa,
          i18n.t('Target {kind} {name} does not exist', { kind, name }),
        ),
      );
      continue;
    }
    if (!usesCpuUtilization(hpa)) continue;
    const missing = asArray(podSpecOf(target)?.containers)
      .filter(isObject)
      .filter((c) => {
        const res = asObject(c.resources);
        return !asObject(res.requests).cpu && !asObject(res.limits).cpu;
      })
      .map((c) => asString(c.name));
    if (missing.length)
      emit(
        makeFinding(
          'hpa-no-cpu-requests',
          hpa,
          i18n.t('Scales on CPU but {target} has containers without CPU requests: {containers}', {
            target: `${kind}/${name}`,
            containers: missing.join(', '),
          }),
        ),
      );
  }
}
