import { createContext, useContext } from 'react';

/**
 * Whether the surrounding split pane is the focused one. Several panes are
 * visible (and `isActive`) at once — main panes side by side, and view
 * panes inside each cluster — so global keyboard handlers such as Esc
 * additionally check this to act on one pane only. Nested providers AND
 * their value with the outer one (see `useNestedPaneFocus`).
 */
export const PaneFocusContext = createContext(true);

export function usePaneFocused() {
  return useContext(PaneFocusContext);
}

/** Value for a nested provider: focused only while every enclosing pane is. */
export function useNestedPaneFocus(focused: boolean) {
  return useContext(PaneFocusContext) && focused;
}
