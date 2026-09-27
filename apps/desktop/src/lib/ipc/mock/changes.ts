import YAML from 'yaml';
import { JOURNALED_KINDS } from '@/lib/kube/changes/kinds';
import type {
  ChangeDetail,
  ChangeFilter,
  ChangeJournalStatus,
  ChangePage,
  ChangeSummary,
  ClusterStatus,
  Gvk,
  KubeObject,
  Settings,
  WatchBatch,
} from '@/types';
import { addWatcher, getDb, list, removeWatcher, type ClusterDb } from './fixtures/db';
import {
  changedPaths,
  isIgnored,
  MAX_PATHS,
  normalize,
  seedHistory,
  type Draft,
  type JournalRecord,
} from './fixtures/changes';
import { BOOT, DAY, HOUR } from './fixtures/util';
import { handlers, register, type MockArgs } from './registry';

/**
 * Demo change journal. The first journal of a connected cluster starts with
 * a synthesized last day (as if Kubepit had been recording all along;
 * `kind-kubepit` starts empty, like a fresh connection) and then records
 * live: every mutation made in the preview (scale, edit, delete, set
 * image…) shows up, noise-filtered like the real backend.
 */

interface Base {
  gvk: Gvk;
  namespace: string | null;
  name: string;
  uid: string;
  normalized: Record<string, unknown>;
}

interface Journal {
  connectedAt: number | null;
  startedAt: number;
  nextId: number;
  records: JournalRecord[];
  baseline: Map<string, Base>;
  watchers: string[];
}

const journals = new Map<string, Journal>();
/** Clusters that already had a journal: later ones start empty, like the backend. */
const seeded = new Set<string>();

function settings(): Settings | undefined {
  return handlers.settings_get?.({}) as Settings | undefined;
}

function enabled(clusterId: string) {
  const s = settings();
  return !s || (s.change_journal && !s.change_journal_disabled.includes(clusterId));
}

function status(clusterId: string): ClusterStatus | undefined {
  const all = handlers.cluster_statuses?.({}) as Record<string, ClusterStatus> | undefined;
  return all?.[clusterId];
}

function gvkOf(o: KubeObject): Gvk | null {
  const def = JOURNALED_KINDS.find((k) => k.kind === o.kind);
  return def
    ? {
        group: def.group,
        version: def.version,
        kind: def.kind,
        plural: def.plural,
        namespaced: def.namespaced,
      }
    : null;
}

function push(journal: Journal, draft: Draft) {
  const secret = draft.gvk.kind === 'Secret';
  const paths = draft.before && draft.after ? changedPaths(draft.before, draft.after, secret) : [];
  if (draft.op === 'modified' && !paths.length) return;
  journal.records.push({
    id: journal.nextId++,
    ts: draft.ts,
    gvk: draft.gvk,
    namespace: draft.namespace,
    name: draft.name,
    uid: draft.uid,
    op: draft.op,
    actor: draft.actor,
    paths: paths.slice(0, MAX_PATHS),
    pathCount: paths.length,
    before: draft.before,
    after: draft.after,
  });
}

function stop(clusterId: string) {
  const journal = journals.get(clusterId);
  if (!journal) return;
  journal.watchers.forEach(removeWatcher);
  journals.delete(clusterId);
}

function record(clusterId: string, batch: WatchBatch) {
  const journal = journals.get(clusterId);
  if (!journal) return;
  const ts = Date.now();
  const kubepit = { manager: 'kubepit', operation: 'Update', subresource: null };
  for (const o of batch.upserts) {
    const gvk = gvkOf(o);
    if (!gvk || isIgnored(o)) continue;
    const normalized = normalize(o);
    const previous = journal.baseline.get(o.metadata.uid);
    const base: Base = {
      gvk,
      namespace: o.metadata.namespace ?? null,
      name: o.metadata.name,
      uid: o.metadata.uid,
      normalized,
    };
    journal.baseline.set(o.metadata.uid, base);
    // Status-only updates normalize to no changed path and are dropped by `push`.
    push(journal, {
      ...base,
      ts,
      op: previous ? 'modified' : 'added',
      actor: kubepit,
      before: previous?.normalized ?? null,
      after: normalized,
    });
  }
  for (const uid of batch.deletes) {
    const previous = journal.baseline.get(uid);
    if (!previous) continue;
    journal.baseline.delete(uid);
    push(journal, {
      ...previous,
      ts,
      op: 'deleted',
      actor: null,
      before: previous.normalized,
      after: null,
    });
  }
}

