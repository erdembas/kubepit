import { describe, expect, it } from 'vitest';
import { VIEW_KEYS } from '@/lib/kube/nav';
import { DASHBOARD_TAB_KEY } from '@/store/types';
import { singleLayout, splitView } from '@/store/viewLayout';
import { closeTarget, type CloseContext } from './closeTarget';

const OVERVIEW = VIEW_KEYS.clusterOverview;
const CLUSTER = 'cluster:c1';

function ctx(patch: Partial<CloseContext> = {}): CloseContext {
  return { mainTab: CLUSTER, mainPane: 'main', whole: false, dock: null, views: null, ...patch };
}

const dock = { tabs: [{ id: 't1' }, { id: 't2' }], activeId: 't2', open: true };

describe('closeTarget', () => {
  it('leaves the dashboard to the native Close Window', () => {
    expect(closeTarget(ctx({ mainTab: DASHBOARD_TAB_KEY }))).toBeNull();
    expect(closeTarget(ctx({ mainTab: DASHBOARD_TAB_KEY, whole: true }))).toBeNull();
  });

  it('closes an empty main pane', () => {
    expect(closeTarget(ctx({ mainTab: '', mainPane: 'g2' }))).toEqual({
      kind: 'main-pane',
      paneId: 'g2',
    });
  });

  it('closes the focused dock tab first', () => {
    const views = singleLayout('pods', [OVERVIEW, 'pods']);
    expect(closeTarget(ctx({ dock, views }))).toEqual({
      kind: 'dock-tab',
      clusterId: 'c1',
      tabId: 't2',
    });
  });

  it('skips a minimized or empty dock', () => {
    const views = singleLayout('pods', [OVERVIEW, 'pods']);
    const viewTab = { kind: 'view-tab', clusterId: 'c1', key: 'pods' };
    expect(closeTarget(ctx({ dock: { ...dock, open: false }, views }))).toEqual(viewTab);
    expect(closeTarget(ctx({ dock: { tabs: [], activeId: null, open: true }, views }))).toEqual(
      viewTab,
    );
  });

  it('closes the active view tab of the focused pane', () => {
    const views = singleLayout(OVERVIEW, [OVERVIEW, 'pods']);
    expect(closeTarget(ctx({ views }))).toEqual({
      kind: 'view-tab',
      clusterId: 'c1',
      key: OVERVIEW,
    });
    expect(closeTarget(ctx({ views: singleLayout('pods') }))).toEqual({
      kind: 'view-tab',
      clusterId: 'c1',
      key: 'pods',
    });
  });

  it('closes an empty split pane of the workbench', () => {
    const views = splitView(singleLayout(OVERVIEW), 'main', 'right');
    const pane = views.groups.find((g) => g.id === views.focused)!;
    expect(pane.active).toBeNull();
    expect(closeTarget(ctx({ views }))).toEqual({
      kind: 'view-pane',
      clusterId: 'c1',
      paneId: pane.id,
    });
  });

  it('closes the cluster once only the overview is left', () => {
    expect(closeTarget(ctx({ views: singleLayout(OVERVIEW) }))).toEqual({
      kind: 'main-tab',
      key: CLUSTER,
    });
  });

  it('closes the cluster while it is disconnected (no views shown)', () => {
    expect(closeTarget(ctx())).toEqual({ kind: 'main-tab', key: CLUSTER });
  });

  it('closes the main tab directly with ⌘⇧W', () => {
    const views = singleLayout('pods', [OVERVIEW, 'pods']);
    expect(closeTarget(ctx({ whole: true, dock, views }))).toEqual({
      kind: 'main-tab',
      key: CLUSTER,
    });
  });

  it('closes other main tabs directly', () => {
    expect(closeTarget(ctx({ mainTab: 'settings:settings' }))).toEqual({
      kind: 'main-tab',
      key: 'settings:settings',
    });
  });
});
