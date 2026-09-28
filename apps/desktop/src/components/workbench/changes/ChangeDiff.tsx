import * as i18n from '@/i18n';
import { FileWarning, Loader2 } from 'lucide-react';
import { ipc } from '@/lib/ipc';
import type { ChangeDetail, ChangeSummary } from '@/types';
import { DiffView } from '../common/DiffView';
import { usePolled } from '../data/polled';
import { changesKeyPrefix } from './useChanges';

/**
 * Before/after of one journal entry (normalized YAML). Entries never change
 * once recorded, so the detail is fetched once and cached. `historic`
 * entries come from the persistent history (their ids are the database's).
 */
export function ChangeDiff({
  entry,
  historic = false,
}: {
  entry: ChangeSummary;
  historic?: boolean;
}) {
  i18n.useLocale();
  const detail = usePolled<ChangeDetail>(
    `${changesKeyPrefix(entry.cluster_id)}${historic ? 'history-detail' : 'detail'}|${entry.id}`,
    () =>
      historic
        ? ipc.historyChangesGet(entry.cluster_id, entry.id)
        : ipc.changesGet(entry.cluster_id, entry.id),
    null,
  );
  const d = detail.data;
  if (!d)
    return (
      <div className="text-fg-muted flex h-24 items-center justify-center gap-2 text-[12px]">
        {detail.error ? (
          <span className="text-status-error px-4 text-center break-words">{detail.error}</span>
        ) : (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            {i18n.t('Loading change…')}
          </>
        )}
      </div>
    );
  if (d.omitted)
    return (
      <p className="text-fg-dim flex items-center gap-2 px-4 py-3 text-[11.5px]">
        <FileWarning className="text-status-starting h-3.5 w-3.5 shrink-0" />
        {i18n.t(
          'This object was too large to keep in the journal; only the changed fields above are known.',
        )}
      </p>
    );
  const labels =
    entry.op === 'added'
      ? [i18n.t('Did not exist'), i18n.t('Created')]
      : entry.op === 'deleted'
        ? [i18n.t('Before deletion'), i18n.t('Deleted')]
        : [i18n.t('Before'), i18n.t('After')];
  return (
    <div className="flex h-[340px] min-h-0 flex-col">
      <DiffView
        original={d.before_yaml ?? ''}
        modified={d.after_yaml ?? ''}
        originalLabel={labels[0]!}
        modifiedLabel={labels[1]!}
        identicalHint={i18n.t(
          'The difference is inside a value that was shortened to fit the journal; see the changed fields above.',
        )}
      />
      {d.summary.truncated && (
        <p className="border-border/60 text-fg-dim border-t px-3 py-1.5 text-[11px]">
          {i18n.t('Some long values were shortened to fit the journal.')}
        </p>
      )}
    </div>
  );
}
