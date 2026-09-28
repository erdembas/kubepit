import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { usePaneFocused } from '@/components/split/paneFocus';
import { useAppStore } from '@/store/useAppStore';
import { useWorkbenchStore } from '@/store/useWorkbenchStore';
import type { ClusterId, Gvk, KubeObject } from '@/types';
import type { Anchor } from '../actions/podActions';

/**
 * The focused resource table as seen by the keyboard: the one table that is
 * active in the focused pane registers a controller here. The keyboard host
 * (k9s-style keys, custom action shortcuts) and the command palette act on
 * it; the table keeps rendering exactly as before.
 */
export interface TableController {
  clusterId: ClusterId;
  kindKey: string;
  gvk: Gvk;
  /** The object keys act on: the details selection, else the keyboard cursor. */
  current: () => KubeObject | null;
  /** Checked rows the filter still shows. */
  checked: () => KubeObject[];
  move: (to: 'up' | 'down' | 'top' | 'bottom') => void;
  /** Open the details of the cursor row (or `obj`). */
  open: (obj?: KubeObject) => void;
  hasDetails: () => boolean;
  focusFilter: () => void;
  /** Clears a non-empty filter; false when there was none. */
  clearFilter: () => boolean;
  /** Where menus for `obj` open (below its row). */
  anchor: (obj: KubeObject) => Anchor;
}

interface State {
  controller: TableController | null;
  register: (controller: TableController) => void;
  unregister: (controller: TableController) => void;
}

export const useTableKeyboard = create<State>((set) => ({
  controller: null,
  register: (controller) => set({ controller }),
  unregister: (controller) => set((s) => (s.controller === controller ? { controller: null } : s)),
}));

export function useKeyboardMode(): boolean {
  return useAppStore((s) => s.settings?.keyboard_mode ?? false);
}

/**
 * Registers the table while it is active in the focused pane and keeps a
 * keyboard cursor (shown only in keyboard mode). Returns the cursor row and
 * a ref for the table's filter input.
 */
export function useTableKeys({
  clusterId,
  kindKey,
  gvk,
  items,
  selectedObj,
  checked,
  onOpen,
  isActive,
}: {
  clusterId: ClusterId;
  kindKey: string;
  gvk: Gvk;
  items: KubeObject[];
  selectedObj: KubeObject | null;
  checked: KubeObject[];
  onOpen: (obj: KubeObject) => void;
  isActive: boolean;
}) {
  const keyboardMode = useKeyboardMode();
  const paneFocused = usePaneFocused();
  const [cursor, setCursor] = useState<string | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const latest = useRef({ items, selectedObj, checked, onOpen, cursor, gvk, keyboardMode });
  latest.current = { items, selectedObj, checked, onOpen, cursor, gvk, keyboardMode };

  // The cursor follows the details selection (clicks, arrow keys, links).
  const selectedUid = selectedObj?.metadata.uid ?? null;
  useEffect(() => {
    if (selectedUid) setCursor(selectedUid);
  }, [selectedUid]);

  const active = isActive && paneFocused;
  useEffect(() => {
    if (!active) return;
    const hasDetails = () =>
      !!useWorkbenchStore.getState().selection[clusterId]?.[kindKey] ||
      !!latest.current.selectedObj;
    const cursorObj = () => {
      const { items, cursor } = latest.current;
      return (cursor && items.find((o) => o.metadata.uid === cursor)) || null;
    };
    const controller: TableController = {
      clusterId,
      kindKey,
      get gvk() {
        return latest.current.gvk;
      },
      current: () =>
        latest.current.selectedObj ?? (latest.current.keyboardMode ? cursorObj() : null),
      checked: () => latest.current.checked,
      move: (to) => {
        const { items, selectedObj, onOpen } = latest.current;
        if (!items.length) return;
        const from = cursorObj() ?? selectedObj;
        const at = from ? items.findIndex((o) => o.metadata.uid === from.metadata.uid) : -1;
        const index =
          to === 'top'
            ? 0
            : to === 'bottom'
              ? items.length - 1
              : at < 0
                ? 0
                : Math.max(0, Math.min(items.length - 1, at + (to === 'down' ? 1 : -1)));
        const next = items[index]!;
        setCursor(next.metadata.uid);
        // With the details open they follow the cursor, like the arrow keys.
        if (hasDetails()) onOpen(next);
      },
      open: (obj) => {
        const target = obj ?? cursorObj() ?? latest.current.items[0];
        if (!target) return;
        setCursor(target.metadata.uid);
        latest.current.onOpen(target);
      },
      hasDetails,
      focusFilter: () => {
        filterRef.current?.focus();
        filterRef.current?.select();
      },
      clearFilter: () => {
        const key = `${clusterId}|${kindKey}`;
        if (!useWorkbenchStore.getState().filters[key]) return false;
        useWorkbenchStore.getState().setFilter(clusterId, kindKey, '');
        return true;
      },
      anchor: (obj) => {
        const row = document.querySelector(`[data-uid="${CSS.escape(obj.metadata.uid)}"]`);
        const rect = row?.getBoundingClientRect();
        return rect
          ? { x: Math.round(rect.left + 48), y: Math.round(rect.bottom + 2) }
          : { x: Math.round(window.innerWidth / 2) - 80, y: Math.round(window.innerHeight / 3) };
      },
    };
    useTableKeyboard.getState().register(controller);
    return () => useTableKeyboard.getState().unregister(controller);
  }, [active, clusterId, kindKey]);

  return { cursorUid: keyboardMode ? cursor : null, filterRef };
}
