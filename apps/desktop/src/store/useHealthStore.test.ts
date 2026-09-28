import { beforeEach, describe, expect, it } from 'vitest';
import { useHealthStore } from './useHealthStore';

describe('health opt-ins', () => {
  beforeEach(() => useHealthStore.setState({ optIns: {} }));
  it('hydrateOptIns tolerates legacy and malformed snapshots', () => {
    useHealthStore.getState().hydrateOptIns(undefined);
    expect(useHealthStore.getState().optIns).toEqual({});
    useHealthStore.getState().hydrateOptIns({ c1: ['a', 3, null], c2: 'x', c3: [] });
    expect(useHealthStore.getState().optIns).toEqual({ c1: ['a'] });
  });
  it('setOptIn toggles one rule per cluster', () => {
    const { setOptIn } = useHealthStore.getState();
    setOptIn('c1', 'r', true);
    setOptIn('c1', 'r', true);
    expect(useHealthStore.getState().optIns).toEqual({ c1: ['r'] });
    setOptIn('c1', 'r', false);
    expect(useHealthStore.getState().optIns).toEqual({});
  });
});
