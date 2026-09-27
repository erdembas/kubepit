/**
 * Split layout of tabbed panes, shared by the main area (cluster and app
 * tabs) and every cluster workbench (view tabs): panes with their own tabs
 * (`groups`), arranged by a tree of nested row and column splits (`root`)
 * whose leaves are the panes, so any pane can split on either axis. A tab
 * key lives in at most one pane; `focused` is the pane new tabs open into.
 * Pure helpers; the edits that depend on the surface's rules come from
 * `createLayoutOps`.
 */

export type TabKey = string;
export type SplitSide = 'left' | 'right' | 'top' | 'bottom';
export type SplitOrientation = 'row' | 'column';

export interface TabGroup {
  id: string;
  tabs: TabKey[];
  /** Null only while a pane opened empty by "split" has no tab yet. */
  active: TabKey | null;
}

/** A leaf of the split tree: the pane `groups` holds under the same id. */
export interface PaneNode {
  type: 'pane';
  id: string;
  /** Relative size along the parent split's axis (flex grow). */
  size: number;
}

/**
 * Children side by side (`row`) or stacked (`column`). Normalised by
 * `finish`: at least two children and never a child split on its own axis.
 */
export interface SplitNode {
  type: 'split';
  id: string;
  orientation: SplitOrientation;
  size: number;
  children: LayoutNode[];
}

export type LayoutNode = PaneNode | SplitNode;

export interface SplitLayout {
  /** Panes in reading order (the tree's leaf order). */
  groups: TabGroup[];
  root: LayoutNode;
  focused: string;
}

/** A layout persisted before splits could nest: one row or column of sized panes. */
export interface FlatLayout {
  groups: (TabGroup & { size?: number })[];
  focused: string;
  orientation?: SplitOrientation;
}

export interface LayoutRules {
  /** Tab a lone empty pane falls back to. */
  home: TabKey;
  /** The home tab can never close: when it goes missing it returns to the first pane. */
  homeRequired?: boolean;
  /** Where a newly opened tab lands in the focused pane (default: after the active tab). */
  insert?: 'after-active' | 'end';
}

export const MAX_PANES = 4;

let seq = 0;
/** Pane and split ids share one namespace: `resizePanes` sizes either by id. */
const newId = (prefix: 'g' | 's') => `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}`;
const pane = (id: string, size = 1): PaneNode => ({ type: 'pane', id, size });

/** Pane ids in reading order. */
export function paneIds(node: LayoutNode): string[] {
  return node.type === 'pane' ? [node.id] : node.children.flatMap(paneIds);
}

/** Axis of the split directly holding pane `groupId`; null for a lone pane. */
export function paneAxis(layout: SplitLayout, groupId: string): SplitOrientation | null {
  const find = (node: LayoutNode): SplitOrientation | null => {
    if (node.type === 'pane') return null;
    if (node.children.some((c) => c.type === 'pane' && c.id === groupId)) return node.orientation;
    for (const child of node.children) {
      const axis = find(child);
      if (axis) return axis;
    }
    return null;
  };
  return find(layout.root);
}

export function groupOf(layout: SplitLayout, key: TabKey): TabGroup | null {
  return layout.groups.find((g) => g.tabs.includes(key)) ?? null;
}

export function focusedGroup(layout: SplitLayout): TabGroup {
  return layout.groups.find((g) => g.id === layout.focused) ?? layout.groups[0]!;
}

export function openKeys(layout: SplitLayout): Set<TabKey> {
  return new Set(layout.groups.flatMap((g) => g.tabs));
}

/** Replace the tab order of one pane (same tabs, e.g. a reorder); focus and active stay. */
export function withPaneTabs(layout: SplitLayout, groupId: string, tabs: TabKey[]): SplitLayout {
  return {
    ...layout,
    groups: layout.groups.map((g) => (g.id === groupId ? { ...g, tabs } : g)),
  };
}

/**
 * Sides a new pane may open on beside `groupId`, carrying `key` when given.
 * Any pane splits on either axis until `MAX_PANES`; a pane's only tab
 * cannot split off its own pane.
 */
export function splitSides(
  layout: SplitLayout,
  groupId: string,
  key: TabKey | null = null,
): SplitSide[] {
  if (layout.groups.length >= MAX_PANES) return [];
  const src = key ? groupOf(layout, key) : null;
  if (src && src.id === groupId && src.tabs.length === 1) return [];
  return ['left', 'right', 'top', 'bottom'];
}

export function focusPane(layout: SplitLayout, groupId: string): SplitLayout {
  return layout.focused === groupId || !layout.groups.some((g) => g.id === groupId)
    ? layout
    : { ...layout, focused: groupId };
}

/** Set the relative size of tree nodes (panes or splits) by id. */
export function resizePanes(layout: SplitLayout, sizes: Record<string, number>): SplitLayout {
  const resize = (node: LayoutNode): LayoutNode => {
    const next = node.id in sizes ? { ...node, size: sizes[node.id]! } : node;
    return next.type === 'split' ? { ...next, children: next.children.map(resize) } : next;
  };
  return { ...layout, root: resize(layout.root) };
}

