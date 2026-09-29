import * as i18n from '@/i18n';
import { useCallback, useRef } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { AlertsPanel } from '@/components/alerts/AlertsPanel';
import { FleetEventsPanel } from '@/components/panels/FleetEventsPanel';
import { PortForwardsPanel } from '@/components/panels/PortForwardsPanel';
import { AssistantPanel } from '@/components/assistant/AssistantPanel';
import { cn } from '@/lib/cn';

/** Keep panel state mounted, but resize the workspace only once per toggle.
 * Animating width repeatedly reflows every visible editor and resizes its PTY.
 */
export function RightSidePanel() {
  i18n.useLocale();
  const active = useAppStore((s) => s.rightPanel);
  const width = useAppStore((s) => s.rightPanelWidth);
  const setWidth = useAppStore((s) => s.setRightPanelWidth);

  const resizing = useRef(false);
  const startXRef = useRef(0);
  const startWRef = useRef(0);
  const onResizeStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      resizing.current = true;
      startXRef.current = e.clientX;
      startWRef.current = width;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [width],
  );

  const onResizeMove = useCallback(
    (e: React.PointerEvent) => {
      if (!resizing.current) return;
      // The panel sits to the LEFT of the rail, so dragging the
      // grip leftward should *grow* the panel — same inversion as
      // the old ActivityTimeline overlay-resize logic.
      const delta = startXRef.current - e.clientX;
      setWidth(startWRef.current + delta);
    },
    [setWidth],
  );

  const onResizeEnd = useCallback((e: React.PointerEvent) => {
    if (!resizing.current) return;
    resizing.current = false;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* may already be released if the pointer left the window */
    }
  }, []);

  // Mount on first use; keep drafts, filters and scroll positions on close.
  const hasOpenedEvents = useRef(false);
  const hasOpenedForwards = useRef(false);
  if (active === 'events') hasOpenedEvents.current = true;
  if (active === 'forwards') hasOpenedForwards.current = true;
  const hasOpenedAlerts = useRef(false);
  if (active === 'alerts') hasOpenedAlerts.current = true;

  const hasOpenedAssistant = useRef(false);
  if (active === 'assistant') hasOpenedAssistant.current = true;

  const isOpen = active != null;
  const renderedWidth = isOpen ? width : 0;

  return (
    <aside
      className={cn(
        'chrome-gradient bg-surface-raised relative flex h-full min-h-0 shrink-0 flex-col overflow-hidden',
        isOpen && 'border-border/70 border-l',
      )}
      style={{ width: renderedWidth }}
      aria-hidden={!isOpen}
    >
      <div className="absolute inset-y-0 right-0 flex flex-col" style={{ width }}>
        {isOpen && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={i18n.t('Resize side panel')}
            onPointerDown={onResizeStart}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeEnd}
            onPointerCancel={onResizeEnd}
            className="group absolute top-0 bottom-0 left-0 z-20 w-1.5 cursor-col-resize"
          >
            <div className="group-hover:bg-accent/40 group-active:bg-accent/60 absolute top-0 bottom-0 left-0 w-[2px] transition-colors" />
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col">
          {hasOpenedEvents.current && (
            <div className={active === 'events' ? 'flex h-full min-h-0 flex-1' : 'hidden'}>
              <FleetEventsPanel visible={active === 'events'} />
            </div>
          )}
          {hasOpenedForwards.current && (
            <div className={active === 'forwards' ? 'flex h-full min-h-0 flex-1' : 'hidden'}>
              <PortForwardsPanel />
            </div>
          )}
          {hasOpenedAssistant.current && (
            <div className={active === 'assistant' ? 'flex h-full min-h-0 flex-1' : 'hidden'}>
              <AssistantPanel visible={active === 'assistant'} />
            </div>
          )}
          {hasOpenedAlerts.current && (
            <div className={active === 'alerts' ? 'flex h-full min-h-0 flex-1' : 'hidden'}>
              <AlertsPanel visible={active === 'alerts'} />
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
