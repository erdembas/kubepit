import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { UsageRanking } from './UsageRanking';
import { MiB, container, workload } from './testFixtures';

const render = (list: Parameters<typeof UsageRanking>[0]['list']) =>
  renderToStaticMarkup(<UsageRanking list={list} onOpen={() => {}} />);

describe('UsageRanking', () => {
  const list = [
    workload('checkout', [
      container('app', [100, 100 * MiB], { memory_avg: 300 * MiB }),
      container('idle', [100, 100 * MiB], { memory_avg: 0 }),
      container('fresh', [100, 100 * MiB], null),
    ]),
    workload('search', [container('app', [100, 100 * MiB], { memory_avg: 120 * MiB })], {
      namespace: 'team-search',
    }),
  ];
  const html = render(list);

  it('starts on average memory, with pressed toggles', () => {
    expect(html).toMatch(/aria-pressed="true"[^>]*>Memory<\/button>/);
    expect(html).toMatch(/aria-pressed="false"[^>]*>CPU<\/button>/);
    expect(html).toMatch(/aria-pressed="true"[^>]*>Average<\/button>/);
    expect(html).toMatch(/aria-pressed="false"[^>]*>Peak<\/button>/);
    expect(html).toContain('Average memory');
    expect(html).toContain('Workload / <span lang="en">container</span>');
  });

  it('ranks highest first, keeps zeros and counts containers without data', () => {
    const order = ['300 MiB', '120 MiB', '0 B'].map((v) => html.indexOf(`>${v}<`));
    expect(order.every((i) => i > -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(html).not.toContain('/ fresh');
    expect(html).toContain('Usage data available for 3 of 4 containers.');
  });

  it('pages eight rows at a time', () => {
    expect(html).not.toContain('Next page');
    const many = Array.from({ length: 10 }, (_, i) =>
      workload(`w${i}`, [container('app', [100, 100 * MiB], { memory_avg: (i + 1) * MiB })]),
    );
    const paged = render(many);
    expect(paged.match(/<li>/g)).toHaveLength(8);
    expect(paged).toContain('1–8 of 10');
    expect(paged).toContain('aria-label="Next page"');
  });

  it('explains a scan without usage', () => {
    const empty = render([workload('new', [container('app', [100, 100 * MiB], null)])]);
    expect(empty).toContain('No container has usage data in this scan.');
    expect(empty).toContain('Usage data available for 0 of 1 container.');
    expect(render([])).toContain('No workloads in the namespaces in scope.');
  });
});
