import { kindKey, parseApiVersion, resolveRef } from '@/lib/kube/catalog';
import type { HelmRelease, HelmReleaseDetail, KubeObject, WatchBatch } from '@/types';
import { profileFor, type ClusterProfile } from './profiles';
import { hashString, seeded, type Rand } from './util';

/**
 * In-memory object store per demo cluster plus the watch fan-out. Every
 * mutation goes through `put` / `drop` so open watches receive batches just
 * like the real backend delivers them (~120 ms coalescing). `put` / `drop`
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

interface Watcher {
  id: string;
  clusterId: string;
  key: string;
  namespaces: string[];
  /** A `resource_watch` of the UI, or an internal demo watcher (journal, logs). */
  source: WatcherSource;
  emit: (batch: WatchBatch) => void;
  upserts: Map<string, KubeObject>;
  deletes: Set<string>;
  timer: number | null;
  /** Changes wait until the initial list is delivered (`releaseWatcher`). */
  held: boolean;
}

export type WatcherSource = 'resource_watch' | 'internal';

const watchers = new Map<string, Watcher>();

export function inScope(o: KubeObject, namespaces: string[]) {
  return !namespaces.length || !o.metadata.namespace || namespaces.includes(o.metadata.namespace);
}

/**
 * Registers a watcher. A `resource_watch` watcher starts held: its changes
 * queue until `releaseWatcher`, so they never overtake the chunked initial
 * list (the backend's aggregator orders them the same way).
 */
export function addWatcher(
  clusterId: string,
  key: string,
  namespaces: string[],
  emit: (batch: WatchBatch) => void,
  source: WatcherSource = 'internal',
): string {
  const id = crypto.randomUUID();
  watchers.set(id, {
    id,
    clusterId,
    key,
    namespaces,
    source,
    emit,
    upserts: new Map(),
    deletes: new Set(),
    timer: null,
    held: source === 'resource_watch',
  });
  return id;
}

export function removeWatcher(id: string) {
  const w = watchers.get(id);
  if (w?.timer != null) window.clearTimeout(w.timer);
  watchers.delete(id);
}

export function isWatching(id: string) {
  return watchers.has(id);
}

/** The initial list of `id` was delivered: send the changes queued meanwhile. */
export function releaseWatcher(id: string) {
  const w = watchers.get(id);
  if (!w?.held) return;
  w.held = false;
  if (w.upserts.size || w.deletes.size) schedule(w);
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

function schedule(w: Watcher) {
  if (w.timer != null || w.held) return;
  w.timer = window.setTimeout(() => {
    w.timer = null;
    if (!watchers.has(w.id)) return;
    const batch: WatchBatch = {
      watch_id: w.id,
      reset: false,
      upserts: [...w.upserts.values()],
      deletes: [...w.deletes],
      synced: true,
      error: null,
      recovered: false,
    };
    w.upserts.clear();
    w.deletes.clear();
    w.emit(batch);
  }, 120);
}

function notify(clusterId: string, key: string, o: KubeObject, deleted: boolean) {
  for (const w of watchers.values()) {
    if (w.clusterId !== clusterId || w.key !== key || !inScope(o, w.namespaces)) continue;
    const uid = o.metadata.uid;
    if (deleted) {
      w.upserts.delete(uid);
      w.deletes.add(uid);
    } else {
      w.deletes.delete(uid);
      w.upserts.set(uid, structuredClone(o));
    }
    schedule(w);
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