/** Remove `keys` from a pane; a removed active tab hands over to its right, else left, neighbour. */
function without(group: TabGroup, keys: ReadonlySet<TabKey>): TabGroup {
  const tabs = group.tabs.filter((k) => !keys.has(k));
  let active = group.active;
  if (active && keys.has(active)) {
    const at = group.tabs.indexOf(active);
    active =
      group.tabs.slice(at + 1).find((k) => !keys.has(k)) ??
      group.tabs
        .slice(0, at)
        .reverse()
        .find((k) => !keys.has(k)) ??
      null;
  }
  return { ...group, tabs, active };
}

/**
 * Drop the panes not in `keep`, then normalise: a split left with one child
 * becomes that child, and a child split on its parent's axis folds into the
 * parent (its children share out its size).
 */
function prune(node: LayoutNode, keep: ReadonlySet<string>): LayoutNode | null {
  if (node.type === 'pane') return keep.has(node.id) ? node : null;
  const children: LayoutNode[] = [];
  for (const child of node.children) {
    const next = prune(child, keep);
    if (!next) continue;
    if (next.type === 'split' && next.orientation === node.orientation) {
      const total = next.children.reduce((n, c) => n + c.size, 0);
      for (const c of next.children) children.push({ ...c, size: (c.size / total) * next.size });
    } else {
      children.push(next);
    }
  }
  if (!children.length) return null;
  if (children.length === 1) return { ...children[0]!, size: node.size };
  return { ...node, children };
}

/**
 * Put pane `id` beside pane `target`: inside the target's split when that
 * runs on `orientation` (halving the target's share), otherwise in a new
 * split that takes the target's place.
 */
function insertBeside(
  node: LayoutNode,
  target: string,
  id: string,
  orientation: SplitOrientation,
  before: boolean,
): LayoutNode {
  if (node.type === 'pane') {
    if (node.id !== target) return node;
    const pair = before ? [pane(id), pane(target)] : [pane(target), pane(id)];
    return { type: 'split', id: newId('s'), orientation, size: node.size, children: pair };
  }
  const at = node.children.findIndex((c) => c.type === 'pane' && c.id === target);
  if (at >= 0 && node.orientation === orientation) {
    const half = node.children[at]!.size / 2;
    const pair = before
      ? [pane(id, half), pane(target, half)]
      : [pane(target, half), pane(id, half)];
    const children = [...node.children];
    children.splice(at, 1, ...pair);
    return { ...node, children };
  }
  return {
    ...node,
    children: node.children.map((c) => insertBeside(c, target, id, orientation, before)),
  };
}

