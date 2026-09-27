import * as i18n from '@/i18n/core';
import { useCallback, useRef, useState } from 'react';
import { ipc } from '@/lib/ipc';
import { normalizedYaml } from '@/lib/kube/normalize';
import { IS_MAC } from '@/lib/platform';
import { useAppStore } from '@/store/useAppStore';
import type { ApplyMode, ClusterId, DryRunResult } from '@/types';
import { errorText } from '../../util';
import { yamlIssues } from './documents';

/**
 * "Review changes": a server-side dry run of the editor text (same mode and
 * namespace as the real apply) shown as per-document diffs before anything
 * is written. Pure helpers plus the hook both editors share.
 */

/** Cmd/Ctrl+Shift+Enter, as shown in tooltips. */
export const REVIEW_SHORTCUT = IS_MAC ? '⌘⇧↵' : 'Ctrl+Shift+Enter';

export type ReviewBadge = 'create' | 'update' | 'unchanged' | 'error';

export function badgeOf(result: DryRunResult): ReviewBadge {
  return result.error ? 'error' : result.operation;
}

export interface ReviewSummary {
  create: number;
  update: number;
  unchanged: number;
  error: number;
  /** Documents the apply would actually change. */
  changes: number;
}

export function summarize(results: DryRunResult[]): ReviewSummary {
  const summary: ReviewSummary = { create: 0, update: 0, unchanged: 0, error: 0, changes: 0 };
  for (const r of results) summary[badgeOf(r)]++;
  summary.changes = summary.create + summary.update;
  return summary;
}

export function resultLabel(result: DryRunResult, index: number): string {
  if (result.kind && result.name) return `${result.kind}/${result.name}`;
  if (result.kind) return result.kind;
  return i18n.t('Document {index}', { index: index + 1 });
}

/** Both sides of a document's diff: live vs what the server would store. */
export function reviewSides(result: DryRunResult): { original: string; modified: string } {
  return {
    original: normalizedYaml(result.live, { mode: 'edit' }),
    modified: normalizedYaml(result.result, { mode: 'edit' }),
  };
}

/** The document to show first: the first error, else the first change. */
export function initialSelection(results: DryRunResult[]): number {
  const error = results.findIndex((r) => r.error);
  if (error >= 0) return error;
  const change = results.findIndex((r) => !r.error && r.operation !== 'unchanged');
  return Math.max(0, change);
}

export type ReviewState =
  | { status: 'loading'; mode: ApplyMode }
  | { status: 'ready'; mode: ApplyMode; results: DryRunResult[] }
  | { status: 'error'; mode: ApplyMode; message: string };

export function useDryRunReview(clusterId: ClusterId) {
  const [review, setReview] = useState<ReviewState | null>(null);
  const seq = useRef(0);
  const last = useRef<{ text: string; mode: ApplyMode; namespace: string | null } | null>(null);

  const start = useCallback(
    (text: string, mode: ApplyMode, namespace: string | null) => {
      const store = useAppStore.getState();
      if (!text.trim()) {
        store.pushToast('info', i18n.t('Nothing to review: the manifest is empty.'));
        return;
      }
      const issue = yamlIssues(text)[0];
      if (issue) {
        store.pushToast(
          'error',
          i18n.t('Line {line}: {message}', { line: issue.line, message: issue.message }),
        );
        return;
      }
      const id = ++seq.current;
      last.current = { text, mode, namespace };
      setReview({ status: 'loading', mode });
      ipc
        .resourceDryRunYaml(clusterId, text, mode, namespace)
        .then((results) => {
          if (id === seq.current) setReview({ status: 'ready', mode, results });
        })
        .catch((e: unknown) => {
          if (id === seq.current) setReview({ status: 'error', mode, message: errorText(e) });
        });
    },
    [clusterId],
  );

  const rerun = useCallback(() => {
    const prev = last.current;
    if (prev) start(prev.text, prev.mode, prev.namespace);
  }, [start]);

  const close = useCallback(() => {
    seq.current++;
    setReview(null);
  }, []);

  return { review, start, rerun, close };
}
