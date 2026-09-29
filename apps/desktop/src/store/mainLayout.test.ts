import { beforeEach, describe, expect, it } from 'vitest';
import { mainLayouts } from './mainLayout';
import { AI_GUIDE_TAB_KEY, DASHBOARD_TAB_KEY } from './types';
import { useAppStore } from './useAppStore';

beforeEach(() => {
  useAppStore.setState({
    clusters: [],
    settings: null,
    selectedClusterId: null,
    pinnedMainTabKeys: [],
  });
  useAppStore.getState().hydrateMainLayout(mainLayouts.singleLayout());
});

describe('AI guide main tab', () => {
  it('opens once without a cluster or configured assistant', () => {
    useAppStore.getState().openMainTab({ kind: 'ai-guide' });
    useAppStore.getState().openMainTab({ kind: 'ai-guide' });

    const state = useAppStore.getState();
    expect(state.mainTabs).toEqual([{ kind: 'dashboard' }, { kind: 'ai-guide' }]);
    expect(state.activeMainTabKey).toBe(AI_GUIDE_TAB_KEY);
    expect(state.selectedClusterId).toBeNull();
  });

  it('restores the guide in a duplicated window and closes back to the dashboard', () => {
    const seed = JSON.parse(
      JSON.stringify(
        mainLayouts.singleLayout(AI_GUIDE_TAB_KEY, [DASHBOARD_TAB_KEY, AI_GUIDE_TAB_KEY]),
      ),
    );
    useAppStore.getState().hydrateMainLayout(seed);

    expect(useAppStore.getState().mainTabs).toEqual([{ kind: 'dashboard' }, { kind: 'ai-guide' }]);
    expect(useAppStore.getState().activeMainTabKey).toBe(AI_GUIDE_TAB_KEY);

    useAppStore.getState().closeMainTab(AI_GUIDE_TAB_KEY);
    expect(useAppStore.getState().mainTabs).toEqual([{ kind: 'dashboard' }]);
    expect(useAppStore.getState().activeMainTabKey).toBe(DASHBOARD_TAB_KEY);
  });
});
