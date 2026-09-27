import * as i18n from '@/i18n';
import type { ReactNode } from 'react';
import { RotateCcw } from 'lucide-react';
import { Checkbox } from '@/components/ui/Choice';
import { cn } from '@/lib/cn';
import {
  legendRows,
  podCssColor,
  type LogSource,
  type SourceFilter,
  type SourceState,
} from './model';

interface Props {
  sources: LogSource[];
  /** Leading pod-name characters every pod shares (shown as "…"). */
  strip: number;
  colorIndex: (pod: string) => number;
  filter: SourceFilter;
  onTogglePod: (pod: string) => void;
  onToggleContainer: (container: string) => void;
  onOnlyPod: (pod: string) => void;
  onOnlyContainer: (container: string) => void;
  onShowAll: () => void;
  onHideAll: () => void;
}

/**
 * Right-hand legend of the merged log view: per-container and per-pod
 * toggles with line counts and stream state. A line is shown when both its
 * pod and its container are enabled; "only" solos one row.
 */
export function SourceLegend(props: Props) {
  i18n.useLocale();
  const { pods, containers } = legendRows(props.sources, props.colorIndex);
  const stateLabel: Record<SourceState, string> = {
    live: i18n.t('Streaming'),
    ended: i18n.t('Stream ended'),
    failed: i18n.t('Stream failed'),
    removed: i18n.t('Pod is gone'),
    skipped: i18n.t('Not followed (stream limit reached)'),
  };
  return (
    <aside
      aria-label={i18n.t('Log sources')}
      className="border-border/60 bg-surface flex w-60 shrink-0 flex-col border-l"
    >
      <div className="border-border/60 flex h-8 shrink-0 items-center gap-1 border-b pr-1 pl-3">
        <span className="text-fg-dim text-[10.5px] font-semibold tracking-[0.08em] uppercase">
          {i18n.t('Sources')}
        </span>
        <span className="ml-auto flex items-center">
          <HeaderButton onClick={props.onShowAll}>{i18n.t('All')}</HeaderButton>
          <HeaderButton onClick={props.onHideAll}>{i18n.t('None')}</HeaderButton>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {pods.length === 0 ? (
          <p className="text-fg-dim px-3 py-2 text-[11px]">{i18n.t('No pods streamed yet.')}</p>
        ) : (
          <>
            {containers.length > 1 && (
              <>
                <GroupLabel>{i18n.t('Containers')}</GroupLabel>
                {containers.map((c) => (
                  <LegendRow
                    key={c.container}
                    label={c.container}
                    checked={!props.filter.hiddenContainers.has(c.container)}
                    lines={c.lines}
                    onToggle={() => props.onToggleContainer(c.container)}
                    onOnly={() => props.onOnlyContainer(c.container)}
                  />
                ))}
              </>
            )}
            <GroupLabel>{i18n.t('Pods')}</GroupLabel>
            {pods.map((p) => (
              <LegendRow
                key={p.pod}
                label={p.pod}
                display={props.strip > 0 ? `…${p.pod.slice(props.strip)}` : p.pod}
                checked={!props.filter.hiddenPods.has(p.pod)}
                lines={p.lines}
                dim={p.state === 'removed' || p.state === 'skipped'}
                title={p.message ? `${stateLabel[p.state]} — ${p.message}` : stateLabel[p.state]}
                leading={
                  <span
                    aria-hidden
                    className="h-2 w-2 shrink-0 rounded-[2px]"
                    style={{ backgroundColor: podCssColor(p.color) }}
                  />
                }
                trailing={
                  <>
                    {p.restarts > 0 && (
                      <span
                        className="text-status-starting flex items-center gap-0.5 text-[10px] tabular-nums"
                        title={i18n.plural(
                          'Restarted {count} time',
                          'Restarted {count} times',
                          p.restarts,
                        )}
                      >
                        <RotateCcw className="h-2.5 w-2.5" />
                        {p.restarts}
                      </span>
                    )}
                    <StateDot state={p.state} />
                  </>
                }
                onToggle={() => props.onTogglePod(p.pod)}
                onOnly={() => props.onOnlyPod(p.pod)}
              />
            ))}
          </>
        )}
      </div>
    </aside>
  );
}

function HeaderButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-fg-muted hover:text-fg hover:bg-fg/6 rounded-app-sm h-5 px-1.5 text-[11px] font-medium transition"
    >
      {children}
    </button>
  );
}

function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <div className="text-fg-dim px-3 pt-2 pb-1 text-[10px] font-semibold tracking-[0.08em] uppercase">
      {children}
    </div>
  );
}

function StateDot({ state }: { state: SourceState }) {
  return (
    <span
      aria-hidden
      className={cn(
        'h-1.5 w-1.5 shrink-0 rounded-full',
        state === 'live' && 'bg-status-running',
        state === 'ended' && 'bg-fg-dim/60',
        state === 'failed' && 'bg-status-error',
        state === 'skipped' && 'bg-status-starting',
        state === 'removed' && 'ring-fg-dim/60 ring-1',
      )}
    />
  );
}

function LegendRow({
  label,
  display,
  checked,
  lines,
  dim,
  title,
  leading,
  trailing,
  onToggle,
  onOnly,
}: {
  label: string;
  display?: string;
  checked: boolean;
  lines: number;
  dim?: boolean;
  title?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  onToggle: () => void;
  onOnly: () => void;
}) {
  i18n.useLocale();
  return (
    <div
      title={title ? `${label} — ${title}` : label}
      className={cn(
        'group hover:bg-fg/4 flex h-6.5 cursor-pointer items-center gap-2 px-3 text-[11.5px] select-none',
        !checked && 'opacity-50',
      )}
      onClick={onToggle}
    >
      <Checkbox
        checked={checked}
        onChange={onToggle}
        onClick={(e) => e.stopPropagation()}
        aria-label={label}
        className="mt-0"
      />
      {leading}
      <span className={cn('text-fg min-w-0 flex-1 truncate font-mono', dim && 'text-fg-dim')}>
        {display ?? label}
      </span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onOnly();
        }}
        className="text-fg-dim hover:text-accent hidden text-[10.5px] font-medium group-hover:inline"
      >
        {i18n.t('only')}
      </button>
      <span className="text-fg-dim text-[10.5px] tabular-nums group-hover:hidden">
        {i18n.number(lines)}
      </span>
      {trailing}
    </div>
  );
}
