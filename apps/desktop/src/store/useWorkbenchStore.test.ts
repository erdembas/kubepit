import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { kindKey } from '@/lib/kube/catalog';
import type { Gvk } from '@/types';
import { navigateTo, useWorkbenchStore, VIEW, viewLayoutOf } from './useWorkbenchStore';
import * as layouts from './viewLayout';

const cluster = 'test-cluster';
const pods: Gvk = { group: '', version: 'v1', kind: 'Pod', plural: 'pods', namespaced: true };
const podKey = kindKey(pods);

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  useWorkbenchStore.setState(useWorkbenchStore.getInitialState(), true);
});

afterEach(() => vi.unstubAllGlobals());

const state = () => useWorkbenchStore.getState();
const tabs = () => layouts.focusedGroup(viewLayoutOf(cluster)).tabs;

function start(keys: string[], active = keys[0]!) {
  useWorkbenchStore.setState({
    layouts: { [cluster]: layouts.singleLayout(active, keys) },
    activeKind: { [cluster]: active },
  });
}

describe('view tab reveal requests', () => {
  it('reveals an already active tab again without requesting another object navigation', () => {
    state().setActiveKind(cluster, podKey);
    state().select(cluster, podKey, { key: podKey, namespace: 'demo', name: 'example' });
    state().setActiveKind(cluster, podKey);

    expect(state().viewRevealRevision[`${cluster}|${podKey}`]).toBe(2);
    expect(state().navRevision).toEqual({});
    expect(state().selection[cluster]?.[podKey]?.name).toBe('example');
    expect(tabs().filter((key) => key === podKey)).toHaveLength(1);
  });

  it('reveals programmatic navigation repeatedly and keeps requests scoped to the cluster', () => {
    navigateTo(cluster, pods, 'demo', 'example');
    navigateTo(cluster, pods, 'demo', 'example');
    state().setActiveKind('another-cluster', podKey);

    expect(state().viewRevealRevision).toEqual({
      [`${cluster}|${podKey}`]: 2,
      [`another-cluster|${podKey}`]: 1,
    });
    expect(state().navRevision[`${cluster}|${podKey}`]).toBe(2);
  });
});

describe('ephemeral preview tabs', () => {
  const svc: Gvk = { group: '', version: 'v1', kind: 'Service', plural: 'services', namespaced: true };
  const svcKey = kindKey(svc);

  it('reuses one preview tab while browsing and drops the replaced tab state', () => {
    state().setActiveKind(cluster, podKey, { preview: true });
    state().select(cluster, podKey, { key: podKey, namespace: 'demo', name: 'a' });
    state().setActiveKind(cluster, svcKey, { preview: true });

    expect(tabs()).toEqual([VIEW.clusterOverview, svcKey]);
    expect(state().previewTabKeys[cluster]).toBe(svcKey);
    expect(state().selection[cluster]?.[podKey]).toBeUndefined();
    expect(state().activeKind[cluster]).toBe(svcKey);
  });

  it('keeps the preview tab when the same kind is previewed again', () => {
    state().setActiveKind(cluster, podKey, { preview: true });
    state().select(cluster, podKey, { key: podKey, namespace: 'demo', name: 'a' });
    state().setActiveKind(cluster, podKey, { preview: true });

    expect(tabs()).toEqual([VIEW.clusterOverview, podKey]);
    expect(state().selection[cluster]?.[podKey]?.name).toBe('a');
    expect(state().previewTabKeys[cluster]).toBe(podKey);
  });

  it('promotes the preview tab on keep, pin, split, drag and persistent open', () => {
    state().setActiveKind(cluster, podKey, { preview: true });
    state().keepPreviewTab(cluster);
    expect(state().previewTabKeys[cluster]).toBeNull();

    state().setActiveKind(cluster, svcKey, { preview: true });
    state().toggleTabPin(cluster, svcKey);
    expect(state().previewTabKeys[cluster]).toBeNull();

    state().toggleTabPin(cluster, svcKey);
    state().setActiveKind(cluster, svcKey, { preview: true });
    state().splitPane(cluster, 'main', 'right', svcKey);
    expect(state().previewTabKeys[cluster]).toBeNull();

    state().closePane(cluster, layouts.focusedGroup(viewLayoutOf(cluster)).id);
    state().setActiveKind(cluster, svcKey, { preview: true });
    state().moveTab(cluster, svcKey, 'main', 0);
    expect(state().previewTabKeys[cluster]).toBeNull();

    state().setActiveKind(cluster, podKey, { preview: true });
    state().setActiveKind(cluster, svcKey, { preview: false });
    expect(state().previewTabKeys[cluster]).toBeNull();
    expect(tabs()).toEqual([svcKey, VIEW.clusterOverview, podKey]);
  });

  it('leaves the preview tab ephemeral when another open tab is focused', () => {
    state().setActiveKind(cluster, podKey, { preview: true });
    state().setActiveKind(cluster, svcKey, { preview: false });
    // podKey became permanent above; open a fresh preview and focus svcKey.
    state().setActiveKind(cluster, podKey, { preview: true });
    state().setActiveKind(cluster, svcKey);

    expect(state().previewTabKeys[cluster]).toBe(podKey);
  });

  it('clears the preview mark when the tab closes', () => {
    state().setActiveKind(cluster, podKey, { preview: true });
    state().closeTab(cluster, podKey);

    expect(state().previewTabKeys[cluster]).toBeUndefined();
  });

  it('never persists the preview tab state', () => {
    state().setActiveKind(cluster, podKey, { preview: true });
    const saved = JSON.parse(localStorage.getItem('kubepit.workbench.v1')!);

    expect(saved.state.previewTabKeys).toBeUndefined();
  });

  it('keeps preview tabs per cluster', () => {
    state().setActiveKind(cluster, podKey, { preview: true });
    state().setActiveKind('another-cluster', svcKey, { preview: true });

    expect(state().previewTabKeys).toEqual({
      [cluster]: podKey,
      'another-cluster': svcKey,
    });
  });
});

