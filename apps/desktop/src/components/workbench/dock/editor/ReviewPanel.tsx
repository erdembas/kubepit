import * as i18n from '@/i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Loader2, RefreshCw, ScanSearch, Send, XCircle } from 'lucide-react';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { cn } from '@/lib/cn';
import type { DryRunResult } from '@/types';
import { DiffView } from '../../common/DiffView';
import { EditorBanner, EditorBar } from './EditorChrome';
import {
  badgeOf,
  initialSelection,
  resultLabel,
  reviewSides,
  summarize,
  type ReviewBadge,
  type ReviewState,
} from './review';

const TONE: Record<ReviewBadge, BadgeTone> = {
  create: 'success',
  update: 'info',
  unchanged: 'neutral',
  error: 'critical',
};

function badgeLabel(badge: ReviewBadge): string {
  if (badge === 'create') return i18n.t('create');
  if (badge === 'update') return i18n.t('update');
  if (badge === 'unchanged') return i18n.t('unchanged');
  return i18n.t('error');
}

/**
 * Review mode of a dock editor: the dry-run result per document (operation
 * badge, live → after-apply diff, server errors inline) and the button that
 * performs the real apply.
 */
export function ReviewPanel({
  review,
  readOnly,
  applying,
  onBack,
  onRerun,
  onApply,
}: {
  review: ReviewState;
  readOnly: boolean;
  applying: boolean;
  onBack: () => void;
  onRerun: () => void;
  onApply: () => void;
}) {
  i18n.useLocale();
  const results = useMemo(() => (review.status === 'ready' ? review.results : []), [review]);
  const [selected, setSelected] = useState(0);
  useEffect(() => setSelected(initialSelection(results)), [results]);
  const summary = summarize(results);
  const current: DryRunResult | undefined = results[selected] ?? results[0];
  const sides = useMemo(() => (current ? reviewSides(current) : null), [current]);
  const ready = review.status === 'ready';
  // Take focus from the (now hidden) editor so Esc returns to it.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => rootRef.current?.focus({ preventScroll: true }), []);

  const applyLabel =
    review.mode === 'replace'
      ? i18n.t('Save changes')
      : review.mode === 'create'
        ? i18n.plural('Create {count} resource', 'Create {count} resources', summary.changes)
        : i18n.plural('Apply {count} change', 'Apply {count} changes', summary.changes);
  const blocked = readOnly
    ? i18n.t('This cluster is read-only. Changes cannot be saved or applied.')
    : summary.error
      ? i18n.plural('Fix {count} error first', 'Fix {count} errors first', summary.error)
      : ready && summary.changes === 0
        ? i18n.t('Nothing would change')
        : null;

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className="flex min-h-0 flex-1 flex-col outline-none"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.defaultPrevented) {
          e.preventDefault();
          onBack();
        }
      }}
    >
      <EditorBar>
        <ScanSearch className="text-accent h-3.5 w-3.5 shrink-0" />
        <span className="text-fg shrink-0 text-[12px] font-medium">{i18n.t('Review changes')}</span>
        <span
          className="text-fg-dim min-w-0 truncate text-[11px]"
          title={i18n.t('Server-side dry run: nothing has been changed yet')}
        >
          {i18n.t('Server-side dry run: nothing has been changed yet')}
        </span>
        {ready && (
          <span className="ml-1 flex shrink-0 items-center gap-1">
            {summary.create > 0 && (
              <Badge tone="success">{i18n.t('{count} to create', { count: summary.create })}</Badge>
            )}
            {summary.update > 0 && (
              <Badge tone="info">{i18n.t('{count} to update', { count: summary.update })}</Badge>
            )}
            {summary.unchanged > 0 && (
              <Badge tone="neutral">
                {i18n.t('{count} unchanged', { count: summary.unchanged })}
              </Badge>
            )}
            {summary.error > 0 && (
              <Badge tone="critical">
                {i18n.plural('{count} error', '{count} errors', summary.error)}
              </Badge>
            )}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
          <Button
            size="xs"
            variant="ghost"
            leftIcon={<ArrowLeft className="h-3 w-3" />}
            onClick={onBack}
            title={i18n.t('Back to editor (Esc)')}
          >
            {i18n.t('Back to editor')}
          </Button>
          <IconButton
            size="xs"
            label={i18n.t('Run the dry run again')}
            icon={<RefreshCw />}
            disabled={review.status === 'loading' || applying}
            onClick={onRerun}
          />
          <Button
            size="xs"
            variant="primary"
            leftIcon={
              applying ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />
            }
            disabled={!ready || blocked !== null || applying}
            title={blocked ?? undefined}
            onClick={onApply}
          >
            {applyLabel}
          </Button>
        </div>
      </EditorBar>
      {review.status === 'loading' ? (
        <div className="text-fg-dim flex flex-1 items-center justify-center gap-2 text-[12px]">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {i18n.t('Running a server-side dry run…')}
        </div>
      ) : review.status === 'error' ? (
        <>
          <EditorBanner tone="error">{review.message}</EditorBanner>
          <div className="text-fg-dim flex flex-1 items-center justify-center p-6 text-center text-[12px]">
            {i18n.t('The dry run failed before any document was checked. Nothing was changed.')}
          </div>
        </>
      ) : (
        <div className="flex min-h-0 flex-1">
          {results.length > 1 && (
            <ul
              aria-label={i18n.t('Documents')}
              className="overlay-scroll border-border/60 w-72 shrink-0 space-y-px overflow-y-auto border-r p-1.5"
            >
              {results.map((r, i) => {
                const badge = badgeOf(r);
                return (
                  <li key={i}>
                    <button
                      type="button"
                      onClick={() => setSelected(i)}
                      aria-current={i === selected}
                      className={cn(
                        'rounded-app-sm flex w-full min-w-0 items-center gap-2 px-2 py-1.5 text-left transition',
                        i === selected
                          ? 'bg-fg/6 shadow-[inset_2px_0_0_rgb(var(--accent))]'
                          : 'hover:bg-fg/4',
                      )}
                    >
                      <Badge tone={TONE[badge]} className="min-w-[74px] justify-center">
                        {badgeLabel(badge)}
                      </Badge>
                      <span className="min-w-0 flex-1">
                        <span
                          className="text-fg block truncate font-mono text-[11.5px]"
                          title={resultLabel(r, i)}
                        >
                          {resultLabel(r, i)}
                        </span>
                        {r.namespace && (
                          <span className="text-fg-dim block truncate font-mono text-[10px]">
                            {r.namespace}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="flex min-w-0 flex-1 flex-col">
            {!current ? null : current.error ? (
              <div className="overlay-scroll flex min-h-0 flex-1 flex-col overflow-auto p-3">
                <div className="border-tone-critical/30 bg-tone-critical/5 text-tone-critical-fg rounded-app-sm border px-3 py-2">
                  <p className="mb-1 flex items-center gap-1.5 text-[12px] font-medium">
                    <XCircle className="h-3.5 w-3.5 shrink-0" />
                    {i18n.t('{name} was rejected', { name: resultLabel(current, selected) })}
                  </p>
                  <p className="font-mono text-[11.5px] break-words whitespace-pre-wrap">
                    {current.error}
                  </p>
                </div>
                <p className="text-fg-dim mt-2 text-[11.5px]">
                  {i18n.t('Nothing was changed. Fix the manifest and review again.')}
                </p>
              </div>
            ) : (
              sides && (
                <DiffView
                  original={sides.original}
                  modified={sides.modified}
                  originalLabel={current.live ? i18n.t('Live') : i18n.t('Not in the cluster')}
                  modifiedLabel={i18n.t('After apply')}
                  identicalHint={i18n.t('The server would leave this object unchanged.')}
                />
              )
            )}
          </div>
        </div>
      )}
    </div>
  );
}
