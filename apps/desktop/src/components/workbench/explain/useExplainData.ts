import { useEffect, useState } from 'react';
import { loadIndex, resolveKind, type KindResolution } from '@/lib/kube/schema/loader';
import type { ExplainTarget } from '@/store/useExplainStore';
import type { OpenApiIndex } from '@/types';
import { errorText } from '../util';

export type SchemaState =
  { status: 'idle' } | { status: 'loading' } | { status: 'done'; resolution: KindResolution };

/**
 * The OpenAPI index and the selected kind's schema for the explorer.
 * `refreshKey` re-reads the index (e.g. after installing a CRD).
 */
export function useExplainData(
  clusterId: string,
  target: ExplainTarget | null,
  refreshKey: number,
  isActive: boolean,
) {
  const [index, setIndex] = useState<OpenApiIndex | null>(null);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [schema, setSchema] = useState<SchemaState>({ status: 'idle' });

  useEffect(() => {
    if (!isActive) return;
    let alive = true;
    loadIndex(clusterId, refreshKey > 0)
      .then((next) => {
        if (!alive) return;
        setIndex(next);
        setIndexError(null);
      })
      .catch((e) => alive && setIndexError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [clusterId, refreshKey, isActive]);

  const apiVersion = target?.apiVersion ?? null;
  const kind = target?.kind ?? null;
  useEffect(() => {
    if (!apiVersion || !kind || !isActive) return;
    let alive = true;
    setSchema((prev) => (prev.status === 'done' ? prev : { status: 'loading' }));
    // Wait for a refreshed index so a new CRD version is picked up.
    const ready = refreshKey > 0 ? loadIndex(clusterId).catch(() => null) : Promise.resolve();
    void ready
      .then(() => resolveKind(clusterId, apiVersion, kind))
      .then((resolution) => alive && setSchema({ status: 'done', resolution }));
    return () => {
      alive = false;
    };
  }, [clusterId, apiVersion, kind, refreshKey, isActive]);

  // A different kind shows its own loading state rather than the previous tree.
  useEffect(() => {
    setSchema({ status: apiVersion && kind ? 'loading' : 'idle' });
  }, [clusterId, apiVersion, kind]);

  return { index, indexError, schema };
}