describe('view tab pins and ordering', () => {
  it('pins at the end of the pinned group and unpins at the start of unpinned tabs', () => {
    start(['a', 'b', 'c', 'd'], 'd');
    state().toggleTabPin(cluster, 'c');
    state().toggleTabPin(cluster, 'b');
    expect(tabs()).toEqual(['c', 'b', 'a', 'd']);

    state().toggleTabPin(cluster, 'c');
    expect(tabs()).toEqual(['b', 'c', 'a', 'd']);
    expect(state().pinnedTabKeys[cluster]).toEqual(['b']);
    expect(state().activeKind[cluster]).toBe('d');
  });

  it('limits pins to three across every pane of a cluster without moving the fourth tab', () => {
    start(['a', 'b', 'c', 'd']);
    state().splitPane(cluster, 'main', 'right', 'd');
    for (const key of ['a', 'b', 'c']) state().toggleTabPin(cluster, key);
    const before = viewLayoutOf(cluster);

    state().toggleTabPin(cluster, 'd');

    expect(state().pinnedTabKeys[cluster]).toEqual(['a', 'b', 'c']);
    expect(viewLayoutOf(cluster)).toBe(before);
    expect(state().activeKind[cluster]).toBe('d');
  });

  it.each(['unpin', 'close'] as const)('frees a pin slot after %s', (action) => {
    start(['a', 'b', 'c', 'd']);
    for (const key of ['a', 'b', 'c']) state().toggleTabPin(cluster, key);
    if (action === 'unpin') state().toggleTabPin(cluster, 'b');
    else state().closeTab(cluster, 'b');

    state().toggleTabPin(cluster, 'd');

    expect(state().pinnedTabKeys[cluster]).toEqual(['a', 'c', 'd']);
    expect(tabs()).toEqual(action === 'unpin' ? ['a', 'c', 'd', 'b'] : ['a', 'c', 'd']);
  });

  it('keeps the three pin slots independent between clusters', () => {
    for (const clusterId of [cluster, 'another-cluster']) {
      for (const key of ['a', 'b', 'c']) {
        state().setActiveKind(clusterId, key);
        state().toggleTabPin(clusterId, key);
      }
    }

    expect(state().pinnedTabKeys).toEqual({
      [cluster]: ['a', 'b', 'c'],
      'another-cluster': ['a', 'b', 'c'],
    });
  });

  it('opens a new view after all pins even when the first pin is active', () => {
    start(['a', 'b', 'c']);
    state().toggleTabPin(cluster, 'a');
    state().toggleTabPin(cluster, 'b');
    state().setActiveKind(cluster, 'a');
    state().setActiveKind(cluster, 'new');

    expect(tabs()).toEqual(['a', 'b', 'new', 'c']);
  });

  it('moves unpinned views left and right without crossing pins or changing active view', () => {
    start(['a', 'b', 'c', 'd'], 'a');
    state().toggleTabPin(cluster, 'a');
    state().moveTabLeft(cluster, 'c');
    expect(tabs()).toEqual(['a', 'c', 'b', 'd']);
    state().moveTabLeft(cluster, 'c');
    state().moveTabRight(cluster, 'a');
    expect(tabs()).toEqual(['a', 'c', 'b', 'd']);
    state().moveTabRight(cluster, 'c');
    expect(tabs()).toEqual(['a', 'b', 'c', 'd']);
    expect(state().activeKind[cluster]).toBe('a');
  });

  it('blocks dragging and splitting pinned views, and clamps unpinned drops after pins', () => {
    start(['a', 'b', 'c']);
    state().toggleTabPin(cluster, 'a');
    const before = viewLayoutOf(cluster);
    state().moveTab(cluster, 'a', 'main', 2);
    state().splitPane(cluster, 'main', 'right', 'a');
    expect(viewLayoutOf(cluster)).toBe(before);

    state().moveTab(cluster, 'c', 'main', 0);
    expect(tabs()).toEqual(['a', 'c', 'b']);
    state().splitPane(cluster, 'main', 'right', 'c');
    const source = layouts.groupOf(viewLayoutOf(cluster), 'c')!.id;
    state().moveTab(cluster, 'c', 'main', -10);
    expect(tabs()).toEqual(['a', 'c', 'b']);
    expect(viewLayoutOf(cluster).groups.some((pane) => pane.id === source)).toBe(false);
  });

  it('focuses a pinned view in its own pane when an empty split is focused', () => {
    start(['a', 'b']);
    state().toggleTabPin(cluster, 'a');
    state().splitPane(cluster, 'main', 'right');
    const empty = layouts.focusedGroup(viewLayoutOf(cluster)).id;
    state().setActiveKind(cluster, 'a');

    expect(viewLayoutOf(cluster).focused).toBe('main');
    expect(layouts.groupOf(viewLayoutOf(cluster), 'a')?.id).toBe('main');
    expect(viewLayoutOf(cluster).groups.find((pane) => pane.id === empty)?.tabs).toEqual([]);
  });

  it.each(['others', 'right', 'all'] as const)('preserves pins when closing %s tabs', (action) => {
    start(['a', 'b', 'c', 'd']);
    state().toggleTabPin(cluster, 'a');
    state().toggleTabPin(cluster, 'b');
    if (action === 'others') state().closeOtherTabs(cluster, 'c');
    else if (action === 'right') state().closeTabsToRight(cluster, 'a');
    else state().closeAllTabs(cluster, 'main');

    expect(tabs()).toEqual(action === 'others' ? ['a', 'b', 'c'] : ['a', 'b']);
    expect(state().pinnedTabKeys[cluster]).toEqual(['a', 'b']);
  });

  it('explicitly closing a pinned tab clears its pin, details, filter and reveal request', () => {
    start(['a', 'b']);
    state().toggleTabPin(cluster, 'a');
    state().setActiveKind(cluster, 'a');
    state().select(cluster, 'a', { key: 'a', namespace: null, name: 'selected' });
    state().setFilter(cluster, 'a', 'filter');
    state().closeTab(cluster, 'a');

    expect(tabs()).toEqual(['b']);
    expect(state().pinnedTabKeys[cluster]).toBeUndefined();
    expect(state().selection[cluster]?.a).toBeUndefined();
    expect(state().filters[`${cluster}|a`]).toBeUndefined();
    expect(state().viewRevealRevision[`${cluster}|a`]).toBeUndefined();
    state().setActiveKind(cluster, 'a');
    expect(state().pinnedTabKeys[cluster]).toBeUndefined();
  });

  it('moves all three pins to the neighbouring pane when their pane closes', () => {
    start(['a', 'b', 'c', 'd', 'e']);
    state().splitPane(cluster, 'main', 'right', 'c');
    const second = layouts.groupOf(viewLayoutOf(cluster), 'c')!.id;
    state().moveTab(cluster, 'd', second);
    state().moveTab(cluster, 'e', second);
    state().toggleTabPin(cluster, 'a');
    state().toggleTabPin(cluster, 'c');
    state().toggleTabPin(cluster, 'd');
    state().select(cluster, 'c', { key: 'c', namespace: null, name: 'kept' });
    state().select(cluster, 'd', { key: 'd', namespace: null, name: 'also-kept' });
    state().select(cluster, 'e', { key: 'e', namespace: null, name: 'closed' });
    state().closePane(cluster, second);

    expect(viewLayoutOf(cluster).groups).toHaveLength(1);
    expect(tabs()).toEqual(['a', 'c', 'd', 'b']);
    expect(state().pinnedTabKeys[cluster]).toEqual(['a', 'c', 'd']);
    expect(state().selection[cluster]?.c?.name).toBe('kept');
    expect(state().selection[cluster]?.d?.name).toBe('also-kept');
    expect(state().selection[cluster]?.e).toBeUndefined();
  });

  it('preserves the last pane pin and disconnecting keeps the saved tab session', () => {
    start(['a', 'b']);
    state().toggleTabPin(cluster, 'a');
    state().setActiveKind(cluster, 'a');
    state().setActiveKind('another-cluster', 'a');
    state().closePane(cluster, 'main');
    state().forgetCluster(cluster);

    expect(tabs()).toEqual(['a']);
    expect(state().pinnedTabKeys[cluster]).toEqual(['a']);
    expect(state().viewRevealRevision[`${cluster}|a`]).toBeUndefined();
    expect(state().viewRevealRevision['another-cluster|a']).toBe(1);
  });
});

