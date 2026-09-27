import type { ReactNode } from 'react';
import type { ApiResourceInfo, KubeObject, NodeMetric, PodMetric } from '@/types';

/** A reference another object holds (owner, involvedObject, roleRef, targetRef…). */
export interface ObjectRef {
  apiVersion?: string;
  kind: string;
  name: string;
  namespace?: string | null;
}

export interface MetricsLookup<T> {
  available: boolean;
  byKey: ReadonlyMap<string, T>;
}

export interface ColumnContext {
  clusterId: string;
  now: number;
  apiResources: readonly ApiResourceInfo[] | null;
  podMetrics: MetricsLookup<PodMetric>;
  nodeMetrics: MetricsLookup<NodeMetric>;
  navigate: (ref: ObjectRef) => void;
}

export interface ColumnDef {
  id: string;
  /** Translated lazily so tables follow the UI language. */
  label: () => string;
  /** CSS grid track, e.g. `minmax(180px, 3fr)` or `96px`. */
  width: string;
  cell: (obj: KubeObject, ctx: ColumnContext) => ReactNode;
  sort?: (obj: KubeObject, ctx: ColumnContext) => string | number;
  align?: 'right' | 'center';
  /** Always visible (cannot be hidden from the column menu). */
  fixed?: boolean;
  defaultHidden?: boolean;
  /** Header label is hidden visually (icon-only columns). */
  compact?: boolean;
}

export interface KindColumns {
  columns: ColumnDef[];
  /** Default sort column id (ascending unless `desc`). */
  defaultSort?: { column: string; desc: boolean };
  /** Extra text the filter box matches (status, node, message…). */
  searchText?: (obj: KubeObject) => string;
}