/** The edits whose outcome depends on a surface's `rules`. */
export function createLayoutOps(rules: LayoutRules) {
  const { home } = rules;

  /**
   * Restore the invariants after an edit: panes listed in `emptied` that
   * lost their last tab disappear (and the tree closes up around them), a
   * lone empty pane shows the home tab, a required home tab is back in the
   * first pane, every pane's active tab is one of its tabs, `groups` follows
   * reading order and a removed focused pane hands focus to its previous
   * neighbour.
   */
  function finish(layout: SplitLayout, emptied: readonly string[] = []): SplitLayout {
    const order = paneIds(layout.root);
    const byId = new Map(layout.groups.map((g) => [g.id, g]));
    let groups = order
      .map((id) => byId.get(id))
      .filter((g): g is TabGroup => !!g && (g.tabs.length > 0 || !emptied.includes(g.id)));
    let root = prune(layout.root, new Set(groups.map((g) => g.id)));
    if (!root || !groups.length) {
      const id = order[0] ?? 'main';
      groups = [{ id, tabs: [], active: null }];
      root = pane(id);
    }
    if (groups.length === 1 && !groups[0]!.tabs.length)
      groups = [{ ...groups[0]!, tabs: [home], active: home }];
    if (rules.homeRequired && !groups.some((g) => g.tabs.includes(home))) {
      const [first, ...rest] = groups;
      groups = [{ ...first!, tabs: [home, ...first!.tabs] }, ...rest];
    }
    groups = groups.map((g) =>
      g.active && g.tabs.includes(g.active) ? g : { ...g, active: g.tabs[0] ?? null },
    );
    const kept = new Set(groups.map((g) => g.id));
    let focused = layout.focused;
    if (!kept.has(focused)) {
      const at = order.indexOf(focused);
      focused =
        order
          .slice(0, Math.max(0, at))
          .reverse()
          .find((id) => kept.has(id)) ?? groups[0]!.id;
    }
    return { groups, root, focused };
  }

  /** One pane holding `tabs`; the id is stable so render-time fallbacks stay equal. */
  function singleLayout(active: TabKey = home, tabs: TabKey[] = [active]): SplitLayout {
    const all = tabs.includes(active) ? tabs : [...tabs, active];
    return finish({
      groups: [{ id: 'main', tabs: all, active }],
      root: pane('main'),
      focused: 'main',
    });
  }

  function fromFlatLayout(flat: FlatLayout): SplitLayout {
    const groups = flat.groups.map(({ id, tabs, active }) => ({ id, tabs, active }));
    const root: LayoutNode = {
      type: 'split',
      id: newId('s'),
      orientation: flat.orientation ?? 'row',
      size: 1,
      children: flat.groups.map((g) => pane(g.id, g.size ?? 1)),
    };
    return finish({ groups, root, focused: flat.focused });
  }

  /**
   * Focus `key`: in its own pane when it is open, otherwise it opens in the
   * focused pane (see `rules.insert`). An empty focused pane pulls an
   * already open tab over instead, so "split, then pick one" works.
   */
  function openView(layout: SplitLayout, key: TabKey): SplitLayout {
    const owner = groupOf(layout, key);
    const target = focusedGroup(layout);
    if (owner && (owner.id === target.id || target.tabs.length)) {
      return finish({
        ...layout,
        focused: owner.id,
        groups: layout.groups.map((g) => (g.id === owner.id ? { ...g, active: key } : g)),
      });
    }
    if (owner) return moveView(layout, key, target.id);
    return finish({
      ...layout,
      groups: layout.groups.map((g) => {
        if (g.id !== target.id) return g;
        const tabs = [...g.tabs];
        const at = rules.insert === 'end' || !g.active ? tabs.length : tabs.indexOf(g.active) + 1;
        tabs.splice(at, 0, key);
        return { ...g, tabs, active: key };
      }),
    });
  }

  /** Move `key` into pane `groupId` before `index` (end when omitted) and focus it there. */
  function moveView(
    layout: SplitLayout,
    key: TabKey,
    groupId: string,
    index?: number,
  ): SplitLayout {
    const src = groupOf(layout, key);
    const dst = layout.groups.find((g) => g.id === groupId);
    if (!src || !dst) return layout;
    if (src.id === dst.id) {
      const tabs = [...src.tabs];
      const to = Math.min(index ?? tabs.length - 1, tabs.length - 1);
      tabs.splice(to, 0, ...tabs.splice(tabs.indexOf(key), 1));
      return finish({
        ...layout,
        focused: dst.id,
        groups: layout.groups.map((g) => (g.id === dst.id ? { ...g, tabs, active: key } : g)),
      });
    }
    const groups = layout.groups.map((g) => {
      if (g.id === src.id) return without(g, new Set([key]));
      if (g.id !== dst.id) return g;
      const tabs = [...g.tabs];
      tabs.splice(index ?? tabs.length, 0, key);
      return { ...g, tabs, active: key };
    });
    return finish({ ...layout, groups, focused: dst.id }, [src.id]);
  }

  /** Open a pane beside `groupId`; `key` moves into it, otherwise it starts empty. Focuses it. */
  function splitView(
    layout: SplitLayout,
    groupId: string,
    side: SplitSide,
    key: TabKey | null = null,
  ): SplitLayout {
    if (!layout.groups.some((g) => g.id === groupId)) return layout;
    if (!splitSides(layout, groupId, key).includes(side)) return layout;
    const fresh: TabGroup = { id: newId('g'), tabs: key ? [key] : [], active: key };
    const src = key ? groupOf(layout, key) : null;
    const groups = layout.groups.map((g) =>
      src && key && g.id === src.id ? without(g, new Set([key])) : g,
    );
    const orientation = side === 'left' || side === 'right' ? 'row' : 'column';
    const before = side === 'left' || side === 'top';
    return finish(
      {
        groups: [...groups, fresh],
        root: insertBeside(layout.root, groupId, fresh.id, orientation, before),
        focused: fresh.id,
      },
      src ? [src.id] : [],
    );
  }

  /** Close the tabs `pick` matches in one pane; returns them so their state can be dropped. */
  function closeViews(
    layout: SplitLayout,
    groupId: string,
    pick: (key: TabKey, index: number) => boolean,
  ): { layout: SplitLayout; closed: TabKey[] } {
    const group = layout.groups.find((g) => g.id === groupId);
    const closed = group?.tabs.filter(pick) ?? [];
    if (!closed.length) return { layout, closed };
    const drop = new Set(closed);
    const groups = layout.groups.map((g) => (g.id === groupId ? without(g, drop) : g));
    return { layout: finish({ ...layout, groups }, [groupId]), closed };
  }

  /** Close a pane with all its tabs. */
  function closePane(
    layout: SplitLayout,
    groupId: string,
  ): { layout: SplitLayout; closed: TabKey[] } {
    const group = layout.groups.find((g) => g.id === groupId);
    if (!group) return { layout, closed: [] };
    const groups = layout.groups.map((g) =>
      g.id === groupId ? { ...g, tabs: [], active: null } : g,
    );
    return { layout: finish({ ...layout, groups }, [groupId]), closed: group.tabs };
  }

  return { singleLayout, fromFlatLayout, openView, moveView, splitView, closeViews, closePane };
}
