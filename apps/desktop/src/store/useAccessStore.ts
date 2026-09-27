import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { ipc } from '@/lib/ipc';
import {
  allOf,
  checkKey,
  evaluateRules,
  type AccessState,
  type RuleVerdict,
} from '@/lib/kube/access';
import { useAppStore } from '@/store/useAppStore';
import type { AccessCheck, AccessDecision, AccessRules, ClusterId } from '@/types';

/**
 * What the current user may do, per cluster — the cache behind every
 * permission-aware control (locked actions, dimmed navigator kinds, the
 * permission matrix).
 *
 * Answers come from two sources:
 *  - `rules`: one SelfSubjectRulesReview per namespace, evaluated locally
 *    (`lib/kube/access.ts`). Namespaced checks use it whenever it is
 *    complete, so a whole navigator costs one request.
 *  - `review`: SelfSubjectAccessReviews for cluster-scoped and all-namespace
 *    checks, for checks an incomplete rules review does not grant, and
 *    whenever the rules review fails. Checks requested in the same tick are
 *    sent as one `access_review` batch.
 *
 * Entries live for `ACCESS_TTL` and are then re-checked in the background
 * (the old answer stays visible). Everything is dropped when the cluster
 * reconnects (new identity/credentials) and marked stale by
 * `refreshAccess`. Unknown answers and errors never block anything: the API
 * server still enforces, so a missing answer is treated as "allowed".
 *
 * The cache lives outside React; `revision` bumps notify subscribers.
 */

/** How long an answer is trusted before it is re-checked in the background. */
export const ACCESS_TTL = 5 * 60_000;
/** Failed lookups are retried after this long (they never block meanwhile). */
const ERROR_TTL = 30_000;
/** Checks per `access_review` call. */
const REVIEW_CHUNK = 200;

/** `rules` = evaluated from a rules review; `auto` also falls back to reviews. */
export type AccessMode = 'auto' | 'review';

export interface AccessAnswer {
  state: AccessState;
  /** Denied because only specific object names are allowed (rules review). */
  restricted: boolean;
  source: 'rules' | 'review' | null;
  /** Authorizer reason (reviews only). */
  reason: string | null;
  /** No answer yet, or a refresh is in flight. */
  pending: boolean;
}

interface Timed<T> {
  value: T | null;
  error: string | null;
  at: number;
  loading: boolean;
}

interface ClusterCache {
  clusterId: ClusterId;
  /** `connected_at` of the connection the answers belong to; -1 = offline. */
  epoch: number;
  rules: Map<string, Timed<AccessRules>>;
  reviews: Map<string, Timed<AccessDecision>>;
  queue: Map<string, AccessCheck>;
}

interface AccessStoreState {
  revision: number;
  /** Navigator preference: hide kinds the user cannot list (persisted). */
  hideInaccessible: boolean;
  setHideInaccessible: (hide: boolean) => void;
}

export const useAccessStore = create<AccessStoreState>()(
  persist(
    (set) => ({
      revision: 0,
      hideInaccessible: false,
      setHideInaccessible: (hideInaccessible) => set({ hideInaccessible }),
    }),
    {
      name: 'kubepit.access.v1',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ hideInaccessible: s.hideInaccessible }),
    },
  ),
);

const caches = new Map<ClusterId, ClusterCache>();
const UNKNOWN: AccessAnswer = {
  state: 'unknown',
  restricted: false,
  source: null,
  reason: null,
  pending: true,
};
const OFFLINE: AccessAnswer = { ...UNKNOWN, pending: false };

