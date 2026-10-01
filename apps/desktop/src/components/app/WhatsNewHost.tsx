import * as i18n from '@/i18n';
import { useEffect, useRef } from 'react';
import { ArrowRight, History, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { openChangelog } from '@/lib/changelogNavigation';
import { releaseHighlights } from '@/lib/releaseNotes';
import {
  checkInstalledRelease,
  dismissWhatsNew,
  useReleaseNotesStore,
} from '@/lib/releaseNotesStore';
import { useAppStore } from '@/store/useAppStore';

/** Installed-version highlights. The available-update announcement remains separate. */
export function WhatsNewHost() {
  const locale = i18n.useLocale();
  const bootstrapped = useAppStore((state) => state.bootstrapped);
  const installedVersion = useAppStore((state) => state.appInfo?.version);
  const summary = useReleaseNotesStore((state) => state.summary);
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (bootstrapped && installedVersion) void checkInstalledRelease(installedVersion);
  }, [bootstrapped, installedVersion]);

  useEffect(() => {
    if (!summary) return;
    const previous = document.activeElement;
    const dialog = contentRef.current?.closest('[role="dialog"]');
    if (!dialog) return;
    const focusable = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], [tabindex="0"]'),
      ).filter((element) => element.getClientRects().length > 0);
    focusable()[0]?.focus();
    const trap = (event: Event) => {
      const keyboard = event as KeyboardEvent;
      if (keyboard.key !== 'Tab') return;
      const elements = focusable();
      const first = elements[0];
      const last = elements.at(-1);
      if (keyboard.shiftKey && document.activeElement === first) {
        keyboard.preventDefault();
        last?.focus();
      } else if (!keyboard.shiftKey && document.activeElement === last) {
        keyboard.preventDefault();
        first?.focus();
      }
    };
    dialog.addEventListener('keydown', trap);
    return () => {
      dialog.removeEventListener('keydown', trap);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [summary]);

  if (!summary) return null;
  const preview = summary.mode === 'preview';
  const unreleased = summary.entries.some((entry) => entry.status === 'unreleased');
  const shown = summary.entries.slice(0, 3);
  const openFullHistory = () => {
    const entryId = summary.entries[0]?.id ?? summary.toVersion ?? undefined;
    dismissWhatsNew();
    openChangelog(entryId);
  };

  return (
    <Dialog
      title={
        preview
          ? i18n.t('Changelog highlights preview')
          : i18n.t('What’s new in Kubepit {version}', { version: summary.toVersion })
      }
      onClose={dismissWhatsNew}
      size="md"
      footer={
        <>
          <Button
            variant="secondary"
            size="sm"
            onClick={openFullHistory}
            leftIcon={<History className="h-3.5 w-3.5" />}
          >
            {i18n.t('Read full changelog')}
          </Button>
          <Button variant="primary" size="sm" onClick={dismissWhatsNew}>
            {i18n.t('Done')}
          </Button>
        </>
      }
    >
      <div ref={contentRef}>
        <div className="border-accent/60 bg-accent/5 mb-4 border-l-2 px-3 py-2.5">
          <div className="text-accent mb-1.5 flex items-center gap-2 text-[11px] font-semibold tracking-wide uppercase">
            <Sparkles aria-hidden="true" className="h-3.5 w-3.5" />
            {preview ? i18n.t('Preview highlights') : i18n.t('Installed version highlights')}
          </div>
          {summary.fromVersion && summary.toVersion && (
            <div className="text-fg mb-2 flex items-center gap-2 font-mono text-[12px]">
              <span>{summary.fromVersion}</span>
              <ArrowRight aria-hidden="true" className="text-fg-dim h-3 w-3" />
              <span>{summary.toVersion}</span>
            </div>
          )}
          <p className="text-fg-muted text-[12px] leading-relaxed">
            {preview
              ? unreleased
                ? i18n.t('Preview of unpublished changes. These are not installed release notes.')
                : i18n.t('Previewing version notes does not indicate an installed update.')
              : i18n.t('A short summary of the versioned changes included in this installation.')}
          </p>
        </div>
        {shown.length ? (
          <div className="space-y-4">
            {shown.map((entry) => (
              <section key={entry.id}>
                <div className="mb-1.5 flex flex-wrap items-baseline gap-2">
                  <span className="text-accent font-mono text-[11px]">
                    {entry.status === 'unreleased' ? i18n.t('Unreleased') : entry.version}
                  </span>
                  <h4 className="text-fg text-[12px] font-semibold">{entry.title[locale]}</h4>
                </div>
                <ul className="text-fg-muted marker:text-fg-dim list-disc space-y-1.5 pl-4 text-[12px] leading-relaxed">
                  {releaseHighlights(entry.body[locale]).map((highlight, index) => (
                    <li key={index}>{highlight}</li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        ) : (
          <p className="text-fg-dim text-[12px]">
            {i18n.t('No bundled version notes match this installation.')}
          </p>
        )}
        <p className="text-fg-dim mt-4 text-[11px] leading-relaxed">
          {i18n.t('The full changelog includes every change, details and limitations.')}
        </p>
      </div>
    </Dialog>
  );
}
