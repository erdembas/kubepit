import { kindKey, parseApiVersion, resolveRef } from '@/lib/kube/catalog';
import type { HelmRelease, HelmReleaseDetail, KubeObject, WatchBatch } from '@/types';
import { profileFor, type ClusterProfile } from './profiles';
import { chunkBatches, WATCH_BATCH_INTERVAL_MS, WATCH_BATCH_MAX } from './scale';
import { hashString, seeded, type Rand } from './util';

/**
 * In-memory object store per demo cluster plus the watch fan-out. Every
 * mutation goes through `put` / `drop` so open watches receive batches just
 * like the real backend delivers them (150 ms ticks, at most 500 objects per
 * batch; see "Watches" below). `put` / `drop`
 * also keep the name and owner indexes behind `find` / `ownedBy`, so lookups
 * stay cheap in the scaled demo clusters (`./scale.ts`).
 */

export interface HelmRecord {
  history: HelmRelease[];
  values: string[];
  manifest: string;
  notes: string;
  computed: string;
}

export interface ClusterDb {
  id: string;
  profile: ClusterProfile;
  kinds: Map<string, Map<string, KubeObject>>;
  plurals: Map<string, string>;
  helm: Map<string, HelmRecord>;
  rand: Rand;
  rv: number;
  uidSeq: number;
  nodeCursor: number;
  ipSeq: number;
  building: boolean;
  /** `find` index: kind key → `namespace/name` → uids, in table order. */
  byName: Map<string, Map<string, Set<string>>>;
  /** `ownedBy` index: owner uid → owned uids (every kind), in table order. */
  byOwner: Map<string, Set<string>>;
  /** Where each uid is indexed, to unindex it when it is replaced or dropped. */
  indexed: Map<string, IndexEntry>;
}

interface IndexEntry {
  key: string;
  name: string;
  owners: string[];
}

const dbs = new Map<string, ClusterDb>();
let builder: ((db: ClusterDb) => void) | null = null;

/** The fixture builder registers itself here (avoids an import cycle). */
export function setBuilder(fn: (db: ClusterDb) => void) {
  builder = fn;
}

export function getDb(clusterId: string): ClusterDb {
  let db = dbs.get(clusterId);
  if (!db) {
    db = {
      id: clusterId,
      profile: profileFor(clusterId),
      kinds: new Map(),
      plurals: new Map(),
      helm: new Map(),
      rand: seeded(clusterId),
      rv: 1000,
      uidSeq: 0,
      nodeCursor: 0,
      ipSeq: 0,
      building: true,
      byName: new Map(),
      byOwner: new Map(),
      indexed: new Map(),
    };
    dbs.set(clusterId, db);
    builder?.(db);
    db.building = false;
  }
  return db;
}

export function allDbs() {
  return [...dbs.values()];
}

export function keyOf(db: ClusterDb, o: Pick<KubeObject, 'apiVersion' | 'kind'>): string {
  const { group } = parseApiVersion(o.apiVersion);
  const plural = db.plurals.get(`${group}/${o.kind}`);
  if (plural) return group ? `${plural}.${group}` : plural;
  const gvk = resolveRef(o.apiVersion, o.kind);
  return gvk ? kindKey(gvk) : o.kind.toLowerCase();
}

export function nextUid(db: ClusterDb): string {
  const h = hashString(db.id).toString(16).padStart(8, '0');
  const n = (++db.uidSeq).toString(16).padStart(12, '0');
  return `${h}-${n.slice(0, 4)}-4${n.slice(4, 7)}-8${n.slice(7, 10)}-${h.slice(0, 6)}${n.slice(6, 12)}`;
}

export function table(db: ClusterDb, key: string): Map<string, KubeObject> {
  let t = db.kinds.get(key);
  if (!t) {
    t = new Map();
    db.kinds.set(key, t);
  }
  return t;
}