function start(clusterId: string, db: ClusterDb, connectedAt: number | null): Journal {
  const fresh = seeded.has(clusterId) || clusterId === 'c-kind';
  seeded.add(clusterId);
  const journal: Journal = {
    connectedAt,
    startedAt: fresh ? Date.now() : BOOT - 23 * HOUR,
    nextId: 1,
    records: [],
    baseline: new Map(),
    watchers: [],
  };
  if (!fresh) for (const draft of seedHistory(db)) push(journal, draft);
  for (const kind of JOURNALED_KINDS) {
    if (kind.kind === 'Secret' && db.profile.forbidClusterSecrets) continue;
    for (const o of list(db, kind.key)) {
      const gvk = gvkOf(o);
      if (!gvk || isIgnored(o)) continue;
      journal.baseline.set(o.metadata.uid, {
        gvk,
        namespace: o.metadata.namespace ?? null,
        name: o.metadata.name,
        uid: o.metadata.uid,
        normalized: normalize(o),
      });
    }
    journal.watchers.push(addWatcher(clusterId, kind.key, [], (batch) => record(clusterId, batch)));
  }
  journals.set(clusterId, journal);
  return journal;
}

/** The recording journal of `clusterId`, created or dropped to follow connection and settings. */
function journalFor(clusterId: string): Journal | null {
  const s = status(clusterId);
  const connected = s?.state === 'connected';
  let journal = journals.get(clusterId) ?? null;
  if (
    journal &&
    (!connected || !enabled(clusterId) || journal.connectedAt !== (s?.connected_at ?? null))
  ) {
    stop(clusterId);
    journal = null;
  }
  if (!journal && connected && enabled(clusterId))
    journal = start(clusterId, getDb(clusterId), s?.connected_at ?? null);
  return journal;
}

function journalStatus(clusterId: string, journal: Journal | null): ChangeJournalStatus {
  if (!journal)
    return {
      enabled: enabled(clusterId),
      recording: false,
      started_at: null,
      synced: false,
      kinds: [],
      entries: 0,
      evicted: 0,
      oldest_ts: null,
    };
  const forbidSecrets = getDb(clusterId).profile.forbidClusterSecrets;
  return {
    enabled: true,
    recording: true,
    started_at: journal.startedAt,
    synced: true,
    kinds: JOURNALED_KINDS.map((k) =>
      k.kind === 'Secret' && forbidSecrets
        ? {
            kind: k.kind,
            state: 'forbidden' as const,
            message:
              'secrets is forbidden: User "dev@acme.io" cannot list resource "secrets" in API group "" at the cluster scope',
          }
        : { kind: k.kind, state: 'watching' as const, message: null },
    ),
    entries: journal.records.length,
    evicted: 0,
    oldest_ts: journal.records[0]?.ts ?? null,
  };
}

function summary(clusterId: string, r: JournalRecord): ChangeSummary {
  return {
    id: r.id,
    ts: r.ts,
    cluster_id: clusterId,
    gvk: r.gvk,
    namespace: r.namespace,
    name: r.name,
    uid: r.uid,
    op: r.op,
    actor: r.actor,
    paths: r.paths,
    path_count: r.pathCount,
    truncated: false,
  };
}

function matches(r: JournalRecord, f: ChangeFilter, text: string) {
  if (f.since !== null && r.ts < f.since) return false;
  if (f.until !== null && r.ts > f.until) return false;
  if (f.kinds.length && !f.kinds.includes(r.gvk.kind)) return false;
  if (f.namespaces.length) {
    const included = r.namespace
      ? f.namespaces.includes(r.namespace)
      : r.gvk.kind === 'Namespace' && f.namespaces.includes(r.name);
    if (!included) return false;
  }
  if (f.name && r.name !== f.name) return false;
  if (!text) return true;
  const haystack = [
    r.gvk.kind,
    `${r.namespace ?? ''}/${r.name}`,
    r.actor?.manager ?? '',
    ...r.paths.flatMap((p) => [p.path, ...(p.redacted ? [] : [p.before ?? '', p.after ?? ''])]),
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(text);
}

register({
  changes_list: ({ clusterId, filter }: MockArgs): ChangePage => {
    const journal = journalFor(clusterId);
    const f = filter as ChangeFilter;
    const text = (f.text ?? '').trim().toLowerCase();
    const limit = Math.min(1000, Math.max(1, f.limit));
    const now = Date.now();
    const matching = (journal?.records ?? [])
      .filter((r) => now - r.ts <= DAY)
      .filter((r) => f.cursor === null || r.id < f.cursor)
      .filter((r) => matches(r, f, text))
      .reverse();
    const page = matching.slice(0, limit);
    return {
      entries: page.map((r) => summary(clusterId, r)),
      next_cursor: matching.length > limit ? (page[page.length - 1]?.id ?? null) : null,
      status: journalStatus(clusterId, journal),
    };
  },
  changes_get: ({ clusterId, id }: MockArgs): ChangeDetail => {
    const record = journals.get(clusterId)?.records.find((r) => r.id === id);
    if (!record) throw new Error(`change ${id} is no longer in the journal`);
    const yaml = (o: Record<string, unknown> | null) =>
      o ? YAML.stringify(o, { lineWidth: 0 }) : null;
    return {
      summary: summary(clusterId, record),
      before_yaml: yaml(record.before),
      after_yaml: yaml(record.after),
      omitted: false,
    };
  },
});
