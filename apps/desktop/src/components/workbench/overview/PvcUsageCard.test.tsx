import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as i18n from '@/i18n/core';
import type { PrometheusPvcUsageResult } from '@/types';
import type { PolledState } from '../data/polled';
import { PvcUsageCard } from './PvcUsageCard';

const mocked = vi.hoisted(() => ({ usage: vi.fn(), refresh: vi.fn() }));
vi.mock('../metrics/usePrometheus', () => ({ usePrometheusPvcUsage: mocked.usage }));

const GiB = 1024 ** 3;

function report(): PrometheusPvcUsageResult {
  return {
    service: {
      kind: 'prometheus',
      namespace: 'monitoring',
      service: 'prometheus',
      port: 9090,
      scheme: 'http',
      path_prefix: '',
    },
    checked_at: Date.UTC(2026, 9, 1, 12),
    warnings: [],
    rows: [
      {
        namespace: 'checkout',
        name: 'data',
        used_bytes: 95 * GiB,
        capacity_bytes: 100 * GiB,
        used_percent: 95,
      },
      {
        namespace: 'payments',
        name: 'data',
        used_bytes: 85 * GiB,
        capacity_bytes: 100 * GiB,
        used_percent: 85,
      },
      {
        namespace: 'monitoring',
        name: 'logs',
        used_bytes: 40 * GiB,
        capacity_bytes: 100 * GiB,
        used_percent: 40,
      },
    ],
  };
}

function render(
  data?: PrometheusPvcUsageResult,
  state: Partial<PolledState<PrometheusPvcUsageResult>> = {},
  isActive = true,
) {
  mocked.usage.mockReturnValue({
    data,
    error: null,
    loading: false,
    updatedAt: 0,
    refresh: mocked.refresh,
    ...state,
  });
  return renderToStaticMarkup(<PvcUsageCard clusterId="c-pvc-test" isActive={isActive} />);
}

beforeEach(() => vi.clearAllMocks());

describe('PvcUsageCard', () => {
  it('stays hidden until usage metrics are available, including empty results and initial errors', () => {
    expect(render()).toBe('');
    expect(render(undefined, { loading: true })).toBe('');
    expect(render(undefined, { error: 'Prometheus unavailable' })).toBe('');
    expect(render({ ...report(), rows: [] })).toBe('');
  });

  it('shows current fullness, bytes and namespaces without merging same-name PVCs', () => {
    const html = render(report());
    expect(html).toContain('PVC usage');
    expect(html).toContain('All namespaces');
    expect(html).toContain('Only PVCs with metrics are included.');
    expect(html).toContain('title="checkout/data"');
    expect(html).toContain('title="payments/data"');
    expect(html).toContain('95%');
    expect(html).toContain('95 GiB / 100 GiB used');
    expect(html).toContain(
      `Prometheus · Updated ${i18n.date(report().checked_at, { timeStyle: 'short' })}`,
    );
    expect(html).toContain('text-tone-critical-fg');
    expect(html).toContain('text-tone-warning-fg');
    expect(html.match(/<li>/g)).toHaveLength(3);
    expect(html.indexOf('checkout/data')).toBeLessThan(html.indexOf('payments/data'));
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain('Retry');
  });

  it('retains last known values but marks them stale when a refresh fails', () => {
    const html = render(report(), { error: 'query timeout' });
    expect(html).toContain('95%');
    expect(html).toContain('Showing the last available metrics.');
    expect(html).toContain('role="status"');
    expect(html).toContain('Retry');
    expect(html).toContain('title="query timeout"');
  });

  it('labels partial Prometheus results as incomplete', () => {
    const html = render({ ...report(), warnings: ['partial response'] });
    expect(html).toContain('This ranking may be incomplete.');
    expect(html).toContain('95%');
    expect(html).toContain('role="status"');
  });

  it('caps only the visual bar when a metric exceeds capacity', () => {
    const data = report();
    data.rows[0] = { ...data.rows[0]!, used_bytes: 105 * GiB, used_percent: 105 };
    const html = render(data);
    expect(html).toContain('105%');
    expect(html).toContain('width:100%');
    expect(html).not.toContain('width:105%');
  });

  it('pauses metric polling while the overview is hidden', () => {
    render(report(), {}, false);
    expect(mocked.usage).toHaveBeenCalledWith('c-pvc-test', false);
  });
});