export function list(db: ClusterDb, key: string): KubeObject[] {
  return [...(db.kinds.get(key)?.values() ?? [])];
}

const nameKey = (namespace: string | null | undefined, name: string) =>
  `${namespace || ''}/${name}`;

/** The first object of `key` (in table order) named `namespace/name`. */
export function find(
  db: ClusterDb,
  key: string,
  namespace: string | null | undefined,
  name: string,
) {
  const uids = db.byName.get(key)?.get(nameKey(namespace, name));
  if (!uids) return undefined;
  const t = db.kinds.get(key);
  for (const uid of uids) {
    const o = t?.get(uid);
    if (o && o.metadata.name === name && (o.metadata.namespace ?? null) === (namespace || null))
      return o;
  }
  return undefined;
}

export function byUid(db: ClusterDb, uid: string): KubeObject | undefined {
  for (const t of db.kinds.values()) {
    const o = t.get(uid);
    if (o) return o;
  }
  return undefined;
}

function addIndexed<K>(map: Map<K, Set<string>>, key: K, uid: string) {
  let uids = map.get(key);
  if (!uids) map.set(key, (uids = new Set()));
  uids.add(uid);
}

function removeIndexed<K>(map: Map<K, Set<string>>, key: K, uid: string) {
  const uids = map.get(key);
  if (uids?.delete(uid) && !uids.size) map.delete(key);
}

function unindex(db: ClusterDb, uid: string) {
  const entry = db.indexed.get(uid);
  if (!entry) return;
  const names = db.byName.get(entry.key);
  if (names) removeIndexed(names, entry.name, uid);
  for (const owner of entry.owners) removeIndexed(db.byOwner, owner, uid);
  db.indexed.delete(uid);
}

/**
 * Index `o` under `key`. `appended` (the uid was just added at the end of its
 * table) re-adds the uid, so the index sets keep the table's order.
 */
function index(db: ClusterDb, key: string, o: KubeObject, appended: boolean) {
  const uid = o.metadata.uid;
  const name = nameKey(o.metadata.namespace, o.metadata.name);
  const owners = o.metadata.ownerReferences?.map((r) => r.uid) ?? [];
  const entry = db.indexed.get(uid);
  if (
    entry &&
    !appended &&
    entry.key === key &&
    entry.name === name &&
    entry.owners.length === owners.length &&
    entry.owners.every((owner, i) => owner === owners[i])
  )
    return;
  unindex(db, uid);
  let names = db.byName.get(key);
  if (!names) db.byName.set(key, (names = new Map()));
  addIndexed(names, name, uid);
  for (const owner of owners) addIndexed(db.byOwner, owner, uid);
  db.indexed.set(uid, { key, name, owners });
}

/** Insert or replace an object (assigns uid / resourceVersion) and notify watches. */
export function put(db: ClusterDb, o: KubeObject): KubeObject {
  if (!o.metadata.uid) o.metadata.uid = nextUid(db);
  o.metadata.resourceVersion = String(++db.rv);
  if (o.kind === 'CustomResourceDefinition') {
    const s = o.spec as { group?: string; names?: { kind?: string; plural?: string } };
    if (s.group && s.names?.kind && s.names.plural)
      db.plurals.set(`${s.group}/${s.names.kind}`, s.names.plural);
  }
  const key = keyOf(db, o);
  const t = table(db, key);
  const appended = !t.has(o.metadata.uid);
  t.set(o.metadata.uid, o);
  index(db, key, o, appended);
  if (!db.building) notify(db.id, key, o, false);
  return o;
}

export function drop(db: ClusterDb, o: KubeObject) {
  const key = keyOf(db, o);
  if (!table(db, key).delete(o.metadata.uid)) return;
  unindex(db, o.metadata.uid);
  if (!db.building) notify(db.id, key, o, true);
}

