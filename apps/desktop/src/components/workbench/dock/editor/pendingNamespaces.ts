import { parse } from 'yaml';
import type { DryRunResult, KubeObject } from '@/types';
import { splitDocuments } from './documents';

/**
 * A dry run cannot create a namespace, so objects in a Namespace that an
 * earlier document of the same manifest creates fail with "namespaces …
 * not found". Applying goes document by document, so they would succeed:
 * show them as new objects instead of errors (the Local manifests matrix
 * does the same). Anything else keeps its error.
 */

const NAMESPACE_MISSING = /namespaces? "([^"]+)" not found/i;

export function resolvePendingNamespaces(
  text: string,
  results: DryRunResult[],
  namespace: string | null,
): DryRunResult[] {
  if (!results.some((r) => r.error && NAMESPACE_MISSING.test(r.error))) return results;
  const docs = splitDocuments(text);
  if (docs.length !== results.length) return results;
  const created = new Map<string, number>();
  results.forEach((r, i) => {
    if (r.kind === 'Namespace' && !r.error && r.operation === 'create') created.set(r.name, i);
  });
  return results.map((r, i) => {
    const ns = r.error ? NAMESPACE_MISSING.exec(r.error)?.[1] : undefined;
    const creator = ns !== undefined ? created.get(ns) : undefined;
    if (creator === undefined || creator >= i) return r;
    let object: KubeObject | null = null;
    try {
      object = parse(docs[i]!.source) as KubeObject;
      object.metadata = {
        ...object.metadata,
        namespace: object.metadata?.namespace ?? namespace ?? ns,
      };
    } catch {
      return r;
    }
    return { ...r, operation: 'create', error: null, live: null, result: object };
  });
}