describe('view tab session persistence', () => {
  it.each([1, 2, 3])(
    'migrates a v%s session without changing its active view or namespaces',
    async (version) => {
      const layout = layouts.singleLayout('b', ['a', 'b']);
      const saved = {
        activeKind: { [cluster]: 'b' },
        namespaces: { [cluster]: ['demo'] },
        // windowStorage can combine an older secondary session with main's new pins.
        pinnedTabKeys: { [cluster]: ['a'] },
        ...(version === 1
          ? { tabs: { [cluster]: ['a', 'b'] } }
          : {
              layouts: {
                [cluster]: version === 2 ? { groups: layout.groups, focused: 'main' } : layout,
              },
            }),
      };
      const options = useWorkbenchStore.persist.getOptions();
      const migrated = await options.migrate!(saved, version);
      const restored = options.merge!(migrated, state());

      expect(restored.layouts[cluster]?.groups[0]?.tabs).toEqual(['a', 'b']);
      expect(restored.activeKind[cluster]).toBe('b');
      expect(restored.namespaces[cluster]).toEqual(['demo']);
      expect(restored.pinnedTabKeys).toEqual({});
    },
  );

  it('restores pins once at the beginning of each pane and drops closed or invalid pins', () => {
    const options = useWorkbenchStore.persist.getOptions();
    const restored = options.merge!(
      {
        layouts: { [cluster]: layouts.singleLayout('a', ['a', 'b', 'c']) },
        activeKind: { [cluster]: 'a' },
        pinnedTabKeys: { [cluster]: ['c', 'c', 'closed', 12], missing: ['a'] },
      },
      state(),
    );

    expect(restored.layouts[cluster]?.groups[0]?.tabs).toEqual(['c', 'a', 'b']);
    expect(restored.activeKind[cluster]).toBe('a');
    expect(restored.pinnedTabKeys).toEqual({ [cluster]: ['c'] });
  });

  it('restores only the first three valid unique pins from an older session and keeps excess tabs open', () => {
    const layout = layouts.splitView(
      layouts.singleLayout('a', ['a', 'b', 'c', 'd', 'e']),
      'main',
      'right',
      'e',
    );
    const options = useWorkbenchStore.persist.getOptions();
    const restored = options.merge!(
      {
        layouts: { [cluster]: layout },
        activeKind: { [cluster]: 'e' },
        pinnedTabKeys: { [cluster]: ['closed', 'd', 'd', 12, 'e', 'b', 'a', 'c'] },
      },
      state(),
    );

    expect(restored.pinnedTabKeys[cluster]).toEqual(['d', 'e', 'b']);
    expect(restored.layouts[cluster]?.groups[0]?.tabs).toEqual(['b', 'd', 'a', 'c']);
    expect(layouts.openKeys(restored.layouts[cluster]!)).toEqual(
      new Set(['a', 'b', 'c', 'd', 'e']),
    );
    expect(restored.activeKind[cluster]).toBe('e');
    expect(restored.layouts[cluster]?.groups[1]?.tabs).toEqual(['e']);
  });

  it('normalizes excess pins on layout updates without discarding their tab data', () => {
    start(['a', 'b', 'c', 'd']);
    useWorkbenchStore.setState({ pinnedTabKeys: { [cluster]: ['d', 'c', 'b', 'a'] } });
    state().select(cluster, 'a', { key: 'a', namespace: null, name: 'kept' });
    state().setFilter(cluster, 'a', 'filter');

    state().resizePanes(cluster, {});

    expect(state().pinnedTabKeys[cluster]).toEqual(['d', 'c', 'b']);
    expect(tabs()).toEqual(['b', 'c', 'd', 'a']);
    expect(state().selection[cluster]?.a?.name).toBe('kept');
    expect(state().filters[`${cluster}|a`]).toBe('filter');
  });

  it('persists pin state but never persists reveal requests or object selections', () => {
    state().setActiveKind(cluster, VIEW.upgradeReadiness);
    state().toggleTabPin(cluster, VIEW.upgradeReadiness);
    state().select(cluster, VIEW.upgradeReadiness, { key: 'test', namespace: null, name: 'test' });
    const saved = JSON.parse(localStorage.getItem('kubepit.workbench.v1')!);

    expect(saved.version).toBe(4);
    expect(saved.state.pinnedTabKeys).toEqual({ [cluster]: [VIEW.upgradeReadiness] });
    expect(saved.state.viewRevealRevision).toBeUndefined();
    expect(saved.state.selection).toBeUndefined();
    expect(saved.state.navRevision).toBeUndefined();
  });
});
