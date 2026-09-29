import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ContainerRecommendation, RightsizingReport, WorkloadRecommendation } from '@/types';
import { DrawerSection } from './DrawerSection';
import { DrawerFrame, MissingRecommendation, RecommendationDrawer } from './RecommendationDrawer';
import { UsageHistoryCharts } from './UsageHistoryCharts';

const CLUSTER = 'c-drawer-test';

function container(over: Partial<ContainerRecommendation> = {}): ContainerRecommendation {
  return {
    name: 'app',
    current: {
      cpu_request: 500,
      cpu_limit: null,
      memory_request: 512 * 2 ** 20,
      memory_limit: null,
    },
    recommended: {
      cpu_request: 120,
      cpu_limit: null,
      memory_request: 256 * 2 ** 20,
      memory_limit: null,
    },
    usage: {
      cpu_p95: 90,
      cpu_max: 140,
      memory_max: 200 * 2 ** 20,
      hours: 168,
      cpu_avg: 40,
      memory_avg: 150 * 2 ** 20,
    },
    cpu: 'decrease',
    memory: 'decrease',
    memory_limit: 'unchanged',
    cpu_limit: 'unchanged',
    confidence: 'high',
    warnings: [],
    cpu_limit_raised: false,
    memory_limit_raised: false,
    evidence: {
      observed_hours: 168,
      cpu_coverage: 0.99,
      memory_coverage: 0.98,
      cpu_samples: 2000,
      memory_samples: 1990,
      pods: 2,
      duty: null,
      throttle_ratio: null,
      oom_killed: false,
      partial: false,
      identity: 'owner-metrics',
    },
    ...over,
  };
}

function workload(over: Partial<WorkloadRecommendation> = {}): WorkloadRecommendation {
  return {
    kind: 'Deployment',
    namespace: 'shop',
    name: 'checkout',
    uid: 'u1',
    replicas: 2,
    confidence: 'high',
    verdict: 'over',
    coverage_hours: 168,
    containers: [container()],
    monthly_delta: -40,
    monthly_current: 90,
    changed: true,
    pods: ['checkout-a', 'checkout-b'],
    pods_truncated: false,
    hpa: null,
    lenses: [],
    cost_replicas: 2,
    ...over,
  };
}

function report(workloads: WorkloadRecommendation[], over: Partial<RightsizingReport> = {}) {
  return {
    source: 'prometheus',
    window_secs: 7 * 86_400,
    settings: { throttle_threshold_percent: 5 },
    currency: 'USD',
    workloads,
    notes: [],
    strategy: 'workload-history',
    strategies: [],
    computed_at: Date.UTC(2026, 8, 28, 12),
    strategy_auto: true,
    window_end: Date.UTC(2026, 8, 28, 12),
    ...over,
  } as unknown as RightsizingReport;
}

const noop = () => {};

/**
 * Stores read their initial state during SSR (zustand's server snapshot),
 * so the drawer is rendered with the props `DrawerSection` gives it; the
 * row lookup is `findRecommendation` (drawerModel.test.ts).
 */
function drawer(
  rec: WorkloadRecommendation,
  { past = false, connected = true }: { past?: boolean; connected?: boolean } = {},
) {
  return renderToStaticMarkup(
    <RecommendationDrawer
      clusterId={CLUSTER}
      rec={rec}
      report={report([rec])}
      runId={past ? 7 : null}
      past={past}
      connected={connected}
      onClose={noop}
      onApply={noop}
      onReview={noop}
    />,
  );
}

describe('DrawerSection', () => {
  it('renders nothing while no row is open', () => {
    expect(
      renderToStaticMarkup(
        <DrawerSection
          clusterId={CLUSTER}
          report={report([workload()])}
          rows={[]}
          runId={null}
          past={false}
          connected
          namespaces={[]}
        />,
      ),
    ).toBe('');
  });
});

