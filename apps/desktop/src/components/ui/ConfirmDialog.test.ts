import { describe, expect, it } from 'vitest';
import { confirmWordMatches } from './ConfirmDialog';

describe('confirmWordMatches', () => {
  it('accepts the exact word', () => {
    expect(confirmWordMatches('web-prod', 'web-prod')).toBe(true);
  });

  it('trims surrounding whitespace the user typed', () => {
    expect(confirmWordMatches('  web-prod \n', 'web-prod')).toBe(true);
  });

  it('rejects case differences — Kubernetes names are case-sensitive', () => {
    expect(confirmWordMatches('Web-Prod', 'web-prod')).toBe(false);
  });

  it('rejects partial matches and extra characters', () => {
    expect(confirmWordMatches('web', 'web-prod')).toBe(false);
    expect(confirmWordMatches('web-prod-2', 'web-prod')).toBe(false);
  });

  it('rejects an empty input', () => {
    expect(confirmWordMatches('', 'web-prod')).toBe(false);
    expect(confirmWordMatches('   ', 'web-prod')).toBe(false);
  });
});
