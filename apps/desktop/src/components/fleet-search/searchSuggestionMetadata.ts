import { kindKey } from '@/lib/kube/catalog';
import type { Gvk } from '@/types';

/** Only these metadata fields survive collection; never retain Kubernetes
 * bodies, annotations, resource data, kubeconfigs or connection addresses. */
export interface ResourceMetadataObservation {
  clusterId: string;
  gvk: Gvk;
  name: string;
  namespace: string | null;
  uid: string;
  labels: Readonly<Record<string, string>>;
}

interface RememberedMetadata {
  kindKey: string;
  namespace: string | null;
  namespaceName: string | null;
  labels: Readonly<Record<string, string>>;
}

const MAX_CLUSTERS = 32;
const MAX_PER_CLUSTER = 256;
const MAX_TOTAL = 2048;
const MAX_LABELS = 24;
const MAX_KEYS = 256;
const MAX_VALUES = 128;
const MAX_NAMESPACES = 512;

function validNamespace(value: string | null): value is string {
  return value !== null && value.length <= 63 && /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(value);
}

function labelsOf(labels: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const entries: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(labels)) {
    // Kubernetes labels are short identifiers. Discard malformed/unbounded
    // metadata before retaining it in this session-only sample.
    if (key.length > 317 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(key)) continue;
    if (
      typeof value !== 'string' ||
      value.length > 63 ||
      !/^(?:[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(value)
    )
      continue;
    entries.push([key, value]);
    if (entries.length >= MAX_LABELS) break;
  }
  return Object.fromEntries(entries);
}

/** A small last-observed metadata cache. Empty queries/results do not erase
 * suggestions; updated metadata for the same object replaces its old labels.
 * Cluster removal explicitly drops its entries. Nothing is persisted. */
export class SearchSuggestionMetadata {
  private clusters = new Map<string, Map<string, RememberedMetadata>>();
  private total = 0;

  prune(registeredClusterIds: readonly string[]) {
    const registered = new Set(registeredClusterIds);
    for (const [id, entries] of this.clusters) {
      if (!registered.has(id)) {
        this.total -= entries.size;
        this.clusters.delete(id);
      }
    }
  }

  observe(observations: Iterable<ResourceMetadataObservation>) {
    let inspected = 0;
    for (const observation of observations) {
      if (++inspected > 8192) break;
      if (!observation.clusterId || observation.clusterId.length > 128) continue;
      const kind = kindKey(observation.gvk);
      if (kind.length > 317 || observation.name.length > 253 || observation.uid.length > 128)
        continue;
      const namespace = validNamespace(observation.namespace) ? observation.namespace : null;
      const namespaceName =
        kind === 'namespaces' && validNamespace(observation.name) ? observation.name : null;
      const labels = labelsOf(observation.labels);
      if (!namespace && !namespaceName && !Object.keys(labels).length) continue;
      const id = `${kind}|${namespace ?? ''}|${observation.uid || observation.name}`;
      const entries =
        this.clusters.get(observation.clusterId) ?? new Map<string, RememberedMetadata>();
      this.clusters.delete(observation.clusterId);
      this.clusters.set(observation.clusterId, entries);
      if (entries.delete(id)) this.total--;
      entries.set(id, { kindKey: kind, namespace, namespaceName, labels });
      this.total++;
      while (entries.size > MAX_PER_CLUSTER) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
        this.total--;
      }
      while (this.clusters.size > MAX_CLUSTERS || this.total > MAX_TOTAL) {
        const oldestCluster = this.clusters.keys().next().value;
        if (oldestCluster === undefined) break;
        const oldest = this.clusters.get(oldestCluster)!;
        const key = oldest.keys().next().value;
        if (key !== undefined) {
          oldest.delete(key);
          this.total--;
        }
        if (!oldest.size || this.clusters.size > MAX_CLUSTERS) {
          this.total -= oldest.size;
          this.clusters.delete(oldestCluster);
        }
      }
    }
  }

  collect(clusterIds: readonly string[], kindKeys: readonly string[], namespace: string | null) {
    const kinds = new Set(kindKeys);
    const namespaces = new Set<string>();
    const values = new Map<string, Set<string>>();
    for (const clusterId of clusterIds) {
      // Prefer the most recently seen metadata within a cluster when a
      // label/value limit is hit, while retaining older query observations.
      const rows = [...(this.clusters.get(clusterId)?.values() ?? [])].reverse();
      for (const row of rows) {
        for (const value of [row.namespace, row.namespaceName]) {
          if (value && namespaces.size < MAX_NAMESPACES) namespaces.add(value);
        }
        if ((kinds.size && !kinds.has(row.kindKey)) || (namespace && row.namespace !== namespace))
          continue;
        for (const [key, value] of Object.entries(row.labels)) {
          if (!values.has(key) && values.size >= MAX_KEYS) continue;
          const bucket = values.get(key) ?? new Set<string>();
          if (bucket.size < MAX_VALUES) bucket.add(value);
          values.set(key, bucket);
        }
      }
    }
    return {
      namespaces: [...namespaces].sort((a, b) => a.localeCompare(b)),
      labelValues: Object.fromEntries(
        [...values]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, values]) => [key, [...values].sort((a, b) => a.localeCompare(b))]),
      ),
    };
  }

  /** Cardinality only; useful for ensuring large fixtures stay bounded. */
  size() {
    return { clusters: this.clusters.size, observations: this.total };
  }
}
