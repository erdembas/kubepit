import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RecommendationRun, RightsizingReport, WorkloadRecommendation } from '@/types';
import { MiB, container, recommend, workload } from '../recommendations/testFixtures';
import { RecommendationBody } from './RightsizingSection';

const CLUSTER = 'c-details-test';
const NOW = Date.now();

const rec = (over: Partial<WorkloadRecommendation> = {}) =>
  workload(
    'checkout',
    [
      recommend(
        container(
          'app',
          [500, 512 * MiB],
          { cpu_p95: 90, memory_max: 200 * MiB },
          {
            confidence: 'medium',
            warnings: [{ code: 'cpu-throttled', detail: '8.3%' }],
          },
        ),
        [120, 256 * MiB],
      ),
    ],
    { verdict: 'over', confidence: 'medium', monthly_delta: -40, monthly_current: 90, ...over },
  );

const report = {
  source: 'prometheus',
  window_secs: 7 * 86_400,
  currency: 'USD',
  workloads: [],
  computed_at: NOW,
} as unknown as RightsizingReport;

const run = {
  id: 7,
  started_at: NOW - 12 * 60_000,
  finished_at: NOW - 10 * 60_000,
} as RecommendationRun;

/**
 * Stores read their initial state during SSR (no cluster is known, so
 * nothing is one-click); where the row comes from is `rightsizingOrigin`
 * (model.test.ts).
 */
function body(origin: 'stored' | 'live', row = rec()) {
  return renderToStaticMarkup(
    <RecommendationBody
      clusterId={CLUSTER}
      rec={row}
      report={report}
      origin={origin}
      run={origin === 'stored' ? run : null}
      isActive
    />,
  );
}

describe('RightsizingSection', () => {
  it('shows a stored row with its scan age, flags and the way to the view', () => {
    const html = body('stored');
    expect(html).toContain('From the scan 10m ago');
    expect(html).toContain('Prometheus, last 7 days');
    expect(html).toContain('CPU throttled');
    expect(html).toContain('Open in Recommendations');
    expect(html).toContain('Saves about');
    // Medium confidence (and an unknown cluster): the review, never one-click.
    expect(html).toContain('Review &amp; apply');
    expect(html).not.toContain('>Apply<');
  });

  it('shows a live row without a scan age', () => {
    const html = body('live');
    expect(html).not.toContain('From the scan');
    expect(html).toContain('Prometheus, last 7 days');
    expect(html).toContain('Open in Recommendations');
  });

  it('offers no apply when nothing changes', () => {
    const html = body('stored', rec({ changed: false, verdict: 'balanced', monthly_delta: 0 }));
    expect(html).toContain('No change');
    expect(html).not.toContain('Review &amp; apply');
  });
});
