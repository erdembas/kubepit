import * as i18n from '@/i18n';
import { ArrowUpRight } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { isChangelogAction, type ChangelogAction } from '@/lib/changelogActions';
import { openChangelogAction } from '@/lib/changelogNavigation';

function label(action: ChangelogAction) {
  switch (action) {
    case 'fleet-search':
      return i18n.t('Open saved searches');
    case 'investigations':
      return i18n.t('Open investigations');
    case 'connection-doctor':
      return i18n.t('Open Connection doctor');
    case 'network-diagnostics':
      return i18n.t('Open Network diagnostics');
    case 'image-matrix':
      return i18n.t('Open image version matrix');
  }
}

export function ChangelogFeatureActions({ actions }: { actions: readonly string[] }) {
  i18n.useLocale();
  const supported = actions.filter(isChangelogAction);
  if (!supported.length) return null;
  return (
    <div className="border-border/60 border-t px-4 py-3">
      <p className="text-fg-dim mb-2 text-[10px] font-semibold tracking-[0.12em] uppercase">
        {i18n.t('Explore these features')}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {supported.map((action) => (
          <Button
            key={action}
            size="sm"
            variant="secondary"
            rightIcon={<ArrowUpRight className="h-3 w-3" />}
            onClick={() => openChangelogAction(action)}
          >
            {label(action)}
          </Button>
        ))}
      </div>
    </div>
  );
}
