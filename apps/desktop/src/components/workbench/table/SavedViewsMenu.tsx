import * as i18n from '@/i18n';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Bookmark,
  BookmarkCheck,
  Check,
  ChevronDown,
  LayoutList,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Star,
  Trash2,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { isDefault, matchesView, viewsFor, type SavedView } from '@/lib/savedViews';
import { useAppStore } from '@/store/useAppStore';
import { sameView, useBookmarksStore } from '@/store/useBookmarksStore';
import { useSavedViewsStore } from '@/store/useSavedViewsStore';
import {
  applySavedView,
  clearTableView,
  updateSavedView,
  useSaveViewDialog,
  useTableState,
} from './savedViews';

/** Quick switcher for a kind's saved views in the resource page header. */
export function SavedViewsMenu({ clusterId, kindKey }: { clusterId: string; kindKey: string }) {
  i18n.useLocale();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const allViews = useSavedViewsStore((s) => s.views);
  const defaults = useSavedViewsStore((s) => s.defaults);
  const appliedId = useSavedViewsStore((s) => s.applied[`${clusterId}|${kindKey}`] ?? null);
  const bookmarks = useBookmarksStore((s) => s.bookmarks);
  const state = useTableState(clusterId, kindKey);
  const views = useMemo(
    () => viewsFor(allViews, clusterId, kindKey),
    [allViews, clusterId, kindKey],
  );
  const applied = views.find((v) => v.id === appliedId) ?? null;
  const modified = !!applied && !matchesView(applied, state);
  const viewBookmarked = bookmarks.some((b) =>
    sameView(b, clusterId, kindKey, applied && !modified ? applied.id : null),
  );

  useLayoutEffect(() => {
    if (!open) return;
    const r = trigger.current?.getBoundingClientRect();
    if (r) setPos({ left: r.left, top: r.bottom + 6 });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !trigger.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target as HTMLElement | null)?.closest('input')) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const close = () => setOpen(false);
  const toast = useAppStore.getState().pushToast;

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={i18n.t('Saved views')}
        className={cn(
          'flex h-6 max-w-44 min-w-0 shrink items-center gap-1 rounded-md px-1.5 text-[11.5px] transition-colors',
          applied ? 'text-fg' : 'text-fg-dim',
          'hover:bg-fg/5 hover:text-fg',
        )}
      >
        <LayoutList className={cn('h-3.5 w-3.5 shrink-0', applied && 'text-accent')} />
        <span className="min-w-0 truncate">{applied ? applied.name : i18n.t('Views')}</span>
        {modified && (
          <span
            className="bg-status-starting h-1.5 w-1.5 shrink-0 rounded-full"
            aria-label={i18n.t('Modified')}
            title={i18n.t('The table no longer matches this view')}
          />
        )}
        <ChevronDown className="h-3 w-3 shrink-0 opacity-70" />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={panel}
            role="menu"
            className="border-border bg-surface-overlay animate-fade-in fixed z-70 flex max-h-[70vh] w-72 flex-col rounded-lg border p-1 shadow-[0_12px_40px_rgba(0,0,0,0.35)]"
            style={{ left: pos.left, top: pos.top }}
          >
            <div className="text-fg-dim px-2 pt-1.5 pb-1 text-[10px] font-semibold tracking-[0.12em] uppercase">
              {i18n.t('Saved views')}
            </div>
            <div className="overlay-scroll min-h-0 flex-1 overflow-y-auto">
              {views.length === 0 && (
                <p className="text-fg-dim px-2 py-2 text-[11.5px] leading-snug">
                  {i18n.t(
                    'Save the filter, namespaces, columns and sort of this table to switch back to them later.',
                  )}
                </p>
              )}
              {views.map((view) => (
                <ViewRow
                  key={view.id}
                  view={view}
                  active={view.id === appliedId}
                  modified={view.id === appliedId && modified}
                  isDefault={isDefault(view, defaults)}
                  onApply={() => {
                    applySavedView(clusterId, view);
                    close();
                  }}
                  onDelete={() => {
                    useSavedViewsStore.getState().remove(view.id);
                    useBookmarksStore.getState().forgetView(view.id);
                    toast('success', i18n.t('Deleted view “{name}”', { name: view.name }));
                  }}
                />
              ))}
            </div>
            <div className="border-border/60 mt-1 border-t pt-1">
              <MenuAction
                icon={Plus}
                label={i18n.t('Save current view…')}
                onClick={() => {
                  close();
                  useSaveViewDialog.getState().open(clusterId, kindKey);
                }}
              />
              {applied && modified && (
                <MenuAction
                  icon={Save}
                  label={i18n.t('Update “{name}”', { name: applied.name })}
                  onClick={() => {
                    updateSavedView(clusterId, applied);
                    toast('success', i18n.t('Updated view “{name}”', { name: applied.name }));
                    close();
                  }}
                />
              )}
              <MenuAction
                icon={viewBookmarked ? BookmarkCheck : Bookmark}
                label={viewBookmarked ? i18n.t('Remove bookmark') : i18n.t('Bookmark this view')}
                onClick={() => {
                  const added = useBookmarksStore
                    .getState()
                    .toggleView(clusterId, kindKey, applied && !modified ? applied.id : null);
                  toast('success', added ? i18n.t('Bookmark added') : i18n.t('Bookmark removed'));
                  close();
                }}
              />
              <MenuAction
                icon={RotateCcw}
                label={i18n.t('Reset table')}
                hint={i18n.t('filter, columns, sort')}
                onClick={() => {
                  clearTableView(clusterId, kindKey);
                  close();
                }}
              />
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

function MenuAction({
  icon: Icon,
  label,
  hint,
  onClick,
}: {
  icon: typeof Plus;
  label: string;
  hint?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="text-fg-muted hover:bg-fg/4 hover:text-fg flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px]"
    >
      <Icon className="text-fg-dim h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && <span className="text-fg-dim shrink-0 text-[10.5px]">{hint}</span>}
    </button>
  );
}

function ViewRow({
  view,
  active,
  modified,
  isDefault: isDefaultView,
  onApply,
  onDelete,
}: {
  view: SavedView;
  active: boolean;
  modified: boolean;
  isDefault: boolean;
  onApply: () => void;
  onDelete: () => void;
}) {
  i18n.useLocale();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(view.name);
  const store = useSavedViewsStore.getState;

  if (editing)
    return (
      <div className="px-1 py-0.5">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              store().rename(view.id, name);
              setEditing(false);
            } else if (e.key === 'Escape') {
              e.stopPropagation();
              setName(view.name);
              setEditing(false);
            }
          }}
          aria-label={i18n.t('View name')}
          className="border-accent/60 bg-surface text-fg w-full rounded-md border px-2 py-1 text-[12px] outline-none"
        />
      </div>
    );

  return (
    <div
      className={cn(
        'group relative flex items-center gap-1 rounded-md pr-1',
        active ? 'bg-fg/7' : 'hover:bg-fg/4',
      )}
    >
      {active && (
        <span
          className="bg-accent absolute top-1.5 bottom-1.5 left-0 w-[2px] rounded-full"
          aria-hidden
        />
      )}
      <button
        type="button"
        role="menuitem"
        onClick={onApply}
        className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-2 text-left"
      >
        <Check
          className={cn('h-3.5 w-3.5 shrink-0', active && !modified ? 'text-accent' : 'opacity-0')}
        />
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              'block truncate text-[12px]',
              active ? 'text-fg font-medium' : 'text-fg-muted',
            )}
          >
            {view.name}
          </span>
          <span className="text-fg-dim block truncate text-[10.5px]">
            {view.clusterId ? i18n.t('This cluster') : i18n.t('All clusters')}
            {view.filter && ` · ${view.filter}`}
          </span>
        </span>
      </button>
      <RowButton
        label={isDefaultView ? i18n.t('Remove as default') : i18n.t('Set as default')}
        pressed={isDefaultView}
        onClick={() => store().setDefault(view.id, !isDefaultView)}
        visible={isDefaultView}
      >
        <Star className={cn('h-3 w-3', isDefaultView && 'text-accent fill-current')} />
      </RowButton>
      <RowButton
        label={i18n.t('Rename')}
        onClick={() => {
          setName(view.name);
          setEditing(true);
        }}
      >
        <Pencil className="h-3 w-3" />
      </RowButton>
      <RowButton label={i18n.t('Delete')} onClick={onDelete} danger>
        <Trash2 className="h-3 w-3" />
      </RowButton>
    </div>
  );
}

function RowButton({
  label,
  onClick,
  children,
  pressed,
  visible = false,
  danger = false,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  pressed?: boolean;
  visible?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        'flex h-6 w-6 shrink-0 items-center justify-center rounded transition',
        danger ? 'text-fg-dim hover:text-status-error' : 'text-fg-dim hover:text-fg',
        visible ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
      )}
    >
      {children}
    </button>
  );
}