describe('RecommendationDrawer', () => {
  it('shows the workload, its changes and the evidence behind them', () => {
    const html = drawer(workload());
    expect(html).toContain('checkout');
    expect(html).toMatch(/<p lang="en"[^>]*>Deployment<\/p>/);
    expect(html).toContain('Open Deployment checkout');
    expect(html).toContain('CPU request');
    expect(html).toContain('Evidence');
    expect(html).toContain('CPU 99% · memory 98%');
    expect(html).toContain('kube-state-metrics owners');
    for (const tab of ['Changes', 'Usage', 'History', 'YAML'])
      expect(html).toMatch(new RegExp(`role="tab"[^>]*>${tab}<`));
    // High confidence, nothing raised, not production: one-click Apply.
    expect(html).toMatch(/<button[^>]*>Apply<\/button>/);
  });

  it('docks from @3xl and lays over the page below', () => {
    const html = drawer(workload());
    expect(html).toMatch(/class="fixed z-40 @3xl:static @3xl:contents"/);
    expect(html).toMatch(/<aside[^>]*class="[^"]*\babsolute\b[^"]*@3xl:sticky[^"]*"/);
    expect(html).toMatch(/<aside[^>]*tabindex="-1"/);
    expect(html).toContain('aria-label="Recommendation for checkout"');
    // The backdrop only exists as an overlay.
    expect(html).toMatch(/bg-black\/30[^"]*@3xl:hidden/);
  });

  it('reviews rows that are not one-click', () => {
    const html = drawer(workload({ confidence: 'medium' }));
    expect(html).toMatch(/<button[^>]*>Review &amp; apply<\/button>/);
  });

  it('shows a past run read-only', () => {
    const html = drawer(workload(), { past: true });
    expect(html).toContain('Past scan of');
    expect(html).toContain('title="A past scan is read-only: pick the latest scan to apply."');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Apply<\/button>/);
  });

  it('applies nothing while disconnected', () => {
    expect(drawer(workload(), { connected: false })).toContain(
      'title="Connect to the cluster to apply."',
    );
  });

  it('offers nothing to apply without a change', () => {
    const html = drawer(workload({ changed: false }));
    expect(html).toContain('No change');
    expect(html).not.toMatch(/>Apply<\/button>|>Review/);
  });

  it('describes the autoscaler of the workload', () => {
    const html = drawer(
      workload({
        hpa: {
          name: 'checkout',
          min_replicas: 2,
          max_replicas: 6,
          metrics: [{ resource: 'cpu', target_utilization: 70 }],
        },
      }),
    );
    expect(html).toContain(
      'Scaled by the HorizontalPodAutoscaler checkout between 2 and 6 replicas.',
    );
    expect(html).toContain('CPU target 70% of the request');
  });

  it('says so when the scan shown lacks the open workload', () => {
    const html = renderToStaticMarkup(
      <DrawerFrame label="StatefulSet/data/gone" openKey="StatefulSet/data/gone" onClose={noop}>
        <MissingRecommendation openKey="StatefulSet/data/gone" onClose={noop} />
      </DrawerFrame>,
    );
    expect(html).toContain('This workload is not in the scan shown.');
    expect(html).toMatch(/<p lang="en"[^>]*>StatefulSet<\/p>/);
    expect(html).toContain('gone');
  });
});

describe('UsageHistoryCharts', () => {
  const rec = workload();
  const charts = (rep: RightsizingReport, connected: boolean, past = false) =>
    renderToStaticMarkup(
      <UsageHistoryCharts
        clusterId={CLUSTER}
        rec={rec}
        report={rep}
        connected={connected}
        past={past}
      />,
    );

  it('needs a connection', () => {
    expect(charts(report([rec]), false)).toContain('Usage history needs a connection');
  });

  it('needs a Prometheus scan', () => {
    const html = charts(report([rec], { source: 'metrics-server' }), true);
    expect(html).toContain('No usage history for this scan');
    expect(html).toContain('metrics-server');
    expect(charts(report([rec], { source: 'none' }), true)).toContain(
      'This scan had no usage source.',
    );
  });

  it('loads the scan window with the reading notes', () => {
    const html = charts(report([rec]), true);
    expect(html).toContain('Last 7 days');
    expect(html).toContain('How to read these measurements');
    expect(html).toContain('The charts follow the 2 pods the scan observed');
    for (const line of ['Average', 'Peak', 'Request', 'Recommended', 'Limit'])
      expect(html).toContain(`</span>${line}</li>`);
    expect(html).not.toContain('Live from Prometheus');
  });

  it('labels live charts under a past run', () => {
    expect(charts(report([rec]), true, true)).toContain('Live from Prometheus');
  });
});
