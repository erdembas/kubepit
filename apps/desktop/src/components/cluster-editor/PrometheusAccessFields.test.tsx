import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { accessDraft } from '@/lib/prometheusAccess';
import type { PrometheusConfig } from '@/types';
import { PrometheusAccessFields } from './PrometheusAccessFields';

const https: PrometheusConfig = {
  mode: 'service',
  namespace: 'monitoring',
  service: 'thanos-query',
  port: 9090,
  scheme: 'https',
  path_prefix: '',
};

function render(draft: ReturnType<typeof accessDraft>, config: PrometheusConfig = https) {
  return renderToStaticMarkup(
    <PrometheusAccessFields config={config} value={draft} onChange={() => undefined} />,
  );
}

describe('PrometheusAccessFields', () => {
  it('stays collapsed until something is configured', () => {
    const html = render(accessDraft(undefined));
    expect(html).toContain('Shared or secured Prometheus');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('Cluster labels');
  });

  it('shows a reserved label key as an error', () => {
    const html = render({ ...accessDraft(undefined), labels: [{ name: 'pod', value: 'x' }] });
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('The label pod is used by Kubepit’s own queries');
    expect(html).toContain('aria-invalid="true"');
  });

  it('shows the Secret reference, the CA and the skip-verify warning', () => {
    const html = render(
      accessDraft({
        tenant: '',
        cluster_labels: { cluster: 'prod' },
        auth: { type: 'bearer', namespace: 'monitoring', secret: 'prom-auth', token_key: 'token' },
        tls: { ca: null, insecure_skip_verify: true },
      }),
    );
    expect(html).toContain('value="prom-auth"');
    expect(html).toContain('Token key');
    expect(html).toContain('thanos-query.monitoring.svc');
    expect(html).toContain('Insecure');
    // No TLS settings for a plain-http service.
    const plain = render(accessDraft({ tenant: '', cluster_labels: {}, auth: null, tls: null }), {
      ...https,
      scheme: 'http',
    });
    expect(plain).not.toContain('Skip TLS verification');
  });
});
