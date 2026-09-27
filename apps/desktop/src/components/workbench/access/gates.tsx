import * as i18n from '@/i18n';
import { useMemo } from 'react';
import { Lock, type LucideIcon } from 'lucide-react';
import {
  checkKey,
  evaluateNeed,
  needChecks,
  resourceRef,
  type AccessNeed,
  type AccessState,
} from '@/lib/kube/access';
import { cn } from '@/lib/cn';
import { useAccess, type AccessAnswer } from '@/store/useAccessStore';
import type { AccessCheck } from '@/types';

/**
 * Why an action is unavailable. Read-only clusters keep their existing
 * reason (and skip permission lookups for mutating actions); missing RBAC
 * permission is the additional reason. Unknown answers never block.
 */
export interface ActionGate {
  blocked: boolean;
  reason: 'read-only' | 'permission' | null;
  /** Tooltip for a blocked action. */
  message: string | null;
}

export interface GateableAction {
  id: string;
  mutating: boolean;
  access?: AccessNeed;
}

export const OPEN_GATE: ActionGate = { blocked: false, reason: null, message: null };

/** "You don't have permission to {verb} {resource} in {namespace}" for a denied check. */
export function deniedMessage(check: AccessCheck): string {
  const values = { verb: check.verb, resource: resourceRef(check) };
  return check.namespace
    ? i18n.t("You don't have permission to {verb} {resource} in {namespace}", {
        ...values,
        namespace: check.namespace,
      })
    : i18n.t("You don't have permission to {verb} {resource} cluster-wide", values);
}

/**
 * Gate state per check. A nameless check that only name-restricted rules
 * cover stays unknown: the action may still work on the object it targets.
 */
export function gateState(answer: AccessAnswer | undefined, check: AccessCheck): AccessState {
  if (!answer) return 'unknown';
  if (answer.restricted && !check.name) return 'unknown';
  return answer.state;
}

/** Gates for a list of actions (one batched lookup for all of them). */
export function useActionGates(
  clusterId: string,
  actions: readonly GateableAction[],
  readOnly: boolean,
): ReadonlyMap<string, ActionGate> {
  const locale = i18n.useLocale();
  const checks = useMemo(() => {
    const seen = new Map<string, AccessCheck>();
    for (const a of actions) {
      if (!a.access || (a.mutating && readOnly)) continue;
      for (const c of needChecks(a.access)) seen.set(checkKey(c), c);
    }
    return [...seen.values()];
  }, [actions, readOnly]);
  const answers = useAccess(clusterId, checks);
  return useMemo(() => {
    const byKey = new Map(checks.map((c, i) => [checkKey(c), answers[i]]));
    const gates = new Map<string, ActionGate>();
    for (const a of actions) {
      if (a.mutating && readOnly) {
        gates.set(a.id, {
          blocked: true,
          reason: 'read-only',
          message: i18n.t('Read-only cluster: changes are blocked'),
        });
        continue;
      }
      if (!a.access) continue;
      const { state, blocking } = evaluateNeed(a.access, (c) =>
        gateState(byKey.get(checkKey(c)), c),
      );
      if (state === 'denied' && blocking)
        gates.set(a.id, { blocked: true, reason: 'permission', message: deniedMessage(blocking) });
    }
    return gates;
    // `locale` re-renders messages after a language switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions, readOnly, checks, answers, locale]);
}

/** Gate for a single action. */
export function useActionGate(
  clusterId: string,
  action: GateableAction | null,
  readOnly: boolean,
): ActionGate {
  const list = useMemo(() => (action ? [action] : []), [action]);
  return useActionGates(clusterId, list, readOnly).get(action?.id ?? '') ?? OPEN_GATE;
}

/** An action icon with a small lock badge (permission-blocked actions). */
export function LockedIcon({
  icon: Icon,
  className,
  badgeClassName = 'bg-surface',
}: {
  icon: LucideIcon;
  className?: string;
  /** Background behind the badge; match the surface the icon sits on. */
  badgeClassName?: string;
}) {
  return (
    <span className="relative inline-flex shrink-0">
      <Icon className={cn('h-3.5 w-3.5', className)} />
      <span
        className={cn(
          'absolute -right-1 -bottom-1 flex h-2.5 w-2.5 items-center justify-center rounded-full',
          badgeClassName,
        )}
        aria-hidden
      >
        <Lock className="h-2 w-2" strokeWidth={2.75} />
      </span>
    </span>
  );
}
