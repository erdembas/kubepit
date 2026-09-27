import * as i18n from '@/i18n';
import { useMemo } from 'react';
import { ipc } from '@/lib/ipc';
import { accessCheck, anyOf, type AccessState } from '@/lib/kube/access';
import type { NavItem } from '@/lib/kube/nav';
import { useAccess } from '@/store/useAccessStore';
import { useAppStore } from '@/store/useAppStore';
import type { AccessCheck } from '@/types';
import { usePolled } from '../data/polled';

/** Identity of the current connection (`kubectl auth whoami`), fetched once per connection. */
export function useWhoAmI(clusterId: string, enabled: boolean) {
  const connectedAt = useAppStore((s) => s.statuses[clusterId]?.connected_at ?? 0);
  return usePolled(
    enabled ? `${clusterId}|access-whoami|${connectedAt}` : null,
    () => ipc.accessWhoami(clusterId),
    null,
    enabled,
  );
}

/** SelfSubjectReview is not served (Kubernetes < 1.27): shown as a soft notice. */
export function isUnsupported(error: string | null | undefined): boolean {
  return !!error && /not supported by this cluster/i.test(error);
}

export interface KindAccess {
  state: AccessState;
  /** Tooltip for a denied kind. */
  message: string | null;
}

/**
 * Whether the user can list each navigator kind in the workbench scope: in
 * at least one selected namespace, or cluster-wide for "all namespaces" and
 * cluster-scoped kinds. Kinds still resolving are `unknown` (never dimmed).
 */
export function useKindAccess(
  clusterId: string,
  items: readonly NavItem[],
  namespaces: readonly string[],
): ReadonlyMap<string, KindAccess> {
  const locale = i18n.useLocale();
  const plan = useMemo(() => {
    const checks: AccessCheck[] = [];
    const ranges: Array<[NavItem, number, number]> = [];
    const seen = new Set<string>();
    for (const item of items) {
      const gvk = item.gvk;
      if (!gvk || seen.has(item.key)) continue;
      seen.add(item.key);
      const start = checks.length;
      if (gvk.namespaced && namespaces.length)
        for (const namespace of namespaces) checks.push(accessCheck('list', gvk, { namespace }));
      else checks.push(accessCheck('list', gvk));
      ranges.push([item, start, checks.length]);
    }
    return { checks, ranges };
  }, [items, namespaces]);
  const answers = useAccess(clusterId, plan.checks);
  return useMemo(() => {
    const out = new Map<string, KindAccess>();
    for (const [item, start, end] of plan.ranges) {
      const mine = answers.slice(start, end);
      const state = anyOf(mine.map((a) => a.state));
      let message: string | null = null;
      if (state === 'denied') {
        const kind = item.label;
        message = mine.every((a) => a.restricted)
          ? i18n.t('You can only access specific {kind} by name', { kind })
          : !item.gvk?.namespaced || !namespaces.length
            ? i18n.t("You can't list {kind} cluster-wide", { kind })
            : namespaces.length === 1
              ? i18n.t("You can't list {kind} in {namespace}", { kind, namespace: namespaces[0]! })
              : i18n.t("You can't list {kind} in any selected namespace", { kind });
      }
      out.set(item.key, { state, message });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, answers, namespaces, locale]);
}
