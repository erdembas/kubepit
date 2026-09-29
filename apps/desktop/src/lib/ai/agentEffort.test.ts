import { describe, expect, it } from 'vitest';
import { agentEffortLevels } from './agentEffort';

describe('native effort presentation', () => {
  it('orders recognized advertised levels without inventing intermediate choices', () => {
    expect(agentEffortLevels(['high', 'minimal', 'high', 'ultra'])).toEqual({
      ordered: true,
      levels: ['minimal', 'high', 'ultra'],
    });
  });
  it('preserves custom variants and their native order instead of assigning a reasoning scale', () => {
    expect(agentEffortLevels(['thinking', 'standard', 'thinking', 'fast'])).toEqual({
      ordered: false,
      levels: ['thinking', 'standard', 'fast'],
    });
    expect(agentEffortLevels(['high', 'experimental'])).toEqual({
      ordered: false,
      levels: ['high', 'experimental'],
    });
  });
  it('has no choices when the native model advertises none', () => {
    expect(agentEffortLevels(['', ''])).toEqual({ ordered: false, levels: [] });
  });
});
