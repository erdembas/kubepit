import * as i18n from '@/i18n';
import { useEffect, useRef, type ComponentType } from 'react';
import {
  File,
  FileArchive,
  FileCode2,
  FileImage,
  FileSymlink,
  FileText,
  Folder,
  FolderSymlink,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { formatAge, formatBytes } from '@/lib/format';
import type { PodFsEntry } from '@/types';
import { fileVisual, isDirLike, type FileVisual } from './model';

const ICONS: Record<FileVisual, ComponentType<{ className?: string }>> = {
  dir: Folder,
  'dir-link': FolderSymlink,
  link: FileSymlink,
  image: FileImage,
  archive: FileArchive,
  code: FileCode2,
  text: FileText,
  other: File,
};

export const FILE_ROW_HEIGHT = 28;
// The Mode column only shows when the table is wide enough (container query).
const GRID = 'grid-cols-[minmax(0,1fr)_72px_56px] @lg:grid-cols-[minmax(0,1fr)_80px_64px_92px]';

interface Props {
  entries: PodFsEntry[];
  selected: string | null;
  now: number;
  onSelect: (name: string) => void;
  onOpen: (entry: PodFsEntry) => void;
  onContextMenu: (entry: PodFsEntry, x: number, y: number) => void;
}

/** Directory listing in the resource table's visual language (sticky header, accent strip). */
export function FileTable({ entries, selected, now, onSelect, onOpen, onContextMenu }: Props) {
  i18n.useLocale();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!selected) return;
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-name="${CSS.escape(selected)}"]`,
    );
    row?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  return (
    <div ref={listRef} role="grid" className="@container min-h-0 flex-1 overflow-auto">
      <div
        role="row"
        style={{ height: FILE_ROW_HEIGHT }}
        className={cn(
          'border-border/70 text-fg-dim bg-surface/95 sticky top-0 z-10 grid items-center gap-x-2.5 border-b px-3 text-[10.5px] font-semibold tracking-[0.08em] uppercase backdrop-blur-sm',
          GRID,
        )}
      >
        <span role="columnheader">{i18n.t('Name')}</span>
        <span role="columnheader" className="text-right">
          {i18n.t('Size')}
        </span>
        <span role="columnheader" className="text-right">
          {i18n.t('Modified')}
        </span>
        <span role="columnheader" className="hidden @lg:block">
          {i18n.t('Mode')}
        </span>
      </div>
      {entries.map((entry) => {
        const Icon = ICONS[fileVisual(entry)];
        const active = entry.name === selected;
        const dir = isDirLike(entry);
        return (
          <div
            key={entry.name}
            role="row"
            aria-selected={active}
            data-name={entry.name}
            style={{ height: FILE_ROW_HEIGHT }}
            onClick={() => onSelect(entry.name)}
            onDoubleClick={() => onOpen(entry)}
            onContextMenu={(e) => {
              e.preventDefault();
              onSelect(entry.name);
              onContextMenu(entry, e.clientX, e.clientY);
            }}
            className={cn(
              'border-border/40 grid cursor-default items-center gap-x-2.5 border-b px-3 text-[12px] transition-colors select-none',
              GRID,
              active ? 'bg-fg/7 shadow-[inset_2px_0_0_rgb(var(--accent))]' : 'hover:bg-fg/4',
            )}
          >
            <span role="gridcell" className="flex min-w-0 items-center gap-2">
              <Icon className={cn('h-3.5 w-3.5 shrink-0', dir ? 'text-accent' : 'text-fg-dim')} />
              <span className="text-fg truncate" title={entry.name}>
                {entry.name}
              </span>
              {entry.link_target !== null && (
                <span className="text-fg-dim min-w-0 truncate font-mono text-[11px]">
                  → {entry.link_target}
                </span>
              )}
            </span>
            <span role="gridcell" className="text-fg-muted text-right tabular-nums">
              {dir || entry.size === null ? '—' : formatBytes(entry.size)}
            </span>
            <span
              role="gridcell"
              className="text-fg-muted text-right tabular-nums"
              title={
                entry.modified === null
                  ? undefined
                  : i18n.date(entry.modified * 1000, { dateStyle: 'medium', timeStyle: 'medium' })
              }
            >
              {entry.modified === null ? '—' : formatAge(entry.modified * 1000, now)}
            </span>
            <span
              role="gridcell"
              className="text-fg-dim hidden truncate font-mono text-[11px] @lg:block"
            >
              {entry.mode ?? '—'}
            </span>
          </div>
        );
      })}
    </div>
  );
}
