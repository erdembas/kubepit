import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { useEffect, useState } from 'react';
import { Globe } from 'lucide-react';
import { SearchableSelect } from '@/components/ui/SearchableSelect';
import { cn } from '@/lib/cn';
import { parseCidr, workloadGroups, type NpCluster, type NpSelection } from '@/lib/kube/netpol';
import type { SearchableOption } from '@/lib/selectSearch';

/** Source / destination picker: pod, workload, namespace, Service or an external address. */

type PickerType = NpSelection['type'];

function typeLabel(t: PickerType): string {
  switch (t) {
    case 'pod':
      return 'Pod';
    case 'workload':
      return i18n.t('Workload');
    case 'namespace':
      return 'Namespace';
    case 'service':
      return 'Service';
    default:
      return i18n.t('External');
  }
}

function namespaceOf(sel: NpSelection | null): string | null {
  if (!sel) return null;
  if (sel.type === 'namespace') return sel.name;
  if (sel.type === 'external') return null;
  return sel.namespace;
}

export function EndpointPicker({
  role,
  value,
  onChange,
  cluster,
  defaultNamespace,
}: {
  role: 'source' | 'destination';
  value: NpSelection | null;
  onChange: (value: NpSelection | null) => void;
  cluster: NpCluster;
  defaultNamespace: string | null;
}) {
  i18n.useLocale();
  const types: PickerType[] =
    role === 'source'
      ? ['pod', 'workload', 'namespace', 'external']
      : ['pod', 'workload', 'service', 'namespace', 'external'];
  const [type, setType] = useState<PickerType>(value?.type ?? 'workload');
  const [namespace, setNamespace] = useState<string | null>(namespaceOf(value) ?? defaultNamespace);
  const [cidr, setCidr] = useState(value?.type === 'external' ? value.cidr : '');

  // Follow prefilled selections (matrix cell, details "Simulate" buttons).
  useEffect(() => {
    if (!value) return;
    setType(value.type);
    const ns = namespaceOf(value);
    if (ns) setNamespace(ns);
    if (value.type === 'external') setCidr(value.cidr);
  }, [value]);

  const namespaces = useMemo<SearchableOption[]>(
    () =>
      [...cluster.namespaces.keys()].sort().map((name) => ({
        value: name,
        label: name,
        badge: String(cluster.podsByNamespace.get(name)?.filter((p) => !p.template).length ?? 0),
      })),
    [cluster],
  );

  const objects = useMemo<SearchableOption[]>(() => {
    if (!namespace) return [];
    const pods = (cluster.podsByNamespace.get(namespace) ?? []).filter((p) => !p.template);
    if (type === 'pod')
      return pods.map((p) => ({
        value: p.name,
        label: p.name,
        description: `${p.workload.kind} ${p.workload.name}${p.hostNetwork ? ' · hostNetwork' : ''}`,
      }));
    if (type === 'workload')
      return workloadGroups(pods).map((g) => ({
        value: `${g.workload.kind}/${g.workload.name}`,
        label: g.workload.name,
        badge: g.workload.kind,
        description: i18n.plural('{count} pod', '{count} pods', g.pods.length),
        keywords: g.workload.kind,
      }));
    if (type === 'service')
      return cluster.services
        .filter((s) => s.namespace === namespace)
        .map((s) => ({
          value: s.name,
          label: s.name,
          badge: s.type,
          description: s.ports.map((p) => `${p.protocol} ${p.port}`).join(', '),
        }));
    return [];
  }, [cluster, namespace, type]);

  const objectValue =
    value && value.type === type && namespaceOf(value) === namespace
      ? value.type === 'workload'
        ? `${value.kind}/${value.name}`
        : value.type === 'pod' || value.type === 'service'
          ? value.name
          : ''
      : '';

  const pickType = (t: PickerType) => {
    setType(t);
    if (t === 'namespace' && namespace) onChange({ type: 'namespace', name: namespace });
    else if (t === 'external') {
      const valid = parseCidr(cidr);
      onChange(valid ? { type: 'external', cidr: cidr.trim() } : null);
    } else onChange(null);
  };

  const pickNamespace = (ns: string) => {
    setNamespace(ns);
    onChange(type === 'namespace' ? { type: 'namespace', name: ns } : null);
  };

  const pickObject = (v: string) => {
    if (!namespace) return;
    if (type === 'pod') onChange({ type: 'pod', namespace, name: v });
    else if (type === 'service') onChange({ type: 'service', namespace, name: v });
    else if (type === 'workload') {
      const slash = v.indexOf('/');
      onChange({
        type: 'workload',
        namespace,
        kind: v.slice(0, slash),
        name: v.slice(slash + 1),
      });
    }
  };

  const cidrInvalid = type === 'external' && cidr.trim() !== '' && !parseCidr(cidr);

  return (
    <div className="min-w-0 space-y-2">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className="text-fg-dim text-[10.5px] font-semibold tracking-[0.12em] uppercase">
          {role === 'source' ? i18n.t('Source') : i18n.t('Destination')}
        </span>
        <div
          role="radiogroup"
          aria-label={role === 'source' ? i18n.t('Source type') : i18n.t('Destination type')}
          className="bg-fg/5 flex h-7 min-w-0 flex-wrap items-center gap-0.5 rounded-lg p-0.5"
        >
          {types.map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={type === t}
              onClick={() => pickType(t)}
              className={cn(
                'h-6 rounded-md px-2 text-[11px] transition',
                type === t
                  ? 'bg-surface-raised text-fg font-medium shadow-xs'
                  : 'text-fg-dim hover:text-fg',
              )}
            >
              {typeLabel(t)}
            </button>
          ))}
        </div>
      </div>
      {type === 'external' ? (
        <div>
          <div
            className={cn(
              'bg-surface border-border focus-within:border-accent/50 flex h-8 items-center gap-2 rounded-lg border px-2.5 transition-colors',
              cidrInvalid && 'border-status-error/60',
            )}
          >
            <Globe className="text-fg-dim h-3.5 w-3.5 shrink-0" />
            <input
              value={cidr}
              onChange={(e) => {
                setCidr(e.target.value);
                const valid = parseCidr(e.target.value);
                onChange(valid ? { type: 'external', cidr: e.target.value.trim() } : null);
              }}
              placeholder={i18n.t('Address or CIDR, e.g. 203.0.113.0/24')}
              aria-label={i18n.t('External address or CIDR')}
              spellCheck={false}
              className="text-fg placeholder:text-fg-dim min-w-0 flex-1 bg-transparent font-mono text-[12px] outline-none"
            />
          </div>
          {cidrInvalid && (
            <p className="text-status-error mt-1 text-[11px]">
              {i18n.t('Not a valid IPv4 / IPv6 address or CIDR.')}
            </p>
          )}
        </div>
      ) : (
        <div className="grid min-w-0 gap-2 @md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <SearchableSelect
            value={namespace ?? ''}
            onChange={pickNamespace}
            options={namespaces}
            label="Namespace"
            placeholder={i18n.t('Namespace…')}
            className="w-full"
            menuWidth={280}
          />
          {type !== 'namespace' && (
            <SearchableSelect
              value={objectValue}
              onChange={pickObject}
              options={objects}
              label={typeLabel(type)}
              placeholder={
                !namespace
                  ? i18n.t('Pick a namespace first')
                  : objects.length
                    ? i18n.t('Pick…')
                    : i18n.t('Nothing here')
              }
              disabled={!namespace || !objects.length}
              className="w-full"
              menuWidth={360}
            />
          )}
        </div>
      )}
    </div>
  );
}
