import * as i18n from '@/i18n';
import { useMemo, useState } from 'react';
import { Braces, Copy, FileCode2, Loader2, Save, Sheet, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Checkbox, Radio } from '@/components/ui/Choice';
import { Dialog } from '@/components/ui/Dialog';
import type { ColumnContext, ColumnDef } from '@/lib/kube/columns';
import { cn } from '@/lib/cn';
import {
  exportFileName,
  objectsYaml,
  tableCsv,
  tableJson,
  type ExportFormat,
} from '@/lib/tableExport';
import { useAppStore } from '@/store/useAppStore';
import type { Gvk, KubeObject } from '@/types';
import { copyText } from '../dock/shared/platform';
import { errorText } from '../util';
import { saveExportFile, type ExportRequest } from './exportStore';

const PREVIEW_ROWS = 12;
const PREVIEW_LINES = 40;

const FORMATS: Array<{ id: ExportFormat; label: string; icon: LucideIcon }> = [
  { id: 'csv', label: 'CSV', icon: Sheet },
  { id: 'json', label: 'JSON', icon: Braces },
  { id: 'yaml', label: 'YAML', icon: FileCode2 },
];

/** Session-wide export options (the dialog remembers them while the app runs). */
let remembered = { excel: false, status: false, serverFields: false };

/**
 * Export the current table: visible columns in their order with the
 * current filter and sort (CSV / JSON), or full objects as multi-document
 * YAML. With a selection, only the selected rows by default.
 */
