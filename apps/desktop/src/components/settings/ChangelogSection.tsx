import * as i18n from '@/i18n';
import { useEffect, useRef, useState } from 'react';
import { History, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ChangelogFeatureActions } from '@/components/changelog/ChangelogFeatureActions';
import { Select } from '@/components/ui/Select';
import { Markdown } from '@/components/workbench/common/Markdown';
import { APP_VERSION } from '@/lib/version';
import { useChangelogNavigation } from '@/lib/changelogNavigation';
import { openWhatsNewPreview } from '@/lib/releaseNotesStore';
import { useAppStore } from '@/store/useAppStore';
import changelog from '../../../../../shared/changelog/generated.json';
import { SettingsSection } from './SettingsView';

/** Bundled history is independent of the updater's notes for an available version. */
export function ChangelogSection() {
  const locale = i18n.useLocale();
  const installedVersion = useAppStore((s) => s.appInfo?.version) ?? APP_VERSION;
  const requestedId = useChangelogNavigation((state) => state.entryId);
  const requestRevision = useChangelogNavigation((state) => state.revision);
  const container = useRef<HTMLDivElement>(null);
  const [selectedId, setSelectedId] = useState(
    () =>
      changelog.entries.find((entry) => entry.status === 'unreleased')?.id ??
      changelog.entries.find((entry) => entry.version === installedVersion)?.id ??
      changelog.entries[0]?.id ??
      '',
  );
  const selected = changelog.entries.find((entry) => entry.id === selectedId);

  useEffect(() => {
    if (!requestRevision) return;
    if (requestedId && changelog.entries.some((entry) => entry.id === requestedId))
      setSelectedId(requestedId);
    container.current?.scrollIntoView({ block: 'start' });
  }, [requestedId, requestRevision]);

  return (
    <div ref={container} className="scroll-mt-4">
      <SettingsSection
        title={i18n.t('Changelog')}
        description={i18n.t(
          'Version history and unreleased changes bundled with this build. Available offline.',
        )}
      >
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-fg-dim text-[11.5px]">
            {i18n.t('Installed version: {version}', { version: installedVersion })}
          </p>
          {selected && (
            <Button
              size="sm"
              variant="ghost"
              leftIcon={<Sparkles className="h-3.5 w-3.5" />}
              onClick={() => openWhatsNewPreview(selected.id)}
            >
              {i18n.t('Preview highlights')}
            </Button>
          )}
          <Select
            value={selectedId}
            onChange={setSelectedId}
            ariaLabel={i18n.t('Version history')}
            leading={<History className="h-3.5 w-3.5" />}
            className="w-52 max-w-full"
            options={changelog.entries.map((entry) => ({
              value: entry.id,
              label:
                entry.status === 'unreleased'
                  ? i18n.t('Unreleased')
                  : entry.version === installedVersion
                    ? i18n.t('Version {version} (installed)', { version: entry.version })
                    : i18n.t('Version {version}', { version: entry.version }),
              description: entry.title[locale],
            }))}
          />
        </div>
        {selected ? (
          <div className="border-border/70 bg-surface-raised/50 overflow-hidden rounded-md border">
            <div className="border-border/60 border-b px-4 py-3">
              <h4 className="text-fg text-[13px] font-semibold">{selected.title[locale]}</h4>
              {selected.date && (
                <p className="text-fg-dim mt-1 text-[11px]">
                  <time dateTime={selected.date}>
                    {i18n.date(new Date(selected.date), {
                      year: 'numeric',
                      month: 'long',
                      day: 'numeric',
                      timeZone: 'UTC',
                    })}
                  </time>
                </p>
              )}
              {selected.status === 'unreleased' && (
                <p className="text-status-starting mt-2 text-[11.5px] leading-relaxed">
                  {i18n.t(
                    'These changes are in development and have not been published as a versioned release.',
                  )}
                </p>
              )}
            </div>
            <ChangelogFeatureActions actions={selected.actions} />
            <div
              key={`${selected.id}:${locale}`}
              role="region"
              aria-label={i18n.t('Changelog entry')}
              tabIndex={0}
              className="focus-visible:outline-accent max-h-[420px] overflow-y-auto px-4 py-3 focus-visible:outline-2 focus-visible:-outline-offset-2"
            >
              <Markdown source={selected.body[locale]} />
            </div>
          </div>
        ) : (
          <p className="text-fg-dim text-[12px]">{i18n.t('No bundled changelog entries.')}</p>
        )}
      </SettingsSection>
    </div>
  );
}
