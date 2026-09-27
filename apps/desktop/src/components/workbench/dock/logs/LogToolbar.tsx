import * as i18n from '@/i18n';
import type { ReactNode } from 'react';
import {
  ArrowDownToLine,
  Box,
  Clock,
  Copy,
  Download,
  Eraser,
  History,
  Pause,
  Play,
  Search,
  WrapText,
} from 'lucide-react';
import { IconButton } from '@/components/ui/IconButton';
import { Select, type SelectOption } from '@/components/ui/Select';
import { cn } from '@/lib/cn';
import { modChord } from '@/lib/platform';
import { StreamIndicator } from './StreamIndicator';
import type { StreamStatus } from './useLogStream';

const TAIL_VALUES = [100, 500, 1_000, 5_000, 10_000];

export interface LogToolbarProps {
  status: StreamStatus;
  paused: boolean;
  pending: number;
  lineCount: number;
  containers: string[];
  container: string | null;
  follow: boolean;
  timestamps: boolean;
  previous: boolean;
  wrap: boolean;
  since: number | null;
  tail: number | null;
  defaultTail: number;
  onContainer: (container: string) => void;
  onFollow: (value: boolean) => void;
  onTimestamps: (value: boolean) => void;
  onPrevious: (value: boolean) => void;
  onWrap: (value: boolean) => void;
  onSince: (value: number | null) => void;
  onTail: (value: number | null) => void;
  onSearch: () => void;
  onPauseToggle: () => void;
  onClear: () => void;
  onCopy: () => void;
  onDownload: () => void;
  onRetry: () => void;
}

/** Single-row log toolbar in RunHQ's LogPanelToolbar language (chips, compact selects, icon actions). */
export function LogToolbar(props: LogToolbarProps) {
  i18n.useLocale();
  const sinceOptions: SelectOption[] = [
    { value: 'all', label: i18n.t('All time') },
    { value: '300', label: i18n.t('Last 5 minutes') },
    { value: '900', label: i18n.t('Last 15 minutes') },
    { value: '3600', label: i18n.t('Last hour') },
    { value: '21600', label: i18n.t('Last 6 hours') },
    { value: '86400', label: i18n.t('Last 24 hours') },
  ];
  const tails = [...new Set([...TAIL_VALUES, props.defaultTail])].sort((a, b) => a - b);
  const tailOptions: SelectOption[] = [
    ...tails.map((n) => ({
      value: String(n),
      label: i18n.t('Last {count} lines', { count: i18n.number(n) }),
    })),
    { value: 'all', label: i18n.t('All lines') },
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
        follow={props.follow}
        onRetry={props.onRetry}
      />
      <span aria-hidden className="bg-border/70 mx-0.5 h-4 w-px shrink-0" />
      {props.containers.length > 0 && props.container && (
        <Select
          value={props.container}
          onChange={props.onContainer}
          options={props.containers.map((c) => ({ value: c, label: c }))}
          ariaLabel={i18n.t('Container')}
          leading={<Box size={12} />}
          className="h-6.5 max-w-48 shrink-0"
        />
      )}
      <ToggleChip
        active={props.follow}
        onClick={() => props.onFollow(!props.follow)}
        icon={<ArrowDownToLine />}
        label={i18n.t('Follow')}
        title={i18n.t('Keep streaming new lines and stick to the bottom')}
        disabled={props.previous}
      />
      <ToggleChip
        active={props.timestamps}
        onClick={() => props.onTimestamps(!props.timestamps)}
        icon={<Clock />}
        label={i18n.t('Timestamps')}
        title={i18n.t('Prefix every line with the time Kubernetes received it')}
      />
      <ToggleChip
        active={props.previous}
        onClick={() => props.onPrevious(!props.previous)}
        icon={<History />}
        label={i18n.t('Previous')}
        title={i18n.t('Show logs of the previous (terminated) container instance')}
      />
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
        options={sinceOptions}
        ariaLabel={i18n.t('Since')}
        className="h-6.5 shrink-0"
      />
      <Select
        value={props.tail === null ? 'all' : String(props.tail)}
        onChange={(v) => props.onTail(v === 'all' ? null : Number(v))}
        options={tailOptions}
        ariaLabel={i18n.t('Tail lines')}
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
          label={i18n.t('Download')}
          icon={<Download />}
          onClick={props.onDownload}
        />
      </div>
    </div>
  );
}

function ToggleChip({
  active,
  onClick,
  icon,
  label,
  title,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
  title: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={label}
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={cn(
        'rounded-app-sm flex h-6.5 shrink-0 items-center gap-1.5 border px-2 text-[11.5px] font-medium whitespace-nowrap transition',
        'disabled:cursor-not-allowed disabled:opacity-45 [&>svg]:h-3 [&>svg]:w-3',
        active
          ? 'border-accent/50 bg-accent/10 text-accent'
          : 'border-border bg-surface-muted/70 text-fg-muted hover:text-fg hover:bg-surface-overlay',
      )}
    >
      {icon}
      {/* Narrow docks keep icon-only chips (the title still names them). */}
      <span className="hidden @5xl:inline">{label}</span>
    </button>
  );
}
