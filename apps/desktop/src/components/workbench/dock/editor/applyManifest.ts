import * as i18n from '@/i18n/core';
import { ipc } from '@/lib/ipc';
import type { ApplyMode, ClusterId } from '@/types';
import { splitDocuments, type YamlDocument } from './documents';

export type DocState = 'pending' | 'running' | 'ok' | 'error';

export interface DocResult {
  index: number;
  label: string;
  namespace: string | null;
  state: DocState;
  message: string | null;
}

export interface ApplySummary {
  results: DocResult[];
  ok: number;
  failed: number;
}

function label(doc: YamlDocument): string {
  if (doc.kind && doc.name) return `${doc.kind}/${doc.name}`;
  if (doc.kind) return doc.kind;
  return i18n.t('Document {index}', { index: doc.index });
}

function successMessage(mode: ApplyMode): string {
  if (mode === 'create') return i18n.t('Created');
  if (mode === 'replace') return i18n.t('Saved');
  return i18n.t('Applied');
}

/**
 * Apply a (multi-document) manifest one document at a time, reporting
 * progress through `onUpdate`. Nothing is sent when any document has a
 * syntax error.
 */
export async function applyManifest(
  clusterId: ClusterId,
  text: string,
  mode: ApplyMode,
  namespace: string | null,
  onUpdate: (results: DocResult[]) => void,
): Promise<ApplySummary> {
  const docs = splitDocuments(text);
  let results: DocResult[] = docs.map((doc) => {
    const issue = doc.issues[0];
    return {
      index: doc.index,
      label: label(doc),
      namespace: doc.namespace,
      state: issue ? 'error' : 'pending',
      message: issue
        ? i18n.t('Line {line}: {message}', { line: issue.line, message: issue.message })
        : null,
    };
  });
  const set = (index: number, patch: Partial<DocResult>) => {
    results = results.map((r, i) => (i === index ? { ...r, ...patch } : r));
    onUpdate(results);
  };
  onUpdate(results);
  if (results.some((r) => r.state === 'error')) {
    return { results, ok: 0, failed: results.filter((r) => r.state === 'error').length };
  }

  for (let i = 0; i < docs.length; i++) {
    set(i, { state: 'running' });
    try {
      const objects = await ipc.resourceApplyYaml(clusterId, docs[i]!.source, mode, namespace);
      const first = objects[0];
      set(i, {
        state: 'ok',
        message: successMessage(mode),
        label: first ? `${first.kind}/${first.metadata.name}` : results[i]!.label,
        namespace: first?.metadata.namespace ?? results[i]!.namespace,
      });
    } catch (err) {
      set(i, { state: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }
  return {
    results,
    ok: results.filter((r) => r.state === 'ok').length,
    failed: results.filter((r) => r.state === 'error').length,
  };
}
