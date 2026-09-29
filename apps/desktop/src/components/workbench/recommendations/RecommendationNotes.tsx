import * as i18n from '@/i18n';
import type { ReactNode } from 'react';
import { formatAge } from '@/lib/format';
import { scanStale } from '@/lib/kube/recommendations/model';
import { strategyLabel } from '@/lib/kube/rightsizing/model';
import type { RecommendationLatest, RecommendationScanView, RightsizingReport } from '@/types';
import { NoteBanner, rightsizingNoteText } from '../cost/CostNotes';
import { useNow } from '../util';
import { runTime } from './ScanHeader';

/**
 * The automatic strategy fell back from `workload-history` because
 * kube-state-metrics owner series are missing (its `ownership-unavailable`
 * note is folded into this one).
 */
function automaticFallback(report: RightsizingReport): boolean {
  return (
    report.source === 'prometheus' && report.strategy_auto && report.strategy !== 'workload-history'
  );
}

/**
 * Notes above the results: a hidden scan of another Prometheus
 * configuration, stale results (disconnected, or older than twice the scan
 * interval), a changed history window, the automatic strategy's fallback
 * and the scan's own notes.
 */
export function RecommendationNotes({
  latest,
  scan,
  connected,
  intervalMinutes,
  scanAction,
}: {
  /** The latest scan's answer (`source_changed`). */
  latest: RecommendationLatest | null;
  /** The scan shown: the picked past run, else the latest. */
  scan: RecommendationScanView | null;
  connected: boolean;
  intervalMinutes: number;
  /** Shown with the source-changed note (e.g. "Scan now"). */
  scanAction?: ReactNode;
}) {
  i18n.useLocale();
  const now = useNow(60_000, true);
  const report = scan?.report ?? null;
  const past = !!scan && scan.run.id !== latest?.scan?.run.id;
  const notes: Array<{ key: string; body: ReactNode }> = [];

  if (latest?.source_changed && !past)
    notes.push({
      key: 'source-changed',
      body: (
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="min-w-0 flex-1">
            {i18n.t(
              'The Prometheus configuration changed after the last scan, so its results are hidden. Scan again to see recommendations from the current source.',
            )}
          </span>
          {scanAction}
        </span>
      ),
    });
  if (scan && report && !past) {
    const at = runTime(scan.run);
    if (scanStale(at, connected, intervalMinutes, now))
      notes.push({
        key: 'stale',
        body: connected
          ? i18n.t(
              'These results are {age} old, more than twice the scan interval, so they may be out of date.',
              { age: formatAge(at, now) },
            )
          : i18n.t(
              'The cluster is disconnected: these results are from the last stored scan, {age} ago.',
              { age: formatAge(at, now) },
            ),
      });
  }
  if (scan?.days_changed && report)
    notes.push({
      key: 'days-changed',
      body: i18n.plural(
        'The history window is now {count} day. These results keep the window of their scan; the next scan collects the new one.',
        'The history window is now {count} days. These results keep the window of their scan; the next scan collects the new one.',
        report.settings.days,
      ),
    });
  const fallback = !!report && automaticFallback(report);
  if (report && fallback)
    notes.push({
      key: 'fallback',
      body: i18n.t(
        'kube-state-metrics owner series were not found: pods are matched to workloads by name, and {strategy} was chosen automatically.',
        {
          strategy: strategyLabel(
            report.strategies.find((s) => s.id === report.strategy) ?? {
              id: report.strategy,
              name: report.strategy,
            },
          ),
        },
      ),
    });
  for (const note of report?.notes ?? []) {
    if (fallback && note.kind === 'ownership-unavailable') continue;
    notes.push({ key: `note-${note.kind}`, body: rightsizingNoteText(note) });
  }

  if (!notes.length) return null;
  return (
    <div className="space-y-2">
      {notes.map((n) => (
        <NoteBanner key={n.key}>{n.body}</NoteBanner>
      ))}
    </div>
  );
}
