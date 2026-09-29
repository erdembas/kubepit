import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WorkloadRecommendation } from '@/types';
import { container, recommend, workload } from '../recommendations/testFixtures';
import { Acknowledgement } from './RightsizingDialog';

const noop = () => undefined;

function rec(over: Partial<WorkloadRecommendation> = {}): WorkloadRecommendation {
  const app = recommend(
    container('app', [500, null], null, {
      warnings: [
        { code: 'oom-killed', detail: null },
        { code: 'cpu-throttled', detail: '12%' },
      ],
    }),
    [800, null],
  );
  return workload('web', [app], { confidence: 'medium', ...over });
}

describe('Acknowledgement', () => {
  it('lists every flag with its caveat and names them in the checkbox', () => {
    const html = renderToStaticMarkup(
      <Acknowledgement rec={rec()} checked={false} onChange={noop} />,
    );
    expect(html).toContain('Medium confidence: review these flags before applying');
    expect(html).toContain('A pod was OOM-killed within the window');
    expect(html).toContain('CPU was throttled in 12% of CFS periods');
    expect(html).toContain('I reviewed: OOM-killed and CPU throttled');
    expect(html).toMatch(/type="checkbox"(?![^>]*checked="")/);
  });

  it('says low confidence and shows the tick', () => {
    const html = renderToStaticMarkup(
      <Acknowledgement rec={rec({ confidence: 'low' })} checked onChange={noop} />,
    );
    expect(html).toContain('Low confidence: review these flags before applying');
    expect(html).toMatch(/type="checkbox"[^>]*checked=""/);
  });
});
