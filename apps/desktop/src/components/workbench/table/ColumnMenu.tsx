import * as i18n from '@/i18n';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Columns3, GripVertical } from 'lucide-react';
import { Checkbox } from '@/components/ui/Choice';
import { IconButton } from '@/components/ui/IconButton';
import type { ColumnDef } from '@/lib/kube/columns';
import { cn } from '@/lib/cn';
import { useWorkbenchStore } from '@/store/useWorkbenchStore';
import { moveColumn } from './tableModel';

/** Column visibility and order popover (persisted per kind). */
export function ColumnMenu({
  kind,
  columns,
  hidden,
}: {
  kind: string;
  /** Every column of the kind, in the user's order. */
  columns: ColumnDef[];
  hidden: ReadonlySet<string>;
}) {
  i18n.useLocale();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ right: number; top: number } | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const fixed = columns.filter((c) => c.fixed);
  const movable = columns.filter((c) => !c.fixed);

  useLayoutEffect(() => {
    if (!open) return;
    const r = trigger.current?.getBoundingClientRect();
    if (r) setPos({ right: window.innerWidth - r.right, top: r.bottom + 6 });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !trigger.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    useWorkbenchStore
      .getState()
      .setColumnOrder(kind, moveColumn(columns, String(active.id), String(over.id)));
  };

  return (
    <>
      <IconButton
        ref={trigger}
        label={i18n.t('Columns')}
        icon={<Columns3 />}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      />
      {open &&
        pos &&
        createPortal(
          <div
            ref={panel}
            role="menu"
            className="border-border bg-surface-overlay animate-fade-in fixed z-70 flex max-h-[70vh] w-60 flex-col rounded-lg border p-1 shadow-[0_12px_40px_rgba(0,0,0,0.35)]"
            style={{ right: pos.right, top: pos.top }}
          >
            <div className="text-fg-dim flex items-baseline justify-between px-2 pt-1.5 pb-1">
              <span className="text-[10px] font-semibold tracking-[0.12em] uppercase">
                {i18n.t('Columns')}
              </span>
              <span className="text-[10.5px]">{i18n.t('Drag to reorder')}</span>
            </div>
            <div className="overlay-scroll min-h-0 flex-1 overflow-y-auto">
              {fixed.map((c) => (
                <ColumnRow key={c.id} kind={kind} column={c} visible />
              ))}
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={onDragEnd}
              >
                <SortableContext
                  items={movable.map((c) => c.id)}
                  strategy={verticalListSortingStrategy}
                >
                  {movable.map((c) => (
                    <SortableColumnRow
                      key={c.id}
                      kind={kind}
                      column={c}
                      visible={!hidden.has(c.id)}
                    />
                  ))}
                </SortableContext>
              </DndContext>
            </div>
            <div className="border-border/60 mt-1 border-t pt-1">
              <button
                type="button"
                onClick={() => useWorkbenchStore.getState().resetColumns(kind)}
                className="text-fg-dim hover:text-accent w-full rounded-md px-2 py-1.5 text-left text-[11.5px]"
              >
                {i18n.t('Reset to defaults')}
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

function SortableColumnRow({
  kind,
  column,
  visible,
}: {
  kind: string;
  column: ColumnDef;
  visible: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: column.id,
  });
  return (
    <ColumnRow
      kind={kind}
      column={column}
      visible={visible}
      rowRef={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      dragging={isDragging}
      handle={
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={i18n.t('Move column {column}', { column: column.label() })}
          className="text-fg-dim/60 hover:text-fg flex h-5 w-4 shrink-0 cursor-grab items-center justify-center rounded active:cursor-grabbing"
        >
          <GripVertical className="h-3 w-3" />
        </button>
      }
    />
  );
}

function ColumnRow({
  kind,
  column,
  visible,
  handle,
  rowRef,
  style,
  dragging = false,
}: {
  kind: string;
  column: ColumnDef;
  visible: boolean;
  handle?: React.ReactNode;
  rowRef?: (el: HTMLElement | null) => void;
  style?: React.CSSProperties;
  dragging?: boolean;
}) {
  i18n.useLocale();
  return (
    <div
      ref={rowRef}
      style={style}
      className={cn(
        'relative flex items-center gap-1 rounded-md pr-2 pl-0.5 text-[12px]',
        column.fixed ? 'text-fg-dim' : 'text-fg-muted hover:bg-fg/4 hover:text-fg',
        dragging && 'bg-surface-overlay z-10 shadow-[0_6px_18px_rgba(0,0,0,0.3)]',
      )}
    >
      {handle ?? <span className="w-4 shrink-0" aria-hidden />}
      <label
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2 py-1.5',
          column.fixed ? 'cursor-not-allowed' : 'cursor-pointer',
        )}
      >
        <Checkbox
          checked={visible}
          disabled={column.fixed}
          onChange={() => useWorkbenchStore.getState().toggleColumn(kind, column.id)}
          className="mt-0"
        />
        <span className="truncate">{column.label()}</span>
      </label>
    </div>
  );
}
