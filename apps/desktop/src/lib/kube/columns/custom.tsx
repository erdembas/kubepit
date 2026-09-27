import * as i18n from '@/i18n/core';
import { formatAge } from '@/lib/format';
import type { Gvk, KubeObject } from '@/types';
import { asArray, asObject, asString, isObject, spec } from '../accessors';
import { evalJsonPath, jsonPathText } from '../jsonpath';
import { phaseTone } from '../workloads';
import { ageColumn, Chips, Dash, Mono, Muted, nameColumn, namespaceColumn, Tone } from './cells';
import type { ColumnDef, KindColumns } from './types';
import type { PrinterColumn } from './index';

function printerCell(col: PrinterColumn): ColumnDef['cell'] {
  return (o, ctx) => {
    const text = jsonPathText(o, col.jsonPath);
    if (!text) return <Dash />;
    if (col.type === 'date')
      return (
        <span className="text-fg-muted tabular-nums" title={text}>
          {formatAge(text, ctx.now)}
        </span>
      );
    if (col.type === 'integer' || col.type === 'number') return <Muted>{text}</Muted>;
    const tone = phaseTone(text);
    if (tone !== 'muted' && text.length < 24) return <Tone tone={tone}>{text}</Tone>;
    return <Muted title={text}>{text}</Muted>;
  };
}

/** Generic columns for custom resources: name, namespace, printer columns, age. */
export function customColumns(gvk: Gvk, printer: PrinterColumn[]): KindColumns {
  const extra: ColumnDef[] = printer
    .filter((c) => c.jsonPath !== '.metadata.creationTimestamp')
    .map((c, i) => ({
      id: `pc${i}:${c.name}`,
      label: () => c.name,
      width:
        c.type === 'date'
          ? '84px'
          : c.type === 'integer' || c.type === 'number'
            ? '84px'
            : 'minmax(110px, 1.2fr)',
      align: c.type === 'date' || c.type === 'integer' || c.type === 'number' ? 'right' : undefined,
      defaultHidden: (c.priority ?? 0) > 0,
      cell: printerCell(c),
      sort: (o: KubeObject) => {
        const v = evalJsonPath(o, c.jsonPath);
        if (c.type === 'date') return -Date.parse(String(v ?? '0'));
        return typeof v === 'number' ? v : String(v ?? '');
      },
    }));
  return {
    searchText: (o) => printer.map((c) => jsonPathText(o, c.jsonPath)).join(' '),
    columns: [nameColumn, ...(gvk.namespaced ? [namespaceColumn] : []), ...extra, ageColumn],
  };
}

export const crdDefinitionColumns: KindColumns = {
  searchText: (o) => `${asString(spec(o).group)} ${asString(asObject(spec(o).names).kind)}`,
  columns: [
    { ...nameColumn, width: 'minmax(240px, 3fr)' },
    {
      id: 'group',
      label: () => i18n.t('Group'),
      width: 'minmax(150px, 1.6fr)',
      cell: (o) => <Mono>{asString(spec(o).group)}</Mono>,
      sort: (o) => asString(spec(o).group),
    },
    {
      id: 'kind',
      label: () => i18n.t('Kind'),
      width: 'minmax(110px, 1fr)',
      cell: (o) => <Muted>{asString(asObject(spec(o).names).kind)}</Muted>,
      sort: (o) => asString(asObject(spec(o).names).kind),
    },
    {
      id: 'versions',
      label: () => i18n.t('Versions'),
      width: 'minmax(96px, 1fr)',
      cell: (o) => (
        <Chips
          values={asArray(spec(o).versions)
            .filter(isObject)
            .filter((v) => v.served !== false)
            .map((v) => asString(v.name))}
        />
      ),
    },
    {
      id: 'scope',
      label: () => i18n.t('Scope'),
      width: '96px',
      cell: (o) => <Muted>{asString(spec(o).scope)}</Muted>,
      sort: (o) => asString(spec(o).scope),
    },
    ageColumn,
  ],
};
