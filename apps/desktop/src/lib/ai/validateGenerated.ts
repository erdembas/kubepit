import * as i18n from '@/i18n/core';
import { parseAllDocuments, LineCounter } from 'yaml';
import { resolveKind, type KindResolution } from '@/lib/kube/schema/loader';
import { validateManifest } from '@/lib/kube/schema/validate';
import type { ClusterId } from '@/types';

export interface GeneratedValidation {
  documents: number;
  issues: { document: number; severity: 'error' | 'warning'; message: string; line: number }[];
  unresolved: string[];
}
export async function validateDocuments(
  yaml: string,
  resolve: (apiVersion: string, kind: string) => Promise<KindResolution>,
): Promise<GeneratedValidation> {
  const counter = new LineCounter();
  const docs = parseAllDocuments(yaml, { lineCounter: counter });
  const result: GeneratedValidation = { documents: docs.length, issues: [], unresolved: [] };
  for (const [index, doc] of docs.entries()) {
    const issue = (message: string, start: number, severity: 'error' | 'warning' = 'error') =>
      result.issues.push({
        document: index + 1,
        severity,
        message,
        line: counter.linePos(start).line,
      });
    for (const error of doc.errors) issue(error.message, error.pos[0]);
    if (doc.errors.length || !doc.contents) continue;
    const apiVersion = doc.get('apiVersion');
    const kind = doc.get('kind');
    if (typeof apiVersion !== 'string' || typeof kind !== 'string') {
      issue(i18n.t('Each document needs apiVersion and kind.'), doc.range?.[0] ?? 0);
      continue;
    }
    let resolved: KindResolution;
    try {
      resolved = await resolve(apiVersion, kind);
    } catch {
      resolved = { status: 'unavailable' };
    }
    if (resolved.status !== 'ok') {
      result.unresolved.push(`${apiVersion} ${kind}`);
      continue;
    }
    for (const found of validateManifest(resolved.set, resolved.root, doc.contents))
      issue(found.message, found.start, found.severity);
  }
  result.unresolved = [...new Set(result.unresolved)];
  return result;
}
export function validateGenerated(
  clusterId: ClusterId,
  yaml: string,
): Promise<GeneratedValidation> {
  return validateDocuments(yaml, (apiVersion, kind) => resolveKind(clusterId, apiVersion, kind));
}
