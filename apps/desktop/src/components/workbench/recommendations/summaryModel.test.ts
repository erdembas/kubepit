import { afterEach, describe, expect, it } from 'vitest';
import * as i18n from '@/i18n/core';
import {
  barPercent,
  lowConfidenceChanges,
  signedPercent,
  spotlightReason,
  totalsChange,
} from './summaryModel';
import { MiB, container, workload } from './testFixtures';

afterEach(() => i18n.setLocale('en', false));

describe('totalsChange', () => {
  it('gives the difference, its share and direction', () => {
    expect(totalsChange(1000, 400)).toEqual({
      now: 1000,
      after: 400,
      delta: -600,
      ratio: -0.6,
      direction: 'decrease',
    });
    expect(totalsChange(200, 300).direction).toBe('increase');
    expect(totalsChange(200, 300).ratio).toBe(0.5);
  });
  it('has no share without a current total and ignores float noise', () => {
    expect(totalsChange(0, 300)).toMatchObject({ ratio: null, direction: 'increase' });
    expect(totalsChange(0.1 + 0.2, 0.3)).toMatchObject({ delta: 0, direction: 'none' });
    expect(totalsChange(0, 0)).toMatchObject({ delta: 0, ratio: null, direction: 'none' });
  });
});

describe('signedPercent', () => {
  it('is signed, with one decimal below ten percent', () => {
    expect(signedPercent(-0.512)).toBe('-51%');
    expect(signedPercent(0.08)).toBe('+8%');
    expect(signedPercent(-0.004)).toBe('-0.4%');
    expect(signedPercent(0)).toBe('0%');
  });
  it('follows the locale', () => {
    i18n.setLocale('tr', false);
    expect(signedPercent(-0.5)).toBe('-%50');
  });
});

describe('barPercent', () => {
  it('scales to the maximum and keeps non-zero bars visible', () => {
    expect(barPercent(50, 200)).toBe(25);
    expect(barPercent(0.001, 200)).toBe(1);
    expect(barPercent(0, 200)).toBe(0);
    expect(barPercent(300, 200)).toBe(100);
    expect(barPercent(5, 0)).toBe(0);
    expect(barPercent(Number.NaN, 10)).toBe(0);
  });
});

describe('spotlightReason', () => {
  it('names an OOM kill first, with the explanation as the title', () => {
    const rec = workload('api', [
      container('a', [100, 100 * MiB], { memory_max: 300 * MiB }),
      container(
        'b',
        [100, 100 * MiB],
        { memory_max: 50 * MiB },
        {
          warnings: [{ code: 'oom-killed', detail: null }],
        },
      ),
    ]);
    const reason = spotlightReason(rec);
    expect(reason?.tone).toBe('critical');
    expect(reason?.text).toBe('OOM-killed');
    expect(reason?.title).toMatch(/OOM-killed within the window/);
  });
  it('gives the largest usage over request (memory peak, CPU p95)', () => {
    const rec = workload('api', [
      container('a', [100, 100 * MiB], { memory_max: 180 * MiB, cpu_p95: 90, cpu_max: 900 }),
      container('b', [200, 1024 * MiB], { memory_max: 100 * MiB, cpu_p95: 250 }),
    ]);
    expect(spotlightReason(rec)).toEqual({
      tone: 'warning',
      text: 'Usage peaks at 1.8× the request',
    });
  });
  it('falls back to an unset request, else nothing', () => {
    const unset = workload('api', [container('a', [null, 100 * MiB], { memory_max: 50 * MiB })]);
    expect(spotlightReason(unset)?.text).toBe('Request not set');
    const calm = workload('api', [
      container('a', [100, 100 * MiB], { memory_max: 50 * MiB, cpu_p95: 50 }),
      container('b', [null, null], null),
    ]);
    expect(spotlightReason(calm)).toBeNull();
  });
});

describe('lowConfidenceChanges', () => {
  it('counts the changed workloads the spotlight leaves out for their confidence', () => {
    const c = [container('a', [100, 100 * MiB], { memory_max: 50 * MiB })];
    const list = [
      workload('a', c, { verdict: 'under', confidence: 'low' }),
      workload('b', c, { verdict: 'under', confidence: 'medium' }),
      workload('c', c, { verdict: 'over', confidence: 'medium' }),
      workload('d', c, { verdict: 'over', confidence: 'high' }),
      workload('e', c, { verdict: 'over', confidence: 'low', changed: false }),
      workload('f', c, { verdict: 'balanced', confidence: 'low' }),
    ];
    expect(lowConfidenceChanges(list)).toBe(2);
    expect(lowConfidenceChanges([])).toBe(0);
  });
});