let bumpQueued = false;
function bump() {
  if (bumpQueued) return;
  bumpQueued = true;
  queueMicrotask(() => {
    bumpQueued = false;
    useAccessStore.setState((s) => ({ revision: s.revision + 1 }));
  });
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function epochOf(clusterId: ClusterId): number {
  const status = useAppStore.getState().statuses[clusterId];
  return status?.state === 'connected' ? (status.connected_at ?? 0) : -1;
}

function cacheFor(clusterId: ClusterId): ClusterCache {
  const epoch = epochOf(clusterId);
  let cache = caches.get(clusterId);
  if (!cache || cache.epoch !== epoch) {
    cache = { clusterId, epoch, rules: new Map(), reviews: new Map(), queue: new Map() };
    caches.set(clusterId, cache);
  }
  return cache;
}

// A reconnect (or disconnect) invalidates everything learned on the old connection.
useAppStore.subscribe((state, prev) => {
  if (state.statuses === prev.statuses) return;
  let changed = false;
  for (const [id, cache] of caches)
    if (epochOf(id) !== cache.epoch) {
      caches.delete(id);
      changed = true;
    }
  if (changed) bump();
});

function fresh(entry: Timed<unknown>, now = Date.now()) {
  return entry.at > 0 && now - entry.at < (entry.error ? ERROR_TTL : ACCESS_TTL);
}

function blankEntry<T>(): Timed<T> {
  return { value: null, error: null, at: 0, loading: false };
}

function ensureRules(cache: ClusterCache, namespace: string): Timed<AccessRules> {
  const current = cache.rules.get(namespace);
  if (current && (current.loading || fresh(current))) return current;
  const entry = current ?? blankEntry<AccessRules>();
  entry.loading = true;
  cache.rules.set(namespace, entry);
  ipc
    .accessRules(cache.clusterId, namespace)
    .then((rules) => {
      entry.value = rules;
      entry.error = null;
    })
    .catch((error: unknown) => {
      entry.error = errorText(error);
    })
    .finally(() => {
      entry.at = Date.now();
      entry.loading = false;
      bump();
    });
  return entry;
}

let flushQueued = false;
function scheduleFlush() {
  if (flushQueued) return;
  flushQueued = true;
  // A macrotask: every effect of the current commit has enqueued by then.
  window.setTimeout(() => {
    flushQueued = false;
    for (const cache of caches.values()) flushReviews(cache);
  }, 0);
}

function flushReviews(cache: ClusterCache) {
  if (!cache.queue.size) return;
  const checks = [...cache.queue.values()];
  cache.queue.clear();
  for (let at = 0; at < checks.length; at += REVIEW_CHUNK) {
    const chunk = checks.slice(at, at + REVIEW_CHUNK);
    const entries = chunk.map((c) => cache.reviews.get(checkKey(c)) ?? blankEntry());
    ipc
      .accessReview(cache.clusterId, chunk)
      .then((decisions) =>
        entries.forEach((entry, i) => {
          const decision = decisions[i];
          entry.value = decision ?? null;
          entry.error = decision ? decision.error : 'missing decision';
        }),
      )
      .catch((error: unknown) => {
        const message = errorText(error);
        for (const entry of entries) entry.error = message;
      })
      .finally(() => {
        const now = Date.now();
        for (const entry of entries) {
          entry.at = now;
          entry.loading = false;
        }
        bump();
      });
  }
}

function enqueueReview(cache: ClusterCache, check: AccessCheck) {
  const key = checkKey(check);
  const current = cache.reviews.get(key);
  if (current && (current.loading || fresh(current))) return;
  const entry = current ?? blankEntry<AccessDecision>();
  entry.loading = true;
  cache.reviews.set(key, entry);
  cache.queue.set(key, check);
  scheduleFlush();
}

/** Start whatever lookups `checks` still need. Safe outside render only. */
function ensure(clusterId: ClusterId, checks: readonly AccessCheck[], mode: AccessMode) {
  const cache = cacheFor(clusterId);
  if (cache.epoch < 0) return;
  for (const check of checks) {
    if (mode === 'auto' && check.namespace) {
      const rules = ensureRules(cache, check.namespace);
      if (rules.value) {
        if (!rules.value.incomplete || evaluateRules(rules.value, check) === 'allowed') continue;
      } else if (!rules.error) continue; // wait for the rules review
    }
    enqueueReview(cache, check);
  }
}

function fromReview(entry: Timed<AccessDecision> | undefined, rulesVerdict?: RuleVerdict) {
  const decision = entry?.value;
  if (!entry || !decision || decision.error) {
    const settled = !!entry && !entry.loading && entry.at > 0;
    return settled ? { ...OFFLINE, reason: entry.error } : UNKNOWN;
  }
  return {
    state: decision.allowed ? 'allowed' : 'denied',
    restricted: !decision.allowed && rulesVerdict === 'restricted',
    source: 'review',
    reason: decision.reason,
    pending: entry.loading,
  } satisfies AccessAnswer;
}

/** The cached answer for one check (no side effects). */
function resolve(cache: ClusterCache, check: AccessCheck, mode: AccessMode): AccessAnswer {
  if (cache.epoch < 0) return OFFLINE;
  let verdict: RuleVerdict | undefined;
  if (mode === 'auto' && check.namespace) {
    const rules = cache.rules.get(check.namespace);
    if (!rules || (!rules.value && !rules.error)) return UNKNOWN;
    if (rules.value) {
      verdict = evaluateRules(rules.value, check);
      if (verdict === 'allowed' || !rules.value.incomplete)
        return {
          state: verdict === 'allowed' ? 'allowed' : 'denied',
          restricted: verdict === 'restricted',
          source: 'rules',
          reason: null,
          pending: rules.loading,
        };
    }
  }
  return fromReview(cache.reviews.get(checkKey(check)), verdict);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Non-hook reader: current answers for `checks`, starting any lookup they
 * still need. Call from event handlers or effects, not during render.
 */
export function readAccess(
  clusterId: ClusterId,
  checks: readonly AccessCheck[],
  mode: AccessMode = 'auto',
): AccessAnswer[] {
  ensure(clusterId, checks, mode);
  const cache = cacheFor(clusterId);
  return checks.map((c) => resolve(cache, c, mode));
}

/** Mark every answer of a cluster stale; mounted views re-check in the background. */
export function refreshAccess(clusterId: ClusterId) {
  const cache = caches.get(clusterId);
  if (!cache) return;
  for (const entry of cache.rules.values()) if (!entry.loading) entry.at = 0;
  for (const entry of cache.reviews.values()) if (!entry.loading) entry.at = 0;
  bump();
}

/**
 * Fresh SelfSubjectAccessReviews (one batch), bypassing the cache and
 * storing the answers — for explanations that must show the authorizer's
 * current reason.
 */
export async function reviewNow(
  clusterId: ClusterId,
  checks: readonly AccessCheck[],
): Promise<AccessDecision[]> {
  const decisions = await ipc.accessReview(clusterId, [...checks]);
  const cache = cacheFor(clusterId);
  if (cache.epoch < 0) return decisions;
  checks.forEach((check, i) => {
    const decision = decisions[i];
    if (!decision || decision.error) return;
    const key = checkKey(check);
    const entry = cache.reviews.get(key) ?? blankEntry<AccessDecision>();
    Object.assign(entry, { value: decision, error: null, at: Date.now(), loading: false });
    cache.reviews.set(key, entry);
  });
  bump();
  return decisions;
}

/**
 * Answers for `checks`, re-rendering as they arrive. `mode: 'review'` skips
 * the rules review (explicit SSARs, e.g. to verify an incomplete matrix).
 */
export function useAccess(
  clusterId: ClusterId,
  checks: readonly AccessCheck[],
  { mode = 'auto', enabled = true }: { mode?: AccessMode; enabled?: boolean } = {},
): AccessAnswer[] {
  const revision = useAccessStore((s) => s.revision);
  // Status changes re-key the cache (reconnect); subscribe so answers follow.
  const epoch = useAppStore((s) => {
    const status = s.statuses[clusterId];
    return status?.state === 'connected' ? (status.connected_at ?? 0) : -1;
  });
  const key = checks.map(checkKey).join('\n');
  useEffect(() => {
    if (enabled && checks.length) ensure(clusterId, checks, mode);
    // `key` captures `checks`; `revision` re-runs after answers or refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterId, key, mode, enabled, revision, epoch]);
  return useMemo(() => {
    const cache = cacheFor(clusterId);
    return checks.map((c) => resolve(cache, c, mode));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterId, key, mode, revision, epoch]);
}

/** `allowed` only when every check is allowed; `denied` as soon as one is. */
export function useCan(
  clusterId: ClusterId,
  check: AccessCheck | readonly AccessCheck[] | null,
  opts?: { mode?: AccessMode; enabled?: boolean },
): AccessState {
  const checks = useMemo(() => (!check ? [] : Array.isArray(check) ? check : [check]), [check]);
  const answers = useAccess(clusterId, checks as readonly AccessCheck[], opts);
  return answers.length ? allOf(answers.map((a) => a.state)) : 'allowed';
}

/** The rules review of one namespace (shared with every other consumer). */
export function useAccessRules(
  clusterId: ClusterId,
  namespace: string | null,
  enabled = true,
): { rules: AccessRules | null; error: string | null; loading: boolean; updatedAt: number } {
  const revision = useAccessStore((s) => s.revision);
  const epoch = useAppStore((s) => {
    const status = s.statuses[clusterId];
    return status?.state === 'connected' ? (status.connected_at ?? 0) : -1;
  });
  useEffect(() => {
    if (!enabled || !namespace) return;
    const cache = cacheFor(clusterId);
    if (cache.epoch >= 0) ensureRules(cache, namespace);
  }, [clusterId, namespace, enabled, revision, epoch]);
  return useMemo(() => {
    const entry = namespace ? cacheFor(clusterId).rules.get(namespace) : undefined;
    return {
      rules: entry?.value ?? null,
      error: entry?.value ? null : (entry?.error ?? null),
      loading: !!namespace && (!entry || entry.loading),
      updatedAt: entry?.at ?? 0,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterId, namespace, revision, epoch]);
}
