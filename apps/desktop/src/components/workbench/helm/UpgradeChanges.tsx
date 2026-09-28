import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { useState } from 'react';
import { Loader2, Radar, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/cn';
import { deprecatedApi, deprecationMessage } from '@/lib/kube/deprecations';
import { normalizedYaml } from '@/lib/kube/normalize';
import type {
  DryRunResult,
  HelmPreviewChange,
  HelmPreviewObject,
  HelmUpgradePreview,
} from '@/types';
import { DiffView } from '../common/DiffView';
import { ChangeBadge, changeLabel, kindIconFor } from './changeBits';

const CHANGES: HelmPreviewChange[] = ['added', 'changed', 'removed', 'unchanged'];

type Side = 'release' | 'live';

function liveLabel(live: DryRunResult): { text: string; tone: string } {
  if (live.error) return { text: i18n.t('Rejected'), tone: 'text-status-error' };
  switch (live.operation) {
    case 'create':
      return { text: i18n.t('Creates'), tone: 'text-status-running' };
    case 'update':
      return { text: i18n.t('Updates'), tone: 'text-status-starting' };
    default:
      return { text: i18n.t('No live change'), tone: 'text-fg-dim' };
  }
}

/**
 * The upgrade review (helm-diff style): every object of the running and
 * the rendered revision as added / changed / removed / unchanged, with a
 * per-object diff (normalized like every other diff). With "Compare with
 * live objects" the rendered objects are also dry-run on the server and
 * diffed against what is running now.
 */
export function UpgradeChanges({
  preview,
  currentRevision,
  live,
  onLiveChange,
  loadingLive,
}: {
  preview: HelmUpgradePreview;
  currentRevision: number;
  live: boolean;
  onLiveChange: (live: boolean) => void;
  loadingLive: boolean;
}) {
  i18n.useLocale();
  const objects = preview.objects;
  const [filter, setFilter] = useState<HelmPreviewChange | 'all'>('all');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [side, setSide] = useState<Side>('release');
  const counts = useMemo(() => {
    const out: Record<HelmPreviewChange, number> = {
      added: 0,
      changed: 0,
      removed: 0,
      unchanged: 0,
    };
    for (const o of objects) out[o.change]++;
    return out;
  }, [objects]);
  const visible = filter === 'all' ? objects : objects.filter((o) => o.change === filter);
  const selected =
    visible.find((o) => o.key === selectedKey) ??
    visible.find((o) => o.change !== 'unchanged') ??
    visible[0] ??
    null;
  const liveSide = side === 'live' && preview.live_checked && !!selected?.live;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-border/50 flex min-h-9 shrink-0 flex-wrap items-center gap-1.5 border-b px-3 py-1.5">
        {CHANGES.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setFilter((cur) => (cur === c ? 'all' : c))}
            aria-pressed={filter === c}
            className={cn('rounded-full', filter === c && 'ring-accent/60 ring-1')}
          >
            <ChangeBadge change={c} count={counts[c]} />
          </button>
        ))}
        <label className="text-fg-dim ml-auto flex cursor-pointer items-center gap-1.5 text-[11px]">
          {loadingLive ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <input
              type="checkbox"
              checked={live}
              onChange={(e) => {
                onLiveChange(e.target.checked);
                if (e.target.checked) setSide('live');
              }}
              className="accent-accent"
            />
          )}
          {i18n.t('Compare with live objects')}
        </label>
      </div>
      {!objects.length ? (
        <p className="text-fg-dim p-4 text-[12px]">{i18n.t('The chart renders no resources.')}</p>
      ) : (
        <div className="@container flex min-h-0 flex-1 flex-col @2xl:flex-row">
          <ul className="border-border/50 overlay-scroll max-h-48 shrink-0 overflow-auto border-b @2xl:max-h-none @2xl:w-72 @2xl:border-r @2xl:border-b-0">
            {visible.map((o) => (
              <ObjectRow
                key={o.key}
                object={o}
                selected={o.key === selected?.key}
                liveChecked={preview.live_checked}
                onSelect={() => setSelectedKey(o.key)}
              />
            ))}
            {!visible.length && (
              <li className="text-fg-dim px-3 py-4 text-center text-[11.5px]">
                {i18n.t('No objects match this filter.')}
              </li>
            )}
          </ul>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {selected && (
              <>
                <div className="border-border/50 flex h-8 shrink-0 items-center gap-2 border-b px-3 text-[11.5px]">
                  <span className="text-fg-dim shrink-0">{selected.kind}</span>
                  <span className="text-fg min-w-0 truncate font-mono">
                    {selected.namespace ? `${selected.namespace}/` : ''}
                    {selected.name}
                  </span>
                  {selected.source && (
                    <span className="text-fg-dim hidden min-w-0 truncate font-mono text-[10.5px] @3xl:inline">
                      {selected.source}
                    </span>
                  )}
                  {preview.live_checked && (
                    <div className="bg-fg/4 ml-auto inline-flex shrink-0 gap-0.5 rounded-md p-0.5">
                      {(
                        [
                          ['release', i18n.t('Release')],
                          ['live', i18n.t('Live')],
                        ] as const
                      ).map(([key, label]) => (
                        <button
                          key={key}
                          type="button"
                          aria-pressed={side === key}
                          onClick={() => setSide(key)}
                          disabled={key === 'live' && !selected.live}
                          className={cn(
                            'rounded px-2 py-0.5 text-[11px] transition-colors disabled:opacity-40',
                            side === key
                              ? 'bg-surface-raised text-fg font-medium shadow-sm'
                              : 'text-fg-dim hover:text-fg',
                          )}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <DeprecationNote object={selected} />
                {liveSide ? (
                  <LiveDiff result={selected.live!} />
                ) : (
                  <DiffView
                    original={normalizedYaml(selected.before)}
                    modified={normalizedYaml(selected.after)}
                    originalLabel={i18n.t('Revision {revision}', { revision: currentRevision })}
                    modifiedLabel={i18n.t('Upgrade')}
                    identicalHint={i18n.t('The upgrade renders this object unchanged.')}
                  />
                )}
              </>
            )}
          </div>
        </div>
      )}
      {preview.live_truncated && (
        <p className="text-fg-dim border-border/50 shrink-0 border-t px-3 py-1.5 text-[11px]">
          {i18n.t('Only the first 300 objects were compared with the live cluster.')}
        </p>
      )}
    </div>
  );
}

function ObjectRow({
  object: o,
  selected,
  liveChecked,
  onSelect,
}: {
  object: HelmPreviewObject;
  selected: boolean;
  liveChecked: boolean;
  onSelect: () => void;
}) {
  i18n.useLocale();
  const Icon = kindIconFor(o.kind);
  const deprecated = deprecatedApi(o.api_version, o.kind);
  const live = liveChecked && o.live ? liveLabel(o.live) : null;
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          'relative flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-[12px]',
          selected ? 'bg-fg/6' : 'hover:bg-fg/4',
          o.change === 'unchanged' && !selected && 'opacity-60',
        )}
      >
        {selected && <span className="bg-accent absolute inset-y-1 left-0 w-0.5 rounded-full" />}
        <Icon className="text-fg-dim h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="text-fg block truncate font-mono text-[11.5px]">{o.name}</span>
          <span className="text-fg-dim block truncate text-[10.5px]">
            {o.kind}
            {o.namespace ? ` · ${o.namespace}` : ''}
            {live && <span className={cn('ml-1', live.tone)}>· {live.text}</span>}
          </span>
        </span>
        {deprecated && (
          <TriangleAlert
            className="text-status-starting h-3 w-3 shrink-0"
            aria-label={deprecationMessage(deprecated)}
          />
        )}
        <span className="text-fg-dim shrink-0 text-[10.5px]" title={changeLabel(o.change)}>
          <ChangeBadge change={o.change} />
        </span>
      </button>
    </li>
  );
}

