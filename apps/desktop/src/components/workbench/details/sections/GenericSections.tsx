import * as i18n from '@/i18n';
import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { asArray, asObject, asString, isObject, spec } from '@/lib/kube/accessors';
import { printerColumns } from '@/lib/kube/columns';
import { cn } from '@/lib/cn';
import { navigateTo } from '@/store/useWorkbenchStore';
import { ChipList, MiniTable, MonoText, Row, Rows, Section, ToneText } from '../primitives';
import { ConditionsTable } from './PodSections';
import type { SectionProps } from './types';

function Scalar({ value }: { value: unknown }) {
  if (value === null) return <span className="text-fg-dim">null</span>;
  if (typeof value === 'boolean') return <span className="text-cat-backend">{String(value)}</span>;
  if (typeof value === 'number')
    return <span className="text-cat-frontend tabular-nums">{value}</span>;
  return <span className="text-fg break-all">{String(value)}</span>;
}

function TreeNode({ name, value, depth }: { name: string; value: unknown; depth: number }) {
  const nested = isObject(value) || Array.isArray(value);
  const size = Array.isArray(value)
    ? value.length
    : isObject(value)
      ? Object.keys(value).length
      : 0;
  const [open, setOpen] = useState(depth < 2 && size <= 30);
  if (!nested)
    return (
      <div
        className="flex gap-2 py-0.5 font-mono text-[11px]"
        style={{ paddingLeft: depth * 14 + 14 }}
      >
        <span className="text-fg-dim shrink-0">{name}:</span>
        <Scalar value={value} />
      </div>
    );
  const entries: Array<[string, unknown]> = Array.isArray(value)
    ? value.slice(0, 100).map((v, i) => [`[${i}]`, v])
    : Object.entries(value as Record<string, unknown>);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((x) => !x)}
        className="hover:bg-fg/4 flex w-full items-center gap-1 rounded py-0.5 text-left font-mono text-[11px]"
        style={{ paddingLeft: depth * 14 }}
        aria-expanded={open}
      >
        <ChevronRight
          className={cn('text-fg-dim h-3 w-3 shrink-0 transition-transform', open && 'rotate-90')}
        />
        <span className="text-fg-muted">{name}</span>
        <span className="text-fg-dim text-[10px]">
          {Array.isArray(value) ? `[${size}]` : `{${size}}`}
        </span>
      </button>
      {open && entries.map(([k, v]) => <TreeNode key={k} name={k} value={v} depth={depth + 1} />)}
    </div>
  );
}

export function JsonTree({ value }: { value: Record<string, unknown> }) {
  return (
    <div className="-mx-1">
      {Object.entries(value).map(([k, v]) => (
        <TreeNode key={k} name={k} value={v} depth={0} />
      ))}
    </div>
  );
}

const SKIP = new Set(['apiVersion', 'kind', 'metadata']);

/** Fallback for kinds without a dedicated view: conditions + collapsible key/value trees. */
export function GenericSections({ obj, ctx }: SectionProps) {
  i18n.useLocale();
  const hasConditions = asArray(asObject(obj.status).conditions).length > 0;
  const top = Object.entries(obj).filter(([k, v]) => !SKIP.has(k) && v !== undefined && v !== null);
  return (
    <>
      {hasConditions && (
        <Section title={i18n.t('Conditions')}>
          <ConditionsTable obj={obj} now={ctx.now} />
        </Section>
      )}
      {top.map(([k, v]) => (
        <Section key={k} title={k}>
          {isObject(v) ? (
            <JsonTree value={v} />
          ) : Array.isArray(v) ? (
            <JsonTree value={{ [k]: v }} />
          ) : (
            <Scalar value={v} />
          )}
        </Section>
      ))}
    </>
  );
}

export function CrdSections({ obj, ctx }: SectionProps) {
  i18n.useLocale();
  const s = spec(obj);
  const names = asObject(s.names);
  const versions = asArray(s.versions).filter(isObject);
  const storage = versions.find((v) => v.storage === true) ?? versions[0];
  const columns = printerColumns(obj, asString(storage?.name));
  const open = () =>
    navigateTo(ctx.clusterId, {
      group: asString(s.group),
      version: asString(storage?.name),
      kind: asString(names.kind),
      plural: asString(names.plural),
      namespaced: asString(s.scope) === 'Namespaced',
    });
  return (
    <>
      <Section
        title={i18n.t('Definition')}
        actions={
          <button
            type="button"
            onClick={open}
            className="text-accent text-[11.5px] hover:underline"
          >
            {i18n.t('Browse {kind}', { kind: asString(names.kind) })}
          </button>
        }
      >
        <Rows>
          <Row label={i18n.t('Group')}>
            <MonoText>{asString(s.group)}</MonoText>
          </Row>
          <Row label={i18n.t('Kind')}>{asString(names.kind)}</Row>
          <Row label={i18n.t('Plural')}>
            <MonoText>{asString(names.plural)}</MonoText>
          </Row>
          <Row label={i18n.t('Singular')}>
            <MonoText>{asString(names.singular)}</MonoText>
          </Row>
          <Row label={i18n.t('Short names')}>
            {asArray(names.shortNames).length > 0 && (
              <ChipList entries={asArray(names.shortNames).map((x) => asString(x))} />
            )}
          </Row>
          <Row label={i18n.t('Categories')}>
            {asArray(names.categories).length > 0 && (
              <ChipList entries={asArray(names.categories).map((x) => asString(x))} />
            )}
          </Row>
          <Row label={i18n.t('Scope')}>{asString(s.scope)}</Row>
          <Row label={i18n.t('Conversion')}>{asString(asObject(s.conversion).strategy)}</Row>
        </Rows>
      </Section>
      <Section title={i18n.t('Versions')}>
        <MiniTable
          rows={versions}
          rowKey={(v) => asString(v.name)}
          columns={[
            { label: i18n.t('Name'), cell: (v) => <MonoText>{asString(v.name)}</MonoText> },
            {
              label: i18n.t('Served'),
              cell: (v) => (
                <ToneText tone={v.served === false ? 'muted' : 'success'}>
                  {v.served === false ? i18n.t('No') : i18n.t('Yes')}
                </ToneText>
              ),
            },
            { label: i18n.t('Storage'), cell: (v) => (v.storage === true ? i18n.t('Yes') : '—') },
            {
              label: i18n.t('Deprecated'),
              cell: (v) =>
                v.deprecated === true ? <ToneText tone="warning">{i18n.t('Yes')}</ToneText> : '—',
            },
          ]}
        />
      </Section>
      {columns.length > 0 && (
        <Section title={i18n.t('Printer columns')}>
          <MiniTable
            rows={columns}
            rowKey={(c) => c.name}
            columns={[
              { label: i18n.t('Name'), cell: (c) => <span className="text-fg">{c.name}</span> },
              { label: i18n.t('Type'), cell: (c) => c.type },
              { label: 'JSONPath', lang: 'en', cell: (c) => <MonoText>{c.jsonPath}</MonoText> },
              { label: i18n.t('Priority'), cell: (c) => c.priority ?? 0 },
            ]}
          />
        </Section>
      )}
      <Section title={i18n.t('Conditions')}>
        <ConditionsTable obj={obj} now={ctx.now} />
      </Section>
    </>
  );
}
