import { relevantUnevaluated, type CniDetection, type UnevaluatedPolicy } from '@/lib/kube/netpol';
import { hasListError, type ListState } from '../data/listState';

/**
 * Why a simulator verdict is not certain, and which watched lists failed.
 * Pure, so the caveats are testable; the UI words them (`Caveats.tsx`).
 */

export type UncertainReason =
  'not-enforced' | 'unevaluated' | 'policies-incomplete' | 'host-network' | 'ipblock-pod';

export interface UncertainInput {
  cni: Pick<CniDetection, 'enforcement'>;
  unevaluated: readonly UnevaluatedPolicy[];
  /** The NetworkPolicy list failed or only partly loaded: policies may be missing. */
  policiesIncomplete: boolean;
}

export function uncertainReasons(
  data: UncertainInput,
  namespaces: readonly string[],
  flags: { hostNetwork: boolean; ipBlockOnPod: boolean },
): UncertainReason[] {
  const out: UncertainReason[] = [];
  if (data.cni.enforcement === 'not-enforced') out.push('not-enforced');
  if (relevantUnevaluated(data.unevaluated, namespaces).length) out.push('unevaluated');
  if (data.policiesIncomplete) out.push('policies-incomplete');
  if (flags.hostNetwork) out.push('host-network');
  if (flags.ipBlockOnPod) out.push('ipblock-pod');
  return out;
}

export interface NetpolWatchError {
  kind: string;
  forbidden: boolean;
  message: string;
}

/** Lists that failed or loaded with an error on the side (one namespace forbidden). */
export function watchErrors(
  lists: ReadonlyArray<readonly [string, ListState & { forbidden: boolean }]>,
): NetpolWatchError[] {
  const out: NetpolWatchError[] = [];
  for (const [kind, s] of lists)
    if (hasListError(s) && s.error) out.push({ kind, forbidden: s.forbidden, message: s.error });
  return out;
}
