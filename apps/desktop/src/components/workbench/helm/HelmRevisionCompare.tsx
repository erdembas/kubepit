import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { useState } from 'react';
import { ArrowRight, GitCompareArrows, Loader2 } from 'lucide-react';
import { Select } from '@/components/ui/Select';
import { Tabs } from '@/components/ui/Tabs';
import { ipc } from '@/lib/ipc';
import type { HelmRelease, HelmRevisionDetail } from '@/types';
import { DiffView } from '../common/DiffView';
import { usePolled } from '../data/polled';

type Subject = 'values' | 'manifest';

export function revisionKey(clusterId: string, namespace: string, name: string, revision: number) {
  return `${clusterId}|helm-revision|${namespace}/${name}|${revision}`;
}

function useRevision(clusterId: string, namespace: string, name: string, revision: number | null) {
  return usePolled<HelmRevisionDetail>(
    revision === null ? null : revisionKey(clusterId, namespace, name, revision),
    () => ipc.helmReleaseRevision(clusterId, namespace, name, revision!),
    null,
  );
}

/** Pick two stored revisions of a release and diff their values or manifests. */
export function HelmRevisionCompare({
  clusterId,
  namespace,
  name,
  history,
}: {
  clusterId: string;
  namespace: string;
  name: string;
  /** Newest first, as in the release detail. */
  history: HelmRelease[];
}) {
  i18n.useLocale();
  const [from, setFrom] = useState<number | null>(history[1]?.revision ?? null);
  const [to, setTo] = useState<number | null>(history[0]?.revision ?? null);
  const [subject, setSubject] = useState<Subject>('values');
  const [computed, setComputed] = useState(false);
  const a = useRevision(clusterId, namespace, name, from);
  const b = useRevision(clusterId, namespace, name, to);
  const options = useMemo(
    () =>
      history.map((r) => ({
        value: String(r.revision),
        label: i18n.t('Revision {revision}', { revision: r.revision }),
        description: `${r.chart_version} · ${r.status}`,
      })),
    [history],
  );

  if (history.length < 2)
    return (
      <p className="text-fg-dim border-border/60 border-t px-4 py-4 text-[12px]">
        {i18n.t('Only one revision so far; there is nothing to compare yet.')}
      </p>
    );

  const text = (d: HelmRevisionDetail | undefined) =>
    !d
      ? ''
      : subject === 'manifest'
        ? d.manifest
        : computed
          ? d.computed_values_yaml
          : d.values_yaml;
  const error = a.error ?? b.error;
  return (
    <div className="border-border/60 flex min-h-0 flex-1 flex-col border-t">
      <div className="flex h-10 shrink-0 items-center gap-2 px-3">
        <GitCompareArrows className="text-fg-dim h-3.5 w-3.5 shrink-0" />
        <span className="text-fg-dim shrink-0 text-[10.5px] font-semibold tracking-[0.08em] uppercase">
          {i18n.t('Compare')}
        </span>
        <Select
          ariaLabel={i18n.t('Older revision')}
          value={String(from ?? '')}
          onChange={(v) => setFrom(Number(v))}
          options={options}
        />
        <ArrowRight className="text-fg-dim h-3 w-3 shrink-0" />
        <Select
          ariaLabel={i18n.t('Newer revision')}
          value={String(to ?? '')}
          onChange={(v) => setTo(Number(v))}
          options={options}
        />
        <Tabs<Subject>
          className="ml-auto shrink-0"
          value={subject}
          onChange={setSubject}
          tabs={[
            { key: 'values', label: i18n.t('Values') },
            { key: 'manifest', label: i18n.t('Manifest') },
          ]}
        />
      </div>
      {error ? (
        <p className="text-status-error px-4 py-3 font-mono text-[11.5px] break-words">{error}</p>
      ) : !a.data || !b.data ? (
        <div className="text-fg-muted flex flex-1 items-center justify-center gap-2 text-[12px]">
          <Loader2 className="h-4 w-4 animate-spin" />
          {i18n.t('Loading…')}
        </div>
      ) : (
        <DiffView
          className="border-border/60 border-t"
          original={text(a.data)}
          modified={text(b.data)}
          originalLabel={i18n.t('Revision {revision}', { revision: from ?? '' })}
          modifiedLabel={i18n.t('Revision {revision}', { revision: to ?? '' })}
          identicalHint={
            subject === 'manifest'
              ? i18n.t('Both revisions render the same manifest.')
              : i18n.t('Both revisions use the same values.')
          }
          actions={
            subject === 'values' ? (
              <label className="text-fg-dim mr-2 flex cursor-pointer items-center gap-1.5 text-[11px]">
                <input
                  type="checkbox"
                  checked={computed}
                  onChange={(e) => setComputed(e.target.checked)}
                  className="accent-accent"
                />
                {i18n.t('Computed values')}
              </label>
            ) : undefined
          }
        />
      )}
    </div>
  );
}
