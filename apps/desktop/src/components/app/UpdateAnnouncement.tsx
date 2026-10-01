import * as i18n from '@/i18n';
import { useEffect, useRef } from 'react';
import { ArrowUpRight, Check, Download, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { IconButton } from '@/components/ui/IconButton';
import { UpdateCard } from '@/components/updates/UpdateCard';
import { useUpdaterStore } from '@/store/useUpdaterStore';

/** A quiet, dismissible announcement that leaves terminals and workbenches usable. */
export function UpdateAnnouncement() {
  i18n.useLocale();
  const open = useUpdaterStore((s) => s.announcementOpen);
  const update = useUpdaterStore((s) => s.update);
  const phase = useUpdaterStore((s) => s.phase);
  const openDetails = useUpdaterStore((s) => s.openDetails);
  const dismiss = useUpdaterStore((s) => s.dismissAnnouncement);
  if (!open || !update) return null;
  const ready = phase === 'ready';
  const working = phase === 'downloading' || phase === 'installing';
  return (
    <section
      aria-label={i18n.t('Kubepit update')}
      className="border-accent/20 bg-accent/5 relative flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b py-2 pr-3 pl-4"
    >
      <span aria-hidden="true" className="bg-accent absolute inset-y-0 left-0 w-0.5" />
      <span
        className="text-accent bg-accent/10 flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
        aria-hidden="true"
      >
        {ready ? (
          <Check className="h-3.5 w-3.5" />
        ) : working ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <ArrowUpRight className="h-3.5 w-3.5" />
        )}
      </span>
      <div className="min-w-0 flex-1" role="status">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-accent text-[11px] font-semibold tracking-[0.1em] uppercase">
            {ready
              ? i18n.t('Ready to relaunch')
              : working
                ? i18n.t('Updating…')
                : i18n.t('New release')}
          </span>
          <span className="text-fg text-[12px] font-medium">
            Kubepit <span className="font-mono tabular-nums">{update.version}</span>
          </span>
          <span className="text-fg-dim hidden text-[11px] lg:inline">
            {ready
              ? i18n.t('Your update is installed.')
              : working
                ? i18n.t('Follow the installation progress.')
                : i18n.t('See what is new and choose when to install.')}
          </span>
        </div>
      </div>
      <Button
        variant="secondary"
        size="xs"
        onClick={openDetails}
        rightIcon={<ArrowUpRight className="h-3 w-3" />}
      >
        {ready || working ? i18n.t('View update') : i18n.t('What’s new')}
      </Button>
      <IconButton
        size="xs"
        label={i18n.t('Dismiss update announcement')}
        icon={<X />}
        onClick={dismiss}
      />
    </section>
  );
}

/** A persistent way back to the update after the announcement has been dismissed. */
export function UpdateStatusButton() {
  i18n.useLocale();
  const update = useUpdaterStore((s) => s.update);
  const phase = useUpdaterStore((s) => s.phase);
  const open = useUpdaterStore((s) => s.openDetails);
  if (!update) return null;
  const busy = phase === 'downloading' || phase === 'installing';
  return (
    <button
      type="button"
      onClick={open}
      title={i18n.t('Kubepit {version} update details', { version: update.version })}
      className="text-accent hover:bg-fg/10 ml-1 inline-flex items-center gap-1.5 rounded px-1.5 py-1 text-[11px]"
    >
      {busy ? (
        <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />
      ) : (
        <Download aria-hidden="true" className="h-3 w-3" />
      )}
      {phase === 'ready'
        ? i18n.t('Ready to relaunch')
        : busy
          ? i18n.t('Updating…')
          : i18n.t('Update available')}
    </button>
  );
}

export function UpdateDetailsDialog() {
  i18n.useLocale();
  const open = useUpdaterStore((s) => s.detailsOpen);
  const update = useUpdaterStore((s) => s.update);
  const close = useUpdaterStore((s) => s.closeDetails);
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open || !update) return;
    const previous = document.activeElement;
    const dialog = contentRef.current?.closest('[role="dialog"]');
    if (!dialog) return;
    const focusable = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], [tabindex="0"]'),
      ).filter((el) => el.getClientRects().length > 0);
    focusable()[0]?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const items = focusable();
      const first = items[0];
      const last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    dialog.addEventListener('keydown', trap as EventListener);
    return () => {
      dialog.removeEventListener('keydown', trap as EventListener);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [open, !!update]);
  if (!open || !update) return null;
  return (
    <Dialog
      title={i18n.t('Kubepit update')}
      onClose={close}
      size="md"
      footer={
        <Button variant="secondary" size="sm" onClick={close}>
          {i18n.t('Close')}
        </Button>
      }
    >
      <div ref={contentRef}>
        <UpdateCard />
      </div>
    </Dialog>
  );
}