/** Objects of `key` owned by `owner`, in table order. */
export function ownedBy(db: ClusterDb, key: string, owner: KubeObject): KubeObject[] {
  const uids = db.byOwner.get(owner.metadata.uid);
  const t = db.kinds.get(key);
  if (!uids || !t) return [];
  const out: KubeObject[] = [];
  for (const uid of uids) {
    const o = t.get(uid);
    if (o?.metadata.ownerReferences?.some((r) => r.uid === owner.metadata.uid)) out.push(o);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Watches
// ---------------------------------------------------------------------------

// Batches follow the backend's flush rule (`watch.rs` `run_watch`): a ticker
// anchored at the watch start (`WATCH_BATCH_INTERVAL_MS`) flushes whatever is
// pending, and `WATCH_BATCH_MAX` pending changes flush at once, so no batch
// carries more than `WATCH_BATCH_MAX` objects.

interface Changes {
  upserts: Map<string, KubeObject>;
  deletes: Set<string>;
}

interface Watcher {
  id: string;
  clusterId: string;
  key: string;
  namespaces: string[];
  /** A `resource_watch` of the UI, or an internal demo watcher (journal, logs). */
  source: WatcherSource;
  emit: (batch: WatchBatch) => void;
  /** Start of the flush ticker. */
  anchor: number;
  timer: number | null;
  /** Changes of the next batches. */
  pending: Changes;
  /**
   * Changes made before the initial list is delivered: they follow its
   * `synced` batch, so they never overtake the list.
   */
  held: Changes | null;
  /** The next batch is the watch's first (`reset`). */
  first: boolean;
  /** The initial list is delivered: batches carry `synced`. */
  listed: boolean;
  /** A `synced` batch went out. */
  syncedSent: boolean;
  /** `seq` of the last batch (the demo backend ignores acks). */
  seq: number;
}

export type WatcherSource = 'resource_watch' | 'internal';

const watchers = new Map<string, Watcher>();

const noChanges = (): Changes => ({ upserts: new Map(), deletes: new Set() });
const changeCount = (c: Changes) => c.upserts.size + c.deletes.size;
const alive = (w: Watcher) => watchers.get(w.id) === w;

export function inScope(o: KubeObject, namespaces: string[]) {
  return !namespaces.length || !o.metadata.namespace || namespaces.includes(o.metadata.namespace);
}

/**
 * Registers a watcher. A `resource_watch` watcher waits for `deliverList`
 * (its first batch resets, the last list batch is `synced`); an internal one
 * only receives changes.
 */
export function addWatcher(
  clusterId: string,
  key: string,
  namespaces: string[],
  emit: (batch: WatchBatch) => void,
  source: WatcherSource = 'internal',
): string {
  const id = crypto.randomUUID();
  const listing = source === 'resource_watch';
  watchers.set(id, {
    id,
    clusterId,
    key,
    namespaces,
    source,
    emit,
    anchor: Date.now(),
    timer: null,
    pending: noChanges(),
    held: listing ? noChanges() : null,
    first: listing,
    listed: !listing,
    syncedSent: !listing,
    seq: 0,
  });
  return id;
}

export function removeWatcher(id: string) {
  const w = watchers.get(id);
  if (w?.timer != null) window.clearTimeout(w.timer);
  watchers.delete(id);
}

export function hasWatchers(clusterId?: string) {
  for (const w of watchers.values()) if (!clusterId || w.clusterId === clusterId) return true;
  return false;
}

/** The UI's open resource watches (for the perf probe and scope checks). */
export function mockWatchStats(): Array<{ clusterId: string; key: string; namespaces: string[] }> {
  return [...watchers.values()]
    .filter((w) => w.source === 'resource_watch')
    .map((w) => ({ clusterId: w.clusterId, key: w.key, namespaces: [...w.namespaces] }));
}

/** Sends one batch of at most `WATCH_BATCH_MAX` pending changes. */
function flush(w: Watcher) {
  const upserts: KubeObject[] = [];
  const deletes: string[] = [];
  for (const [uid, o] of w.pending.upserts) {
    if (upserts.length >= WATCH_BATCH_MAX) break;
    upserts.push(o);
    w.pending.upserts.delete(uid);
  }
  for (const uid of w.pending.deletes) {
    if (upserts.length + deletes.length >= WATCH_BATCH_MAX) break;
    deletes.push(uid);
    w.pending.deletes.delete(uid);
  }
  const batch: WatchBatch = {
    watch_id: w.id,
    reset: w.first,
    upserts,
    deletes,
    synced: w.listed,
    error: null,
    recovered: false,
    seq: ++w.seq,
    stopped: false,
  };
  w.first = false;
  if (w.listed) w.syncedSent = true;
  w.emit(batch);
}

/** Full batches go out at once, the rest at the next tick. */
function flushFull(w: Watcher) {
  while (alive(w) && changeCount(w.pending) >= WATCH_BATCH_MAX) flush(w);
  if (alive(w) && changeCount(w.pending)) scheduleTick(w);
}

function scheduleTick(w: Watcher) {
  if (w.timer != null) return;
  const now = Date.now();
  const ticks = Math.floor((now - w.anchor) / WATCH_BATCH_INTERVAL_MS) + 1;
  w.timer = window.setTimeout(() => tick(w), w.anchor + ticks * WATCH_BATCH_INTERVAL_MS - now);
}

function tick(w: Watcher) {
  w.timer = null;
  if (!alive(w)) return;
  const syncing = w.listed && !w.syncedSent;
  if (!syncing && !changeCount(w.pending)) return;
  flush(w);
  // The list is delivered: the changes made meanwhile follow.
  if (syncing && w.held) {
    w.pending = w.held;
    w.held = null;
  }
  flushFull(w);
}

/**
 * Delivers the initial list of a `resource_watch` watcher as the backend
 * does: every full chunk of `WATCH_BATCH_MAX` objects at once (one macrotask
 * each, the first with `reset`), the remainder with `synced` at the next
 * tick (the only batch of a shorter or empty list), then the changes made
 * meanwhile.
 */
export function deliverList(id: string, items: readonly KubeObject[]) {
  const w = watchers.get(id);
  if (!w || w.listed) return;
  const chunks = chunkBatches(id, items);
  const send = (i: number) => {
    if (!alive(w)) return;
    const chunk = chunks[i]!;
    if (chunk.upserts.length === WATCH_BATCH_MAX) {
      w.emit({
        ...chunk,
        reset: w.first,
        upserts: structuredClone(chunk.upserts),
        synced: false,
        seq: ++w.seq,
      });
      w.first = false;
      if (i + 1 < chunks.length) {
        window.setTimeout(() => send(i + 1), 0);
        return;
      }
    } else {
      for (const o of chunk.upserts) w.pending.upserts.set(o.metadata.uid, structuredClone(o));
    }
    w.listed = true;
    scheduleTick(w);
  };
  send(0);
}

function notify(clusterId: string, key: string, o: KubeObject, deleted: boolean) {
  for (const w of watchers.values()) {
    if (w.clusterId !== clusterId || w.key !== key || !inScope(o, w.namespaces)) continue;
    const changes = w.held ?? w.pending;
    const uid = o.metadata.uid;
    if (deleted) {
      changes.upserts.delete(uid);
      changes.deletes.add(uid);
    } else {
      changes.deletes.delete(uid);
      changes.upserts.set(uid, structuredClone(o));
    }
    if (!w.held) flushFull(w);
  }
}

export function helmKey(namespace: string, name: string) {
  return `${namespace}/${name}`;
}

export function helmDetail(record: HelmRecord): HelmReleaseDetail {
  const release = record.history[record.history.length - 1]!;
  return {
    release,
    history: [...record.history].reverse(),
    values_yaml: record.values[record.values.length - 1] ?? '',
    computed_values_yaml: record.computed,
    manifest: record.manifest,
    notes: record.notes,
  };
}