function DeprecationNote({ object }: { object: HelmPreviewObject }) {
  i18n.useLocale();
  const entry = object.after ? deprecatedApi(object.api_version, object.kind) : null;
  if (!entry) return null;
  return (
    <p className="border-border/50 bg-status-starting/[0.06] text-fg-muted flex shrink-0 items-start gap-1.5 border-b px-3 py-1.5 text-[11px]">
      <TriangleAlert className="text-status-starting mt-0.5 h-3 w-3 shrink-0" />
      <span>{deprecationMessage(entry)}</span>
    </p>
  );
}

function LiveDiff({ result }: { result: DryRunResult }) {
  i18n.useLocale();
  if (result.error)
    return (
      <div className="overlay-scroll min-h-0 flex-1 overflow-auto p-4">
        <p className="text-status-error mb-2 flex items-center gap-1.5 text-[12px] font-semibold">
          <Radar className="h-3.5 w-3.5" />
          {i18n.t('The server rejected this object in the dry run')}
        </p>
        <pre className="bg-status-error/[0.06] border-status-error/25 text-status-error rounded-md border p-3 font-mono text-[11px] break-words whitespace-pre-wrap">
          {result.error}
        </pre>
      </div>
    );
  return (
    <>
      <p className="border-border/50 text-fg-dim shrink-0 border-b px-3 py-1.5 text-[11px]">
        {i18n.t(
          'Server-side apply dry run of the rendered object: fields the new chart stops setting are not removed here, helm removes them.',
        )}
      </p>
      <DiffView
        original={normalizedYaml(result.live)}
        modified={normalizedYaml(result.result)}
        originalLabel={result.live ? i18n.t('Live') : i18n.t('Not in the cluster')}
        modifiedLabel={i18n.t('After upgrade (server dry run)')}
        identicalHint={i18n.t('The server would leave this object unchanged.')}
      />
    </>
  );
}
