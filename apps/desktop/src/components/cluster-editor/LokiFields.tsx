import * as i18n from '@/i18n';
import { CalendarSearch } from 'lucide-react';
import { useLokiStatus } from '@/components/workbench/dock/loki/useLoki';
import { Input } from '@/components/ui/Input';
import { lokiServiceLabel } from '@/lib/logs/loki';
import type { ClusterId, LokiConfig, PromScheme } from '@/types';
import { Field } from './Field';
import { Chip } from './Chip';

/** Form state of `ClusterDef.loki` (the port stays text while typing). */
export interface LokiDraft {
  mode: LokiConfig['mode'];
  namespace: string;
  service: string;
  port: string;
  scheme: PromScheme;
  path_prefix: string;
  tenant: string;
}

export function lokiDraft(config: LokiConfig | undefined): LokiDraft {
  if (config?.mode === 'service')
    return {
      mode: 'service',
      namespace: config.namespace,
      service: config.service,
      port: String(config.port),
      scheme: config.scheme,
      path_prefix: config.path_prefix,
      tenant: config.tenant,
    };
  return {
    mode: config?.mode ?? 'auto',
    namespace: 'loki',
    service: '',
    port: '80',
    scheme: 'http',
    path_prefix: '',
    tenant: '',
  };
}

/** The setting to save, or a message explaining what is missing. */
export function lokiConfig(draft: LokiDraft): { config: LokiConfig } | { error: string } {
  if (draft.mode !== 'service') return { config: { mode: draft.mode } };
  const port = Number(draft.port.trim());
  if (!draft.namespace.trim()) return { error: i18n.t('Enter the namespace of the Loki service.') };
  if (!draft.service.trim()) return { error: i18n.t('Enter the name of the Loki service.') };
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
      tenant: draft.tenant.trim(),
    },
  };
}

/** "Historical logs" of the cluster editor: auto-detect Loki, a specific service, or off. */
export function LokiFields({
  clusterId,
  value,
  onChange,
}: {
  /** `null` while adding: no status lookup runs before the cluster exists. */
  clusterId: ClusterId | null;
  value: LokiDraft;
  onChange: (next: LokiDraft) => void;
}) {
  i18n.useLocale();
  const status = useLokiStatus(clusterId).data;
  const set = <K extends keyof LokiDraft>(key: K, v: LokiDraft[K]) =>
    onChange({ ...value, [key]: v });
  const detected =
    status?.state === 'available' && status.source === 'detected' && status.service
      ? status.service
      : null;

  return (
    <div className="space-y-3">
      <Field label={i18n.t('Loki')}>
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
              <CalendarSearch className="text-accent/80 h-3 w-3" aria-hidden />
              {i18n.t('Found {service}', { service: lokiServiceLabel(detected) })}
            </span>
          )}
        </div>
      </Field>
      <p className="text-fg-dim -mt-1.5 text-[11px]">
        {value.mode === 'off'
          ? i18n.t('Historical logs are not offered; live pod logs still work.')
          : value.mode === 'auto'
            ? i18n.t(
                'Looks for the Loki gateway, query frontend, read path or single binary in namespaces such as loki, logging, monitoring and observability.',
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
                placeholder="loki"
                onChange={(e) => set('namespace', e.target.value)}
              />
            </Field>
            <Field label={i18n.t('Service')}>
              <Input
                mono
                value={value.service}
                placeholder="loki-gateway"
                onChange={(e) => set('service', e.target.value)}
              />
            </Field>
            <Field label={i18n.t('Port')}>
              <Input
                mono
                inputMode="numeric"
                value={value.port}
                placeholder="80"
                onChange={(e) => set('port', e.target.value.replace(/[^0-9]/g, ''))}
              />
            </Field>
          </div>
          <div className="grid grid-cols-[auto_1fr_1fr] items-end gap-3">
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
            <Field label={i18n.t('Path prefix')}>
              <Input
                mono
                value={value.path_prefix}
                placeholder="/"
                onChange={(e) => set('path_prefix', e.target.value)}
              />
            </Field>
            <Field label={i18n.t('Tenant')} hint={i18n.t('X-Scope-OrgID of a multi-tenant Loki.')}>
              <Input
                mono
                value={value.tenant}
                placeholder={i18n.t('none')}
                onChange={(e) => set('tenant', e.target.value)}
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
                  {`${lokiServiceLabel(c)}:${c.port}`}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