export function ExportDialog({
  request,
  clusterName,
  label,
  gvk,
  columns,
  items,
  selected,
  ctx,
  onClose,
}: {
  request: ExportRequest;
  clusterName: string;
  /** Plural kind label, e.g. "Pods". */
  label: string;
  gvk: Gvk;
  columns: ColumnDef[];
  items: KubeObject[];
  selected: KubeObject[];
  ctx: ColumnContext;
  onClose: () => void;
}) {
  i18n.useLocale();
  const [format, setFormat] = useState<ExportFormat>(request.format);
  const [onlySelected, setOnlySelected] = useState(
    selected.length > 0 && (request.selection ?? true),
  );
  const [options, setOptions] = useState(remembered);
  const { excel, status, serverFields } = options;
  const option = (key: keyof typeof remembered) => (value: boolean) =>
    setOptions((prev) => (remembered = { ...prev, [key]: value }));
  const [busy, setBusy] = useState<'copy' | 'save' | null>(null);
  const rows = onlySelected && selected.length ? selected : items;

  const render = (list: readonly KubeObject[]) =>
    format === 'csv'
      ? tableCsv(columns, list, ctx, { excel })
      : format === 'json'
        ? tableJson(columns, list, ctx)
        : objectsYaml(list, gvk, { status, serverFields });

  const preview = useMemo(() => {
    const text = render(rows.slice(0, PREVIEW_ROWS)).replace(/^﻿/, '');
    const lines = text.split(/\r?\n/);
    return lines.length > PREVIEW_LINES ? [...lines.slice(0, PREVIEW_LINES), '…'].join('\n') : text;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, format, excel, status, serverFields, columns, ctx, gvk]);

  const push = useAppStore.getState().pushToast;
  const what = FORMATS.find((f) => f.id === format)!.label;

  const copy = async () => {
    setBusy('copy');
    try {
      await copyText(render(rows).replace(/^﻿/, ''));
      push(
        'success',
        i18n.plural(
          'Copied {count} row as {format}',
          'Copied {count} rows as {format}',
          rows.length,
          {
            format: what,
          },
        ),
      );
      onClose();
    } catch (e) {
      push('error', errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy('save');
    try {
      const name = exportFileName([clusterName, gvk.plural], format);
      const path = await saveExportFile(name, render(rows), format);
      if (path) push('success', i18n.t('Saved {path}', { path }));
      onClose();
    } catch (e) {
      push('error', errorText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog
      title={i18n.t('Export {kind}', { kind: label })}
      subtitle={clusterName}
      onClose={onClose}
      size="lg"
      footer={
        <>
          <span className="text-fg-dim mr-auto text-[11.5px] tabular-nums">
            {format === 'yaml'
              ? i18n.plural('{count} object', '{count} objects', rows.length)
              : i18n.t('{rows} rows × {columns} columns', {
                  rows: rows.length,
                  columns: columns.length,
                })}
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={!!busy || !rows.length}
            onClick={() => void copy()}
            leftIcon={
              busy === 'copy' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )
            }
          >
            {i18n.t('Copy')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!!busy || !rows.length}
            onClick={() => void save()}
            leftIcon={
              busy === 'save' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )
            }
          >
            {i18n.t('Save…')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-4">
          <div
            role="radiogroup"
            aria-label={i18n.t('Format')}
            className="bg-surface-muted/50 border-border/60 flex items-center gap-0.5 rounded-lg border p-0.5"
          >
            {FORMATS.map((f) => {
              const Icon = f.icon;
              return (
                <button
                  key={f.id}
                  type="button"
                  role="radio"
                  aria-checked={format === f.id}
                  onClick={() => setFormat(f.id)}
                  className={cn(
                    'flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium transition',
                    format === f.id
                      ? 'bg-accent/15 text-accent'
                      : 'text-fg-dim hover:text-fg hover:bg-fg/4',
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {f.label}
                </button>
              );
            })}
          </div>
          <div role="radiogroup" aria-label={i18n.t('Rows')} className="flex items-center gap-4">
            <label className="text-fg-muted flex cursor-pointer items-center gap-2 text-[12px]">
              <Radio
                name="export-rows"
                checked={!onlySelected || !selected.length}
                onChange={() => setOnlySelected(false)}
                className="mt-0"
              />
              {i18n.t('All shown ({count})', { count: items.length })}
            </label>
            <label
              className={cn(
                'flex items-center gap-2 text-[12px]',
                selected.length ? 'text-fg-muted cursor-pointer' : 'text-fg-dim cursor-not-allowed',
              )}
            >
              <Radio
                name="export-rows"
                checked={onlySelected && selected.length > 0}
                disabled={!selected.length}
                onChange={() => setOnlySelected(true)}
                className="mt-0"
              />
              {i18n.t('Selected ({count})', { count: selected.length })}
            </label>
          </div>
        </div>

        <p className="text-fg-dim text-[11.5px] leading-snug">
          {format === 'yaml'
            ? i18n.t(
                'Full objects as multi-document YAML, in table order. Values are exported as the cluster returns them.',
              )
            : i18n.t(
                'Visible columns in their current order, with the current filter and sort. Values are exported as the cluster returns them.',
              )}
        </p>

        <div className="space-y-2">
          {format === 'csv' && (
            <Option
              checked={excel}
              onChange={option('excel')}
              label={i18n.t('Excel-friendly')}
              hint={i18n.t(
                'Adds a UTF-8 byte order mark and keeps text starting with = + - @ from running as a formula.',
              )}
            />
          )}
          {format === 'yaml' && (
            <>
              <Option
                checked={status}
                onChange={option('status')}
                label={i18n.t('Include status')}
                hint={i18n.t('Observed state; leave it out for manifests you want to apply.')}
              />
              <Option
                checked={serverFields}
                onChange={option('serverFields')}
                label={i18n.t('Keep server-managed fields')}
                hint={i18n.t(
                  'uid, resourceVersion, generation, creationTimestamp, managedFields and the last-applied annotation.',
                )}
              />
            </>
          )}
        </div>

        <div>
          <div className="text-fg-dim mb-1.5 text-[10px] font-semibold tracking-[0.12em] uppercase">
            {i18n.t('Preview')}
          </div>
          <pre className="border-border/60 bg-surface-muted/40 text-fg-muted overlay-scroll max-h-64 overflow-auto rounded-md border px-3 py-2 font-mono text-[11px] leading-[1.55] whitespace-pre">
            {preview || '—'}
          </pre>
        </div>
      </div>
    </Dialog>
  );
}

function Option({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2">
      <Checkbox checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="min-w-0">
        <span className="text-fg block text-[12px] font-medium">{label}</span>
        <span className="text-fg-dim block text-[11px] leading-snug">{hint}</span>
      </span>
    </label>
  );
}
