import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '@/i18n/core';
import { formatMoney } from './cost';

describe('formatMoney', () => {
  afterEach(() => setLocale('en', false));
  it('uses no decimals from 1,000 and two below', () => {
    expect(formatMoney(7969, 'USD')).toBe('$7,969');
    expect(formatMoney(5669.3, 'USD', { compact: true })).toBe('$5,669');
    expect(formatMoney(2299.7, 'USD', { compact: true })).toBe('$2,300');
    expect(formatMoney(12.4, 'USD')).toBe('$12.40');
    expect(formatMoney(999.994, 'USD')).toBe('$999.99');
    expect(formatMoney(999.996, 'USD')).toBe('$1,000');
  });
  it('treats non-finite values as zero', () => {
    expect(formatMoney(0, 'USD')).toBe('$0.00');
    expect(formatMoney(Number.NaN, 'USD')).toBe('$0.00');
  });
  it('never shows a negative zero', () => {
    expect(formatMoney(-0.004, 'USD')).toBe('$0.00');
    expect(formatMoney(-0, 'USD')).toBe('$0.00');
    expect(formatMoney(-0.004, 'USD', { signed: true })).toBe('$0.00');
    expect(formatMoney(-0.004, 'EURO')).toBe('0.00 EURO');
  });
  it('compacts only from one million', () => {
    expect(formatMoney(1_234_567, 'USD', { compact: true })).toBe('$1.2M');
    expect(formatMoney(1_234_567, 'USD')).toBe('$1,234,567');
    expect(formatMoney(250_120, 'USD', { compact: true })).toBe('$250,120');
  });
  it('signs deltas when asked', () => {
    expect(formatMoney(-12.5, 'USD', { signed: true })).toBe('-$12.50');
    expect(formatMoney(12.5, 'USD', { signed: true })).toBe('+$12.50');
    expect(formatMoney(0, 'USD', { signed: true })).toBe('$0.00');
  });
  it('follows the UI locale and falls back for unknown codes', () => {
    expect(formatMoney(1500, 'EUR')).toBe('€1,500');
    expect(formatMoney(12.4, 'EURO')).toBe('12.40 EURO');
    setLocale('tr', false);
    expect(formatMoney(7969, 'TRY')).toBe('₺7.969');
    expect(formatMoney(12.4, 'USD')).toBe('$12,40');
  });
});
