import { describe, expect, it } from 'vitest';
import { uncertainReasons, watchErrors, type UncertainInput } from './uncertain';

const flags = { hostNetwork: false, ipBlockOnPod: false };
const base: UncertainInput = {
  cni: { enforcement: 'enforced' },
  unevaluated: [],
  policiesIncomplete: false,
};
const forbiddenB =
  'networkpolicies.networking.k8s.io is forbidden: User "dev" cannot list resource "networkpolicies" in the namespace "b"';

describe('netpol verdict caveats', () => {
  it('a complete policy list gives a certain verdict', () => {
    expect(uncertainReasons(base, ['a'], flags)).toEqual([]);
  });

  it('an incomplete NetworkPolicy list makes every verdict not certain', () => {
    expect(uncertainReasons({ ...base, policiesIncomplete: true }, ['a'], flags)).toEqual([
      'policies-incomplete',
    ]);
  });

  it('a partially readable list is reported like a failed one', () => {
    const ready = { synced: true, status: 'ready' as const, error: null, forbidden: false };
    expect(
      watchErrors([
        ['Pod', ready],
        ['NetworkPolicy', { ...ready, error: forbiddenB, forbidden: true }],
        [
          'Service',
          { synced: false, status: 'error', error: 'services is forbidden', forbidden: true },
        ],
      ]),
    ).toEqual([
      { kind: 'NetworkPolicy', forbidden: true, message: forbiddenB },
      { kind: 'Service', forbidden: true, message: 'services is forbidden' },
    ]);
  });
});
