import * as i18n from '@/i18n';
import { useId, useMemo } from 'react';
import { X } from 'lucide-react';
import { Select } from '@/components/ui/Select';
import { cn } from '@/lib/cn';
import {
  LOKI_WORKLOAD_KINDS,
  quote,
  workloadPodRegex,
  workloadsOfPods,
  type LineFilterOp,
  type LokiBuilder,
  type LokiLabelNames,
  type ParserStage,
} from '@/lib/logs/logql';
import type { ClusterId } from '@/types';
import { useLokiValues } from './useLoki';

const LINE_OPS: LineFilterOp[] = ['|=', '!=', '|~', '!~'];

/** `Deployment/web` ⇄ `{ kind, name }`; a bare name matches `name-…` pods. */
function formatWorkload(w: LokiBuilder['workload']): string {
  return w ? (w.kind ? `${w.kind}/${w.name}` : w.name) : '';
}

function parseWorkload(text: string): LokiBuilder['workload'] {
  const value = text.trim();
  if (!value) return null;
  const slash = value.indexOf('/');
  if (slash > 0 && LOKI_WORKLOAD_KINDS.has(value.slice(0, slash)))
    return { kind: value.slice(0, slash), name: value.slice(slash + 1) };
  return { kind: '', name: value };
}

/**
 * The Loki tab's query builder: namespace, workload, pod and container
 * pickers (suggestions from Loki's own label values over the range), a
 * line filter and a parser stage. Wraps to more rows in narrow docks.
 */
export function LokiBuilderRow({
  clusterId,
  builder,
  names,
  bounds,
  rangeKey,
  enabled,
  onChange,
}: {
  clusterId: ClusterId;
  builder: LokiBuilder;
  names: LokiLabelNames;
  bounds: { start: string; end: string };
  rangeKey: string;
  enabled: boolean;
  onChange: (next: LokiBuilder) => void;
}) {
  i18n.useLocale();
  const set = <K extends keyof LokiBuilder>(key: K, value: LokiBuilder[K]) =>
    onChange({ ...builder, [key]: value });

  const namespaces = useLokiValues(clusterId, names.namespace, bounds, null, rangeKey, enabled);
  const nsKnown = !!builder.namespace && (namespaces.data ?? []).includes(builder.namespace);
  const nsSelector = nsKnown ? `{${names.namespace}=${quote(builder.namespace!)}}` : null;
  const pods = useLokiValues(
    clusterId,
    names.pod,
    bounds,
    nsSelector,
    rangeKey,
    enabled && nsKnown,
  );
  const podScope = builder.pod
    ? `${names.pod}=${quote(builder.pod)}`
    : builder.workload
      ? `${names.pod}=~${quote(workloadPodRegex(builder.workload.kind, builder.workload.name))}`
      : null;
  const containerSelector =
    nsSelector && podScope ? `${nsSelector.slice(0, -1)}, ${podScope}}` : null;
  const containers = useLokiValues(
    clusterId,
    names.container,
    bounds,
    containerSelector,
    rangeKey,
    enabled && !!containerSelector,
  );
  const workloads = useMemo(
    () => workloadsOfPods(pods.data ?? []).map((w) => `${w.kind}/${w.name}`),
    [pods.data],
  );
  const podOptions = useMemo(() => {
    const all = pods.data ?? [];
    if (!builder.workload) return all;
    const re = new RegExp(
      `^(?:${workloadPodRegex(builder.workload.kind, builder.workload.name)})$`,
    );
    return all.filter((p) => re.test(p));
  }, [pods.data, builder.workload]);

  return (
    <div className="@container flex flex-wrap items-center gap-1.5 px-3 py-1.5">
      <Picker
        label={i18n.t('Namespace')}
        value={builder.namespace ?? ''}
        options={namespaces.data ?? []}
        loading={namespaces.loading}
        onChange={(v) =>
          onChange({ ...builder, namespace: v || null, workload: null, pod: null, container: null })
        }
      />
      <Picker
        label={i18n.t('Workload')}
        value={formatWorkload(builder.workload)}
        options={workloads}
        loading={pods.loading}
        onChange={(v) =>
          onChange({ ...builder, workload: parseWorkload(v), pod: null, container: null })
        }
      />
      <Picker
        label={i18n.t('Pod')}
        value={builder.pod ?? ''}
        options={podOptions}
        loading={pods.loading}
        onChange={(v) => onChange({ ...builder, pod: v || null, container: null })}
      />
      <Picker
        label={i18n.t('Container')}
        value={builder.container ?? ''}
        options={containers.data ?? []}
        loading={containers.loading}
        onChange={(v) => set('container', v || null)}
      />
      <div className="border-border/50 bg-surface focus-within:border-accent/60 flex h-6.5 min-w-40 flex-[2_1_12rem] items-center rounded-md border">
        <Select
          value={builder.lineOp}
          onChange={(v) => set('lineOp', v as LineFilterOp)}
          options={LINE_OPS.map((op) => ({
            value: op,
            label: op,
            description:
              op === '|='
                ? i18n.t('Line contains')
                : op === '!='
                  ? i18n.t('Line does not contain')
                  : op === '|~'
                    ? i18n.t('Line matches the regex')
                    : i18n.t('Line does not match the regex'),
          }))}
          ariaLabel={i18n.t('Line filter operator')}
          className="h-6 shrink-0 border-0 bg-transparent font-mono"
        />
        <input
          value={builder.line}
          onChange={(e) => set('line', e.target.value)}
          spellCheck={false}
          placeholder={i18n.t('Line filter')}
          aria-label={i18n.t('Line filter')}
          className="text-fg placeholder:text-fg-dim min-w-0 flex-1 bg-transparent pr-2 font-mono text-[11px] outline-none"
        />
      </div>
      <Select
        value={builder.parser}
        onChange={(v) => set('parser', v as ParserStage)}
        options={[
          { value: 'none', label: i18n.t('No parser') },
          { value: 'json', label: '| json' },
          { value: 'logfmt', label: '| logfmt' },
        ]}
        ariaLabel={i18n.t('Parser')}
        className="h-6.5 shrink-0 font-mono"
      />
    </div>
  );
}

function Picker({
  label,
  value,
  options,
  loading,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  loading: boolean;
  onChange: (value: string) => void;
}) {
  i18n.useLocale();
  const id = useId();
  return (
    <label
      className={cn(
        'border-border/50 bg-surface focus-within:border-accent/60 flex h-6.5 min-w-32 flex-[1_1_9rem] items-center rounded-md border',
      )}
    >
      <span className="text-fg-dim shrink-0 pr-1.5 pl-2 text-[10px] font-semibold tracking-[0.08em] uppercase">
        {label}
      </span>
      <input
        list={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        autoComplete="off"
        placeholder={loading ? i18n.t('Loading…') : i18n.t('Any')}
        aria-label={label}
        className="text-fg placeholder:text-fg-dim min-w-0 flex-1 bg-transparent font-mono text-[11px] outline-none"
      />
      {value && (
        <button
          type="button"
          aria-label={i18n.t('Clear {field}', { field: label })}
          onClick={() => onChange('')}
          className="text-fg-dim hover:text-fg mr-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-sm"
        >
          <X className="h-2.5 w-2.5" />
        </button>
      )}
      <datalist id={id}>
        {options.slice(0, 500).map((option) => (
          <option key={option} value={option} />
        ))}
      </datalist>
    </label>
  );
}
