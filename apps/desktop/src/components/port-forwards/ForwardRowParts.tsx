import * as i18n from '@/i18n';
import { Copy, ExternalLink, Pencil, Play, RotateCcw, Square, Star, Zap } from 'lucide-react';
import { IconButton } from '@/components/ui/IconButton';
import { cn } from '@/lib/cn';
import { openExternal } from '@/lib/openExternal';
import { forwardUrl, type ForwardRow } from '@/lib/portForwards';
import { useConnectivityStore } from '@/store/useConnectivityStore';
import {
  copyUrl,
  restartForward,
  startSaved,
  stopForward,
  toggleSaved,
  toggleStartOnConnect,
} from './forwardActions';

type RowState = 'active' | 'starting' | 'error' | 'stopped';

export function rowState(row: ForwardRow): RowState {
  return row.live?.state === 'stopped' || !row.live ? 'stopped' : row.live.state;
}

const TONE: Record<RowState, string> = {
  active: 'text-status-running',
  starting: 'text-status-starting',
  error: 'text-status-error',
  stopped: 'text-fg-dim',
};

const DOT: Record<RowState, string> = {
  active: 'bg-status-running',
  starting: 'bg-status-starting animate-pulse',
  error: 'bg-status-error',
  stopped: 'bg-fg-dim/50',
};

export function rowStateLabel(state: RowState) {
  switch (state) {
    case 'active':
      return i18n.t('Active');
    case 'starting':
      return i18n.t('Starting');
    case 'error':
      return i18n.t('Error');
    default:
      return i18n.t('Stopped');
  }
}

/** Status dot + label; the error (or "saved, not running") is in the tooltip. */
export function ForwardStateLabel({ row, className }: { row: ForwardRow; className?: string }) {
  i18n.useLocale();
  const state = rowState(row);
  const title =
    row.live?.error ??
    (state === 'stopped' && row.saved?.start_on_connect
      ? i18n.t('Saved. Starts when the cluster connects.')
      : state === 'stopped'
        ? i18n.t('Saved, not running.')
        : undefined);
  return (
    <span
      className={cn('inline-flex min-w-0 items-center gap-1.5 font-medium', TONE[state], className)}
      title={title}
    >
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', DOT[state])} />
      <span className="truncate">{rowStateLabel(state)}</span>
    </span>
  );
}

/** Row actions: open / copy, start / restart / stop, save, start on connect, edit. */
export function ForwardRowActions({ row, className }: { row: ForwardRow; className?: string }) {
  i18n.useLocale();
  const { live, saved } = row;
  const state = rowState(row);
  const running = live && state !== 'error' && live.local_port > 0;
  const url = running ? forwardUrl(live.local_port) : '';
  return (
    <span className={cn('flex items-center justify-end gap-0.5', className)}>
      {running && (
        <>
          <IconButton
            size="xs"
            label={i18n.t('Open in browser')}
            icon={<ExternalLink />}
            onClick={() => void openExternal(url)}
          />
          <IconButton
            size="xs"
            label={i18n.t('Copy URL')}
            icon={<Copy />}
            onClick={() => void copyUrl(url)}
          />
        </>
      )}
      {live && state === 'error' && (
        <IconButton
          size="xs"
          tone="accent"
          label={i18n.t('Restart')}
          icon={<RotateCcw />}
          onClick={() => void restartForward(live)}
        />
      )}
      {!live && saved && (
        <IconButton
          size="xs"
          tone="accent"
          label={i18n.t('Start')}
          icon={<Play />}
          onClick={() => void startSaved(saved)}
        />
      )}
      <IconButton
        size="xs"
        tone="accent"
        label={saved ? i18n.t('Forget saved forward') : i18n.t('Save forward')}
        aria-pressed={!!saved}
        icon={<Star fill={saved ? 'currentColor' : 'none'} />}
        className={saved ? 'text-accent' : undefined}
        onClick={() => void toggleSaved(row)}
      />
      {saved && (
        <>
          <IconButton
            size="xs"
            tone="accent"
            label={
              saved.start_on_connect
                ? i18n.t('Starts when the cluster connects (click to turn off)')
                : i18n.t('Start when the cluster connects')
            }
            aria-pressed={saved.start_on_connect}
            icon={<Zap fill={saved.start_on_connect ? 'currentColor' : 'none'} />}
            className={saved.start_on_connect ? 'text-accent' : undefined}
            onClick={() => void toggleStartOnConnect(saved)}
          />
          <IconButton
            size="xs"
            label={i18n.t('Edit saved forward')}
            icon={<Pencil />}
            onClick={() => useConnectivityStore.getState().editSaved(saved)}
          />
        </>
      )}
      {live && (
        <IconButton
          size="xs"
          tone="danger"
          label={i18n.t('Stop')}
          icon={<Square />}
          onClick={() => void stopForward(live)}
        />
      )}
    </span>
  );
}
