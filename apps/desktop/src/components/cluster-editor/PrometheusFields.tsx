import * as i18n from '@/i18n';
import { Flame } from 'lucide-react';
import { usePrometheusStatus } from '@/components/workbench/metrics/usePrometheus';
import { Input } from '@/components/ui/Input';
import { cn } from '@/lib/cn';
import { serviceLabel } from '@/lib/prometheus';
import type { ClusterId, PromScheme, PrometheusConfig } from '@/types';
import { Field } from './Field';

/** Form state of `ClusterDef.prometheus` (the port stays text while typing). */
export interface PrometheusDraft {
  mode: PrometheusConfig['mode'];
  namespace: string;
  service: string;
  port: string;
  scheme: PromScheme;
  path_prefix: string;
}

export function prometheusDraft(config: PrometheusConfig | undefined): PrometheusDraft {
  if (config?.mode === 'service')
    return {
      mode: 'service',
      namespace: config.namespace,
      service: config.service,
      port: String(config.port),
      scheme: config.scheme,
      path_prefix: config.path_prefix,
    };
  return {
    mode: config?.mode ?? 'auto',
    namespace: 'monitoring',
    service: '',
    port: '9090',
    scheme: 'http',
    path_prefix: '',
  };
}

/** The setting to save, or a message explaining what is missing. */
export function prometheusConfig(
  draft: PrometheusDraft,
): { config: PrometheusConfig } | { error: string } {
  if (draft.mode !== 'service') return { config: { mode: draft.mode } };
  const port = Number(draft.port.trim());
  if (!draft.namespace.trim())
    return { error: i18n.t('Enter the namespace of the Prometheus service.') };
  if (!draft.service.trim()) return { error: i18n.t('Enter the name of the Prometheus service.') };
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    return { error: i18n.t('Enter a port between 1 and 65535.') };
  return {
    config: {
      mode: 'service',
      namespace: draft.namespace.trim(),
      service: draft.service.trim(),
      port,
      scheme: draft.scheme,
      path_prefix: draft.path_prefix.trim(),
    },
  };
}

export function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'rounded-app-sm inline-flex h-7 items-center gap-1.5 border px-2 text-[11.5px] transition',
        active
          ? 'border-accent/40 bg-accent/12 text-fg font-medium'
          : 'border-border text-fg-muted hover:text-fg hover:border-border-strong',
      )}
    >
      {children}
    </button>
  );
}

/** "Metrics source" of the cluster editor: auto-detect, a specific service, or off. */
export function PrometheusFields({
  clusterId,
  value,
  onChange,
}: {
  /** `null` while adding: no status lookup runs before the cluster exists. */
  clusterId: ClusterId | null;
  value: PrometheusDraft;
  onChange: (next: PrometheusDraft) => void;
}) {
  i18n.useLocale();
  const status = usePrometheusStatus(clusterId).data;
  const set = <K extends keyof PrometheusDraft>(key: K, v: PrometheusDraft[K]) =>
    onChange({ ...value, [key]: v });
  const detected =
    status?.state === 'available' && status.source === 'detected' && status.service
      ? status.service
      : null;

  return (
    <div className="space-y-3">
      <Field label={i18n.t('Prometheus')}>
        <div className="flex flex-wrap items-center gap-1">
          <Chip active={value.mode === 'auto'} onClick={() => set('mode', 'auto')}>
            {i18n.t('Detect automatically')}
          </Chip>
          <Chip active={value.mode === 'service'} onClick={() => set('mode', 'service')}>
            {i18n.t('Use a service')}
          </Chip>
          <Chip active={value.mode === 'off'} onClick={() => set('mode', 'off')}>
            {i18n.t('Off')}
          </Chip>
          {value.mode === 'auto' && detected && (
            <span className="text-fg-dim ml-2 flex items-center gap-1 text-[11px]">
              <Flame className="text-accent/80 h-3 w-3" aria-hidden />
              {i18n.t('Found {service}', { service: serviceLabel(detected) })}
            </span>
          )}
        </div>
      </Field>
      <p className="text-fg-dim -mt-1.5 text-[11px]">
        {value.mode === 'off'
          ? i18n.t('Charts use the last hour from metrics-server only.')
          : value.mode === 'auto'
            ? i18n.t(
                'Looks for kube-prometheus-stack, the Prometheus chart, Thanos, VictoriaMetrics, Mimir or OpenShift monitoring and falls back to metrics-server.',
              )
            : i18n.t(
                'Queried through the API server’s service proxy with this cluster’s credentials (needs get on services/proxy).',
              )}
      </p>
      {value.mode === 'service' && (
        <>
          <div className="grid grid-cols-[1fr_1.4fr_0.6fr] gap-3">
            <Field label={i18n.t('Namespace')}>
              <Input
                mono
                value={value.namespace}
                placeholder="monitoring"
                onChange={(e) => set('namespace', e.target.value)}
              />
            </Field>
            <Field label={i18n.t('Service')}>
              <Input
                mono
                value={value.service}
                placeholder="prometheus-operated"
                onChange={(e) => set('service', e.target.value)}
              />
            </Field>
            <Field label={i18n.t('Port')}>
              <Input
                mono
                inputMode="numeric"
                value={value.port}
                placeholder="9090"
                onChange={(e) => set('port', e.target.value.replace(/[^0-9]/g, ''))}
              />
            </Field>
          </div>
          <div className="grid grid-cols-[auto_1fr] items-end gap-3">
            <Field label={i18n.t('Scheme')}>
              <div className="flex h-8 items-center gap-1">
                {(['http', 'https'] as const).map((scheme) => (
                  <Chip
                    key={scheme}
                    active={value.scheme === scheme}
                    onClick={() => set('scheme', scheme)}
                  >
                    {scheme}
                  </Chip>
                ))}
              </div>
            </Field>
            <Field
              label={i18n.t('Path prefix')}
              hint={i18n.t('For example /select/0/prometheus (vmselect) or /prometheus (Mimir).')}
            >
              <Input
                mono
                value={value.path_prefix}
                placeholder="/"
                onChange={(e) => set('path_prefix', e.target.value)}
              />
            </Field>
          </div>
          {status && status.candidates.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-fg-dim text-[11px]">{i18n.t('Found in the cluster:')}</span>
              {status.candidates.slice(0, 6).map((c) => (
                <button
                  key={`${c.namespace}/${c.service}:${c.port}`}
                  type="button"
                  onClick={() =>
                    onChange({
                      ...value,
                      namespace: c.namespace,
                      service: c.service,
                      port: String(c.port),
                      scheme: c.scheme,
                      path_prefix: c.path_prefix,
                    })
                  }
                  className="text-fg-muted hover:text-fg hover:bg-fg/5 rounded px-1.5 py-0.5 font-mono text-[10.5px]"
                >
                  {`${serviceLabel(c)}:${c.port}`}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
