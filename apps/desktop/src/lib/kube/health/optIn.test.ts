import { describe, expect, it } from 'vitest';
import { isSilenced, objectFindings, ruleDef, scanHealth, summarize } from '@/lib/kube/health';
import { emptyHealthInput } from './testing';

const deployment = (sc: Record<string, unknown>) => ({
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: { name: 'web', namespace: 'shop', uid: 'u1' },
  spec: {
    template: { spec: { containers: [{ name: 'app', image: 'nginx:1', securityContext: sc }] } },
  },
});
const escalation = (obj: ReturnType<typeof deployment>) =>
  objectFindings(obj, 0).filter((f) => f.ruleId.startsWith('container-privilege-escalation'));

describe('privilege escalation rules', () => {
  it('reports an explicit true as a warning under the original id', () => {
    expect(
      escalation(deployment({ allowPrivilegeEscalation: true })).map((f) => [f.ruleId, f.severity]),
    ).toEqual([['container-privilege-escalation', 'warning']]);
  });
  it('reports an unset field under the opt-in id', () => {
    expect(escalation(deployment({})).map((f) => f.ruleId)).toEqual([
      'container-privilege-escalation-unset',
    ]);
    expect(ruleDef('container-privilege-escalation-unset')?.optIn).toBe(true);
    expect(ruleDef('container-privilege-escalation')?.optIn).toBe(false);
  });
  it('silences opt-in findings unless the cluster turned the rule on', () => {
    const [f] = escalation(deployment({}));
    const on = ['container-privilege-escalation-unset'];
    expect(isSilenced(f!, [], [])).toBe(true);
    expect(isSilenced(f!, [], on)).toBe(false);
    expect(
      isSilenced(f!, [{ rule: 'container-privilege-escalation-unset', namespace: null }], on),
    ).toBe(true);
  });
  it('summarize leaves silenced opt-in findings out of the counts', () => {
    const scan = scanHealth(emptyHealthInput({ deployments: [deployment({})] }));
    const count = (s: ReturnType<typeof summarize>) =>
      s.groups.filter((g) => g.ruleId === 'container-privilege-escalation-unset').length;
    expect(count(summarize(scan, []))).toBe(0);
    expect(count(summarize(scan, [], ['container-privilege-escalation-unset']))).toBe(1);
  });
});
