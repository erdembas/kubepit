import { useEffect, type RefObject } from 'react';

/** Expand the existing panel in place: streaming, drafts and scroll never remount. */
export function useAssistantFullscreen(
  expanded: boolean,
  panel: RefObject<HTMLElement>,
  onExit: () => void,
) {
  useEffect(() => {
    const root = panel.current;
    if (!expanded || !root) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    root.querySelector<HTMLElement>('[data-assistant-expand]')?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      // Portalled model pickers and review dialogs keep their own keyboard scope.
      const otherOverlay = [
        ...document.querySelectorAll<HTMLElement>(
          '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
        ),
      ].some(
        (element) =>
          element !== root && !root.contains(element) && element.getClientRects().length > 0,
      );
      if (otherOverlay) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onExit();
      } else if (event.key === 'Tab') {
        const focusable = [
          ...root.querySelectorAll<HTMLElement>(
            'button, input, textarea, select, a[href], [tabindex]',
          ),
        ].filter(
          (element) =>
            element.tabIndex >= 0 &&
            !element.matches(':disabled') &&
            element.getClientRects().length > 0 &&
            getComputedStyle(element).visibility !== 'hidden',
        );
        const first = focusable[0];
        const last = focusable.at(-1);
        if (!first || !last) return;
        const current = document.activeElement;
        if (
          event.shiftKey
            ? current === first || !root.contains(current)
            : current === last || !root.contains(current)
        ) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      // Closing the panel must not send focus into its now-hidden controls.
      if (
        previous?.isConnected &&
        previous.getClientRects().length > 0 &&
        !root.closest('[aria-hidden="true"]')
      )
        previous.focus();
    };
  }, [expanded, onExit, panel]);
}
