import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ColumnContext } from '@/lib/kube/columns';
import type { KubeObject } from '@/types';
import { DeferredSection } from './DeferredSection';

// The below-the-fold workload sections: charts + Prometheus polls, the
// right-sizing report and the pods watch. They must not run on first render.
const heavy = vi.hoisted(() => ({
  metrics: vi.fn(() => null),
  rightsizing: vi.fn(() => null),
  pods: vi.fn(() => null),
}));
vi.mock('./MetricsHistoryCard', () => ({ WorkloadMetricsHistory: heavy.metrics }));
vi.mock('../cost/RightsizingSection', () => ({ RightsizingSection: heavy.rightsizing }));
vi.mock('./PodsMiniTable', () => ({ PodsMiniTable: heavy.pods }));

const { WorkloadSections } = await import('./sections/WorkloadSections');
const { hasObjectSecurity } = await import('../security/ObjectSecurity');

const deployment: KubeObject = {
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: { name: 'cart-service', namespace: 'checkout', uid: 'u-1' },
  spec: {
    replicas: 2,
    selector: { matchLabels: { app: 'cart-service' } },
    template: { spec: { containers: [{ name: 'app', image: 'cart:1.9.0' }] } },
  },
  status: { replicas: 2, readyReplicas: 2 },
} as unknown as KubeObject;

const ctx = {
  clusterId: 'c-staging',
  now: Date.now(),
  apiResources: null,
  podMetrics: { available: false, byKey: new Map() },
  nodeMetrics: { available: false, byName: new Map() },
  navigate: () => {},
} as unknown as ColumnContext;

describe('DeferredSection', () => {
  it('renders a placeholder, not its children, until it scrolls into view', () => {
    const child = vi.fn(() => <p>heavy</p>);
    const Child = child;
    const html = renderToStaticMarkup(
      <DeferredSection placeholderHeight={90}>
        <Child />
      </DeferredSection>,
    );
    expect(child).not.toHaveBeenCalled();
    expect(html).toBe(
      '<div aria-hidden="true" data-deferred-section="true" style="height:90px"></div>',
    );
  });

  it('keeps usage charts, right-sizing and the pods table of a workload off the first render', () => {
    const html = renderToStaticMarkup(
      <WorkloadSections
        obj={deployment}
        gvk={{
          group: 'apps',
          version: 'v1',
          kind: 'Deployment',
          plural: 'deployments',
          namespaced: true,
        }}
        ctx={ctx}
        isActive
        readOnly={false}
      />,
    );
    // The summary sections above the fold render right away…
    expect(html).toContain('Pod template');
    expect(html).toContain('cart:1.9.0');
    // …the heavy ones wait behind one placeholder.
    expect(heavy.metrics).not.toHaveBeenCalled();
    expect(heavy.rightsizing).not.toHaveBeenCalled();
    expect(heavy.pods).not.toHaveBeenCalled();
    expect(html).toContain('data-deferred-section');
  });

  it('holds a security placeholder only for kinds that have a security section', () => {
    const obj = (apiVersion: string, kind: string) =>
      ({ apiVersion, kind, metadata: { name: 'x', uid: 'u' } }) as unknown as KubeObject;
    expect(hasObjectSecurity(deployment)).toBe(true);
    expect(hasObjectSecurity(obj('v1', 'ServiceAccount'))).toBe(true);
    expect(hasObjectSecurity(obj('v1', 'ConfigMap'))).toBe(false);
    // A CRD that reuses a built-in kind name is not the built-in.
    expect(hasObjectSecurity(obj('example.com/v1', 'Deployment'))).toBe(false);
  });
});
