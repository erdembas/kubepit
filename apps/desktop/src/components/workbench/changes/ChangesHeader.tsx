import * as i18n from '@/i18n';
import type { ReactNode } from 'react';
import { History } from 'lucide-react';

/**
 * Header of the Changes view. It is its own `@container`, so it adapts to the
 * pane it sits in, not the window: the row wraps instead of clipping, the
 * controls move to a second row in narrow panes and the search field fills
 * that row below `@lg`. The recording label inside hides below `@2xl`.
 */
export function ChangesHeader({
  count,
  recording,
  ranges,
  search,
  refresh,
}: {
  count: number;
  recording: ReactNode;
  ranges: ReactNode;
  /** Contents of the search field (icon, input, clear button). */
  search: ReactNode;
  refresh: ReactNode;
}) {
  i18n.useLocale();
  return (
    <div className="@container shrink-0">
      <div className="border-border/60 flex min-h-12 shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b px-4 py-2">
        <span className="bg-accent/10 text-accent flex h-6 w-6 shrink-0 items-center justify-center rounded-md">
          <History className="h-3.5 w-3.5" />
        </span>
        <h2 className="text-fg shrink-0 text-[13px] font-semibold">{i18n.t('Changes')}</h2>
        <span className="bg-surface-muted text-fg-dim shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums">
          {count}
        </span>
        {recording}
        <div className="ml-auto flex w-full min-w-0 shrink items-center justify-end gap-1.5 @lg:w-auto">
          {ranges}
          <div className="bg-surface border-border focus-within:border-accent/50 flex h-8 w-full min-w-0 items-center gap-2 rounded-lg border px-2.5 @lg:w-56">
            {search}
          </div>
          {refresh}
        </div>
      </div>
    </div>
  );
}
