import { afterEach, describe, expect, it } from 'vitest';
import * as i18n from '@/i18n/core';
import { redactionSummary, usageSummary } from './format';
afterEach(() => i18n.setLocale('en', false));
describe('assistant display formatting', () => {
  it('summarizes redactions using translated plurals and list formatting', () => {
    i18n.setLocale('en', false);
    expect(redactionSummary({ secrets: 2, tokens: 1, ips: 0, hostnames: 0 })).toBe(
      '2 secrets and 1 token',
    );
    expect(redactionSummary({ secrets: 0, tokens: 0, ips: 0, hostnames: 0 })).toBeNull();
    i18n.setLocale('tr', false);
    expect(redactionSummary({ secrets: 0, tokens: 1, ips: 3, hostnames: 0 })).toBe(
      '1 token ve 3 IP adresi',
    );
  });
  it('formats usage with known cost, without a price and for local models', () => {
    i18n.setLocale('en', false);
    const usage = {
      input_tokens: 1234,
      output_tokens: 567,
      cache_read_tokens: 890,
      cache_write_tokens: 0,
    };
    expect(usageSummary(usage, 0.012, false)).toBe('1,234 in · 567 out · 890 cached · $0.012');
    expect(usageSummary(usage, null, false)).toBe('1,234 in · 567 out · 890 cached');
    expect(usageSummary(usage, null, true)).toBe('1,234 in · 567 out · local');
  });
});
