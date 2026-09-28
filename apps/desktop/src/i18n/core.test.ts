import { afterEach, describe, expect, it, vi } from 'vitest';
import { date, number, plural, relative, setLocale } from './core';

afterEach(() => {
  vi.restoreAllMocks();
  setLocale('en', false);
});

describe('Intl formatter cache', () => {
  it('builds one NumberFormat per locale and options, not one per call', () => {
    const spy = vi.spyOn(Intl, 'NumberFormat');
    const opts = { minimumFractionDigits: 1, maximumFractionDigits: 1 };
    for (let i = 0; i < 100; i++) number(i / 3, { ...opts });
    number(7);
    number(8);
    // One for the options (equal literals share it), one for the defaults.
    expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('builds one DateTimeFormat per options', () => {
    const spy = vi.spyOn(Intl, 'DateTimeFormat');
    for (let i = 0; i < 50; i++) date(i * 3_600_000, { hour: '2-digit', minute: '2-digit' });
    expect(spy.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('keeps the output of a fresh formatter, per locale', () => {
    const opts = { maximumFractionDigits: 1 };
    expect(number(1234.56, opts)).toBe(new Intl.NumberFormat('en-US', opts).format(1234.56));
    setLocale('tr', false);
    expect(number(1234.56, opts)).toBe(new Intl.NumberFormat('tr-TR', opts).format(1234.56));
    const d = Date.UTC(2026, 8, 28, 12, 30);
    const dOpts = { dateStyle: 'medium', timeStyle: 'short' } as const;
    expect(date(d, dOpts)).toBe(new Intl.DateTimeFormat('tr-TR', dOpts).format(d));
    expect(relative(-1, 'day')).toBe(
      new Intl.RelativeTimeFormat('tr-TR', { numeric: 'auto' }).format(-1, 'day'),
    );
    setLocale('en', false);
    expect(number(1234.56, opts)).toBe('1,234.6');
    expect(relative(-1, 'day')).toBe('yesterday');
  });

  it('still picks the plural form per count', () => {
    expect(plural('{count} object', '{count} objects', 1)).toBe('1 object');
    expect(plural('{count} object', '{count} objects', 1200)).toBe('1,200 objects');
  });
});
