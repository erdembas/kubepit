import * as i18n from '@/i18n';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/Badge';
import { formatValue } from '@/lib/kube/schema/describe';
import { childrenOf, propertiesOf, type FieldInfo } from '@/lib/kube/schema/fields';
import type { KindEntry } from '@/lib/kube/schema/kinds';
import { childContainer, type SchemaNode, type SchemaSet } from '@/lib/kube/schema/openapi';
import { CopyButton } from '../details/primitives';

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h4 className="text-fg-dim text-[10.5px] font-semibold tracking-[0.08em] uppercase">
        {label}
      </h4>
      {children}
    </section>
  );
}

function Chips({ values }: { values: string[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {values.map((value) => (
        <code
          key={value}
          className="bg-fg/5 border-border/60 text-fg-muted rounded border px-1.5 py-0.5 font-mono text-[10.5px] break-all"
        >
          {value}
        </code>
      ))}
    </div>
  );
}

function FieldLinks({
  fields,
  onOpen,
}: {
  fields: FieldInfo[];
  onOpen: (field: FieldInfo) => void;
}) {
  return (
    <div className="-mx-1.5 flex flex-col">
      {fields.map((field) => (
        <button
          key={field.name}
          type="button"
          onClick={() => onOpen(field)}
          className="hover:bg-fg/5 flex min-w-0 items-center gap-2 rounded px-1.5 py-0.5 text-left"
        >
          <span className="text-fg shrink-0 font-mono text-[11.5px]">{field.name}</span>
          {field.required && <span className="text-accent text-[11px]">*</span>}
          <span className="text-fg-dim min-w-0 truncate font-mono text-[10.5px]">{field.type}</span>
        </button>
      ))}
    </div>
  );
}

/** Everything about the selected field, or the kind itself when nothing is selected. */
export function FieldDetails({
  set,
  root,
  entry,
  apiVersion,
  field,
  onOpen,
}: {
  set: SchemaSet;
  root: SchemaNode;
  entry: KindEntry | null;
  apiVersion: string;
  field: FieldInfo | null;
  onOpen: (field: FieldInfo) => void;
}) {
  i18n.useLocale();
  const kind = entry?.kind ?? root.gvk[0]?.kind ?? '';
  const node = field?.node ?? root;
  const children = field ? childrenOf(set, field) : propertiesOf(set, root);
  const path = field ? field.path.join('.') : '';
  const copyText = field ? `${kind.toLowerCase()}.${path}` : `${apiVersion} ${kind}`;
  const container = childContainer(set, node);

  return (
    <aside
      aria-label={i18n.t('Field details')}
      className="border-border/60 hidden w-[340px] shrink-0 flex-col border-l @3xl:flex"
    >
      <div className="border-border/60 flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <span className="text-fg-dim text-[10.5px] font-semibold tracking-[0.08em] uppercase">
          {field ? i18n.t('Field') : i18n.t('Kind')}
        </span>
        <span className="ml-auto">
          <CopyButton
            text={copyText}
            label={field ? i18n.t('Copy field path') : i18n.t('Copy apiVersion and kind')}
          />
        </span>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <div className="space-y-1">
          <div className="text-fg font-mono text-[13px] font-semibold break-all">
            {field ? field.name : kind}
          </div>
          <div className="text-fg-dim font-mono text-[11px] break-all">
            {field ? `${kind}.${path}` : apiVersion}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {field && (
            <Badge tone="neutral" size="xs" className="font-mono normal-case">
              {field.type}
            </Badge>
          )}
          {field?.required && (
            <Badge tone="accent" size="xs">
              {i18n.t('Required')}
            </Badge>
          )}
          {field && !field.required && (
            <Badge tone="neutral" variant="outline" size="xs">
              {i18n.t('Optional')}
            </Badge>
          )}
          {field?.deprecated && (
            <Badge tone="warning" size="xs">
              {i18n.t('Deprecated')}
            </Badge>
          )}
          {!field && entry && (
            <Badge tone="neutral" size="xs">
              {entry.namespaced ? i18n.t('Namespaced') : i18n.t('Cluster-scoped')}
            </Badge>
          )}
        </div>
        <Section label={i18n.t('Description')}>
          <p className="text-fg-muted text-[12px] leading-relaxed break-words whitespace-pre-wrap">
            {node.description || i18n.t('No description.')}
          </p>
        </Section>
        {!field && entry && (
          <Section label={i18n.t('Resource')}>
            <Chips values={[entry.plural, ...entry.shortNames]} />
          </Section>
        )}
        {field?.enum && field.enum.length > 0 && (
          <Section label={i18n.t('Allowed values')}>
            <Chips values={field.enum.map(formatValue)} />
          </Section>
        )}
        {field?.hasDefault && (
          <Section label={i18n.t('Default')}>
            <Chips values={[formatValue(field.default)]} />
          </Section>
        )}
        {field?.format && (
          <Section label={i18n.t('Value format')}>
            <Chips values={[field.format]} />
          </Section>
        )}
        {field && field.hints.length > 0 && (
          <Section label={i18n.t('Kubernetes markers')}>
            <Chips values={field.hints} />
          </Section>
        )}
        {container.validations.length > 0 && (
          <Section label={i18n.t('Validation rules')}>
            <ul className="space-y-1.5">
              {container.validations.map((v) => (
                <li key={v.rule} className="space-y-0.5">
                  <code className="text-fg-muted block font-mono text-[10.5px] break-all">
                    {v.rule}
                  </code>
                  {v.message && <p className="text-fg-dim text-[11px]">{v.message}</p>}
                </li>
              ))}
            </ul>
          </Section>
        )}
        {children.length > 0 && (
          <Section label={i18n.t('Fields')}>
            <FieldLinks fields={children} onOpen={onOpen} />
          </Section>
        )}
      </div>
    </aside>
  );
}
