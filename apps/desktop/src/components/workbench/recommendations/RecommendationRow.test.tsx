import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ContainerRecommendation, WorkloadRecommendation } from '@/types';
import { RecommendationRow, type RecommendationRowProps } from './RecommendationRow';

const MiB = 1024 ** 2;

const app: ContainerRecommendation = {
  name: 'app',
  current: { cpu_request: 500, memory_request: 256 * MiB, cpu_limit: 1000, memory_limit: null },
  recommended: {
    cpu_request: 800,
    memory_request: 256 * MiB,
    cpu_limit: 1600,
    memory_limit: null,
  },
  usage: null,
  cpu: 'increase',
  memory: 'unchanged',
  memory_limit: 'unchanged',
  cpu_limit: 'increase',
  confidence: 'medium',
  warnings: [{ code: 'cpu-throttled', detail: '12%' }],
  cpu_limit_raised: true,
  memory_limit_raised: false,
  evidence: null,
};

const rec: WorkloadRecommendation = {
  kind: 'Deployment',
  namespace: 'shop',
  name: 'web',
  uid: 'u1',
  replicas: 2,
  confidence: 'medium',
  verdict: 'under',
  coverage_hours: 168,
  containers: [app],
  monthly_delta: 12.5,
  monthly_current: 40,
  changed: true,
  pods: [],
  pods_truncated: false,
  hpa: null,
  lenses: ['increase', 'limit-raised', 'needs-review'],
  cost_replicas: 2,
};

const noop = () => undefined;

function render(over: Partial<RecommendationRowProps> = {}) {
  return renderToStaticMarkup(
    <ul>
      <RecommendationRow
        rec={rec}
        rowKey="Deployment/shop/web"
        mode="review"
        currency="USD"
        active={false}
        selected={false}
        applied={false}
        actions
        connected
        onToggle={noop}
        onOpen={noop}
        onApply={noop}
        onReview={noop}
        {...over}
      />
    </ul>,
  );
}

const buttonText = (html: string) =>
  [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, ''));

describe('RecommendationRow', () => {
  it('shows the workload, badges, flags with their caveat and the raised limit ratio', () => {
    const html = render();
    expect(html).toContain('>web</button>');
    expect(html).toContain('Under-provisioned');
    expect(html).toContain('Medium confidence');
    expect(html).toMatch(
      /title="CPU was throttled in 12% of CFS periods[^"]*"[^>]*>CPU throttled</,
    );
    expect(html).toContain('raised ×2');
    expect(html).toContain('+$12.50 / month');
  });

  it('offers the action of the apply mode', () => {
    expect(buttonText(render({ mode: 'one-click' }))).toContain('Apply');
    expect(buttonText(render({ mode: 'review' }))).toContain('Review &amp; apply');
    expect(buttonText(render({ mode: 'read-only' }))).toContain('Review');
    const none = render({ mode: 'none', rec: { ...rec, changed: false, monthly_delta: 0 } });
    expect(buttonText(none)).toEqual(['web']);
    expect(none).toContain('No change');
  });

  it('needs the connection, and offers nothing for a past run or once applied', () => {
    expect(render({ connected: false })).toMatch(
      /title="Connect to the cluster to apply\."[^>]*><button[^>]*disabled=""/,
    );
    expect(buttonText(render({ actions: false }))).toEqual(['web']);
    const applied = render({ applied: true });
    expect(applied).toContain('Applied, updated at the next scan');
    expect(buttonText(applied)).toEqual(['web']);
  });

  it('marks the open row with the accent strip and a checked row with its tint', () => {
    expect(render({ active: true })).toContain('shadow-[inset_2px_0_0_rgb(var(--accent))]');
    expect(render({ active: true })).toContain('aria-current="true"');
    expect(render({ selected: true })).toMatch(/type="checkbox"[^>]*checked=""/);
  });
});
