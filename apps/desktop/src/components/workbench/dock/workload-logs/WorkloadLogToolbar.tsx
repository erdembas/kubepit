import * as i18n from '@/i18n';
import {
  Box,
  Clock,
  Copy,
  Download,
  Eraser,
  ListStart,
  PanelRight,
  Pause,
  Play,
  Search,
  WrapText,
} from 'lucide-react';
import { IconButton } from '@/components/ui/IconButton';
import { Select, type SelectOption } from '@/components/ui/Select';
import { cn } from '@/lib/cn';
import { modChord } from '@/lib/platform';
import { ToggleChip } from '../logs/LogToolbar';
import { sinceSelectOptions, tailSelectOptions } from '../logs/options';
import { StreamIndicator } from '../logs/StreamIndicator';
import type { StreamStatus } from '../logs/useLogStream';

const ALL = '\u0000all';

export interface WorkloadLogToolbarProps {
  status: StreamStatus;
  paused: boolean;
  pending: number;
  lineCount: number;
  /** Container names offered by the filter. */
  containers: string[];
  /** Followed container; null = all regular containers. */
  container: string | null;
  hasInit: boolean;
  initContainers: boolean;
  timestamps: boolean;
  wrap: boolean;
  since: number | null;
  tail: number | null;
  defaultTail: number;
  legend: boolean;
  onContainer: (container: string | null) => void;
  onInitContainers: (value: boolean) => void;
  onTimestamps: (value: boolean) => void;
  onWrap: (value: boolean) => void;
  onSince: (value: number | null) => void;
  onTail: (value: number | null) => void;
  onLegend: (value: boolean) => void;
  onSearch: () => void;
  onPauseToggle: () => void;
  onClear: () => void;
  onCopy: () => void;
  onSave: () => void;
  onRetry: () => void;
}

/** Toolbar of the merged workload log view (same language as the pod log toolbar). */
export function WorkloadLogToolbar(props: WorkloadLogToolbarProps) {
  i18n.useLocale();
  const containerOptions: SelectOption[] = [
    { value: ALL, label: i18n.t('All containers') },
    ...props.containers.map((c) => ({ value: c, label: c })),
  ];
  return (
    <div
      className={cn(
        'border-border/60 bg-surface @container flex h-9 shrink-0 items-center gap-1.5 overflow-x-auto border-b px-2',
        'main-tabbar-scroll',
      )}
    >
      <StreamIndicator
        status={props.status}
        paused={props.paused}
        pending={props.pending}
        follow
        onRetry={props.onRetry}
      />
      <span aria-hidden className="bg-border/70 mx-0.5 h-4 w-px shrink-0" />
      {props.containers.length > 1 && (
        <Select
          value={props.container ?? ALL}
          onChange={(v) => props.onContainer(v === ALL ? null : v)}
          options={containerOptions}
          ariaLabel={i18n.t('Container')}
          leading={<Box size={12} />}
          className="h-6.5 max-w-48 shrink-0"
        />
      )}
      <ToggleChip
        active={props.timestamps}
        onClick={() => props.onTimestamps(!props.timestamps)}
        icon={<Clock />}
        label={i18n.t('Timestamps')}
        title={i18n.t('Prefix every line with the time Kubernetes received it')}
      />
      {props.hasInit && (
        <ToggleChip
          active={props.initContainers}
          onClick={() => props.onInitContainers(!props.initContainers)}
          icon={<ListStart />}
          label={i18n.t('Init containers')}
          title={i18n.t('Also follow init containers')}
        />
      )}
      <ToggleChip
        active={props.wrap}
        onClick={() => props.onWrap(!props.wrap)}
        icon={<WrapText />}
        label={i18n.t('Wrap')}
        title={i18n.t('Wrap long lines')}
      />
      <Select
        value={props.since === null ? 'all' : String(props.since)}
        onChange={(v) => props.onSince(v === 'all' ? null : Number(v))}
        options={sinceSelectOptions()}
        ariaLabel={i18n.t('Since')}
        className="h-6.5 shrink-0"
      />
      <Select
        value={props.tail === null ? 'all' : String(props.tail)}
        onChange={(v) => props.onTail(v === 'all' ? null : Number(v))}
        options={tailSelectOptions(props.defaultTail)}
        ariaLabel={i18n.t('Tail lines per container')}
        className="h-6.5 shrink-0"
      />
      <div className="ml-auto flex shrink-0 items-center gap-0.5 pl-2">
        <span className="text-fg-dim mr-1.5 hidden text-[10.5px] whitespace-nowrap tabular-nums @3xl:inline">
          {i18n.plural('{count} line', '{count} lines', props.lineCount)}
        </span>
        <IconButton
          size="xs"
          label={i18n.t('Find in logs ({shortcut})', { shortcut: modChord('F') })}
          icon={<Search />}
          onClick={props.onSearch}
        />
        <IconButton
          size="xs"
          label={props.paused ? i18n.t('Resume') : i18n.t('Pause')}
          icon={props.paused ? <Play /> : <Pause />}
          tone={props.paused ? 'accent' : 'default'}
          className={cn(props.paused && 'text-accent')}
          onClick={props.onPauseToggle}
        />
        <IconButton size="xs" label={i18n.t('Clear')} icon={<Eraser />} onClick={props.onClear} />
        <IconButton size="xs" label={i18n.t('Copy all')} icon={<Copy />} onClick={props.onCopy} />
        <IconButton
          size="xs"
          label={i18n.t('Save logs…')}
          icon={<Download />}
          onClick={props.onSave}
        />
        <IconButton
          size="xs"
          label={props.legend ? i18n.t('Hide sources') : i18n.t('Show sources')}
          icon={<PanelRight />}
          tone={props.legend ? 'accent' : 'default'}
          className={cn(props.legend && 'text-accent')}
          aria-pressed={props.legend}
          onClick={() => props.onLegend(!props.legend)}
        />
      </div>
    </div>
  );
}
