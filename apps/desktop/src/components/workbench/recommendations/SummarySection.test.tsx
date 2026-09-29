import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RightsizingReport } from '@/types';
import { CapacityOverview } from './CapacityOverview';
import { ReviewSpotlight } from './ReviewSpotlight';
import { SummarySection } from './SummarySection';
import { MiB, container, recommend, workload } from './testFixtures';

const oom = workload(
  'api',
  [
    recommend(
      container(
        'app',
        [100, 100 * MiB],
        { memory_max: 90 * MiB, cpu_p95: 20 },
        {
          warnings: [{ code: 'oom-killed', detail: null }],
        },
      ),
      [null, 200 * MiB],
    ),
  ],
  { verdict: 'under', confidence: 'medium' },
);
const hot = workload(
  'web',
  [
    recommend(container('web', [100, 100 * MiB], { memory_max: 180 * MiB, cpu_p95: 50 }), [
      null,
      220 * MiB,
    ]),
  ],
  { verdict: 'under', confidence: 'high' },
);
const saving = workload(
  'batch',
  [
    recommend(container('job', [1000, 1024 * MiB], { memory_max: 100 * MiB, cpu_p95: 100 }), [
      200,
      256 * MiB,
    ]),
  ],
  { verdict: 'over', confidence: 'high', monthly_delta: -40, namespace: 'data' },
);
const rows = [hot, saving, oom];
const report = { currency: 'USD', workloads: rows } as unknown as RightsizingReport;

describe('SummarySection', () => {
  const html = renderToStaticMarkup(
    <SummarySection
      clusterId="c-test"
      report={report}
      rows={rows}
      runId={null}
      past={false}
      connected
      namespaces={[]}
    />,
  );

  it('lays the cards out in a grid that stacks below @3xl', () => {
    expect(html).toContain('class="grid gap-3 @3xl:grid-cols-2"');
    expect(html).toMatch(/class="[^"]*@3xl:col-span-2[^"]*"/);
  });

  it('summarizes CPU and memory Now → After with the footnote', () => {
    expect(html).toContain('Optimization summary');
    expect(html).toContain('3/3 containers comparable');
    expect(html).toContain('Savings $40.00');
    expect(html).toContain('Increases $0.00');
    expect(html).toContain(
      'Totals use requests × current replicas. They are not freed node capacity.',
    );
  });

  it('counts the attention and the inventory', () => {
    expect(html).toMatch(/Attention<\/span><span[^>]*>2<\/span>/);
    expect(html).toMatch(/>3<\/dd>/);
    expect(html).toContain('namespaces');
  });

  it('toggles the capacity overview with aria-pressed, CPU first', () => {
    expect(html).toMatch(/aria-pressed="true"[^>]*>CPU<\/button>/);
    expect(html).toMatch(/aria-pressed="false"[^>]*>Memory<\/button>/);
    expect(html).toContain('Show only shop');
  });

  it('puts the OOM-killed workload first and the saving beside it', () => {
    expect(html.indexOf('>api<')).toBeGreaterThan(-1);
    expect(html.indexOf('>api<')).toBeLessThan(html.indexOf('>web<'));
    expect(html).toContain('OOM-killed');
    expect(html).toContain('Usage reaches 1.8× the request');
    expect(html).toContain('Saves about $40.00 a month');
  });

  it('marks the workloads applied in this session', () => {
    const spot = renderToStaticMarkup(
      <ReviewSpotlight
        list={rows}
        onReview={() => {}}
        applied={{ 'Deployment/data/batch': Date.now() }}
      />,
    );
    expect(spot.match(/Applied, updated at the next scan/g)).toHaveLength(1);
    expect(spot.indexOf('Applied, updated')).toBeGreaterThan(spot.indexOf('>batch<'));
  });
});

describe('empty states', () => {
  it('explains an empty capacity overview', () => {
    const empty = renderToStaticMarkup(<CapacityOverview list={[]} onNamespace={() => {}} />);
    expect(empty).toContain('No workloads in the namespaces in scope.');
    const noUsage = workload('new', [container('app', [100, 100 * MiB], null)]);
    const html = renderToStaticMarkup(<CapacityOverview list={[noUsage]} onNamespace={() => {}} />);
    expect(html).toContain('Namespace comparisons appear after the first scan.');
  });

  it('says nothing needs attention, and points at low-confidence changes', () => {
    expect(renderToStaticMarkup(<ReviewSpotlight list={[]} onReview={() => {}} />)).toContain(
      'No workload needs attention',
    );
    const unsure = renderToStaticMarkup(
      <ReviewSpotlight list={[{ ...hot, confidence: 'low' }]} onReview={() => {}} />,
    );
    expect(unsure).toContain('No workload needs attention');
    expect(unsure).toContain('1 changed workload has too little confidence for the spotlight');
  });
});
