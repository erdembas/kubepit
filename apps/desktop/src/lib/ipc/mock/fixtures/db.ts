import { kindKey, parseApiVersion, resolveRef } from '@/lib/kube/catalog';
import type { HelmRelease, HelmReleaseDetail, KubeObject, WatchBatch } from '@/types';
import { profileFor, type ClusterProfile } from './profiles';
import { hashString, seeded, type Rand } from './util';

/**
 * In-memory object store per demo cluster plus the watch fan-out. Every
 * mutation goes through `put` / `drop` so open watches receive batches just
 * like the real backend delivers them (~120 ms coalescing).
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

export function find(
  db: ClusterDb,
  key: string,
  namespace: string | null | undefined,
  name: string,
) {
  for (const o of db.kinds.get(key)?.values() ?? []) {
    if (o.metadata.name === name && (o.metadata.namespace ?? null) === (namespace || null))
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
  table(db, key).set(o.metadata.uid, o);
  if (!db.building) notify(db.id, key, o, false);
  return o;
}

export function drop(db: ClusterDb, o: KubeObject) {
  const key = keyOf(db, o);
  if (table(db, key).delete(o.metadata.uid) && !db.building) notify(db.id, key, o, true);
}

export function ownedBy(db: ClusterDb, key: string, owner: KubeObject): KubeObject[] {
  return list(db, key).filter((o) =>
    o.metadata.ownerReferences?.some((r) => r.uid === owner.metadata.uid),
  );
}

// ---------------------------------------------------------------------------
// Watches
// ---------------------------------------------------------------------------

interface Watcher {
  id: string;
  clusterId: string;
  key: string;
  namespaces: string[];
  emit: (batch: WatchBatch) => void;
  upserts: Map<string, KubeObject>;
  deletes: Set<string>;
  timer: number | null;
}

const watchers = new Map<string, Watcher>();

export function inScope(o: KubeObject, namespaces: string[]) {
  return !namespaces.length || !o.metadata.namespace || namespaces.includes(o.metadata.namespace);
}

export function addWatcher(
  clusterId: string,
  key: string,
  namespaces: string[],
  emit: (batch: WatchBatch) => void,
): string {
  const id = crypto.randomUUID();
  watchers.set(id, {
    id,
    clusterId,
    key,
    namespaces,
    emit,
    upserts: new Map(),
    deletes: new Set(),
    timer: null,
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
    if (w.timer == null) {
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
        };
        w.upserts.clear();
        w.deletes.clear();
        w.emit(batch);
      }, 120);
    }
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
