import * as i18n from '@/i18n';
import { useState } from 'react';
import { ChevronDown, Plus, ShieldAlert, X } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import { cn } from '@/lib/cn';
import {
  accessFromDraft,
  credentialsAllowed,
  labelProblem,
  tlsApplies,
  type AccessCaKind,
  type AccessDraft,
} from '@/lib/prometheusAccess';
import type { PrometheusConfig } from '@/types';
import { Field } from './Field';
import { Chip } from './Chip';

function hasContent(draft: AccessDraft, config: PrometheusConfig): boolean {
  return (
    draft.tenant.trim() !== '' ||
    draft.labels.some((l) => l.name.trim() || l.value.trim()) ||
    (draft.auth !== 'none' && credentialsAllowed(config))
  );
}

/** Badges of the collapsed section: set at all, and TLS verification skipped. */
export function AccessSummary({ value, config }: { value: AccessDraft; config: PrometheusConfig }) {
  i18n.useLocale();
  if (!hasContent(value, config)) return null;
  return (
    <>
      <Badge tone="neutral" size="xs">
        {i18n.t('Configured')}
      </Badge>
      {tlsApplies(value, config) && value.skipVerify && (
        <Badge tone="warning" size="xs" icon={<ShieldAlert className="h-3 w-3" />}>
          {i18n.t('Insecure')}
        </Badge>
      )}
    </>
  );
}

const SECTION_LABEL =
  'text-fg-dim mb-1 block text-[10.5px] font-semibold tracking-[0.14em] uppercase';

/**
 * "Shared or secured Prometheus" of the cluster editor: the tenant, the
 * cluster-label selector of a Prometheus that holds several clusters, and
 * credentials from a Secret (reached through a port-forward, since the
 * service proxy does not forward them). Inline checks mirror the backend,
 * which validates again on save.
 */
export function PrometheusAccessFields({
  config,
  value,
  onChange,
}: {
  config: PrometheusConfig;
  value: AccessDraft;
  onChange: (next: AccessDraft) => void;
}) {
  i18n.useLocale();
  const [open, setOpen] = useState(() => hasContent(value, config));
  const set = <K extends keyof AccessDraft>(key: K, v: AccessDraft[K]) =>
    onChange({ ...value, [key]: v });
  const setLabel = (index: number, patch: Partial<AccessDraft['labels'][number]>) =>
    set(
      'labels',
      value.labels.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  const checked = accessFromDraft(value, config);
  const problem = 'error' in checked ? checked.error : null;
  const tls = tlsApplies(value, config);

  return (
    <div className="@container space-y-3">
      <button
        type="button"
        onClick={() => setOpen((x) => !x)}
        aria-expanded={open}
        className="text-fg-muted hover:text-fg flex items-center gap-1.5 text-[11.5px] font-medium"
      >
        <ChevronDown className={cn('h-3 w-3 transition-transform', !open && '-rotate-90')} />
        {i18n.t('Shared or secured Prometheus')}
        {!open && <AccessSummary value={value} config={config} />}
      </button>
      {open && (
        <div className="border-border/60 space-y-3 border-l pl-3">
          <Field
            label={i18n.t('Tenant')}
            hint={i18n.t('X-Scope-OrgID of a multi-tenant Prometheus, Thanos or Mimir.')}
          >
            <Input
              mono
              value={value.tenant}
              placeholder={i18n.t('none')}
              onChange={(e) => set('tenant', e.target.value)}
            />
          </Field>

          <div>
            <span className={SECTION_LABEL}>{i18n.t('Cluster labels')}</span>
            <div className="space-y-1.5">
              {value.labels.map((row, i) => {
                const rowProblem = labelProblem(row);
                return (
                  <div key={i} className="flex items-center gap-1.5">
                    <Input
                      mono
                      value={row.name}
                      placeholder="cluster"
                      aria-label={i18n.t('Label name')}
                      aria-invalid={rowProblem !== null}
                      className={cn(rowProblem && 'border-status-error/60')}
                      onChange={(e) => setLabel(i, { name: e.target.value })}
                    />
                    <span className="text-fg-dim font-mono text-[12px]">=</span>
                    <Input
                      mono
                      value={row.value}
                      placeholder="prod-eu"
                      aria-label={i18n.t('Label value')}
                      onChange={(e) => setLabel(i, { value: e.target.value })}
                    />
                    <IconButton
                      label={i18n.t('Remove label')}
                      icon={<X className="h-3 w-3" />}
                      tone="danger"
                      onClick={() =>
                        set(
                          'labels',
                          value.labels.filter((_, j) => j !== i),
                        )
                      }
                    />
                  </div>
                );
              })}
              <button
                type="button"
                onClick={() => set('labels', [...value.labels, { name: '', value: '' }])}
                className="text-fg-muted hover:text-fg hover:bg-fg/5 rounded-app-sm inline-flex h-6 items-center gap-1 px-1.5 text-[11px]"
              >
                <Plus className="h-3 w-3" />
                {i18n.t('Add label')}
              </button>
            </div>
            <span className="text-fg-dim mt-1 block text-[11px]">
              {i18n.t(
                'Added to every query Kubepit builds, so a Prometheus that holds several clusters answers for this one only.',
              )}
            </span>
          </div>

          {!credentialsAllowed(config) && (
            <p className="text-fg-dim text-[11px]">
              {i18n.t(
                'Credentials are only sent to a service chosen above, never to a detected one. Choose “Use a service” to add them.',
              )}
            </p>
          )}
          {credentialsAllowed(config) && (
            <div>
              <span className={SECTION_LABEL}>{i18n.t('Authentication')}</span>
              <div className="flex flex-wrap items-center gap-1">
                <Chip active={value.auth === 'none'} onClick={() => set('auth', 'none')}>
                  {i18n.t('None')}
                </Chip>
                <Chip active={value.auth === 'bearer'} onClick={() => set('auth', 'bearer')}>
                  {i18n.t('Bearer token')}
                </Chip>
                <Chip active={value.auth === 'basic'} onClick={() => set('auth', 'basic')}>
                  {i18n.t('Basic auth')}
                </Chip>
              </div>
            </div>
          )}
          {credentialsAllowed(config) && value.auth !== 'none' && (
            <>
              <p className="text-fg-dim -mt-1.5 text-[11px]">
                {i18n.t(
                  'Read from this Secret when needed and sent through a port-forward to a ready pod, since the service proxy does not forward credentials (needs get on secrets and create on pods/portforward). Only the reference is saved.',
                )}
              </p>
              <div className="grid gap-3 @md:grid-cols-2">
                <Field label={i18n.t('Secret namespace')}>
                  <Input
                    mono
                    value={value.secretNamespace}
                    placeholder="monitoring"
                    onChange={(e) => set('secretNamespace', e.target.value)}
                  />
                </Field>
                <Field label={i18n.t('Secret name')}>
                  <Input
                    mono
                    value={value.secretName}
                    placeholder="prometheus-auth"
                    onChange={(e) => set('secretName', e.target.value)}
                  />
                </Field>
                {value.auth === 'bearer' ? (
                  <Field label={i18n.t('Token key')}>
                    <Input
                      mono
                      value={value.tokenKey}
                      placeholder="token"
                      onChange={(e) => set('tokenKey', e.target.value)}
                    />
                  </Field>
                ) : (
                  <>
                    <Field label={i18n.t('Username key')}>
                      <Input
                        mono
                        value={value.usernameKey}
                        placeholder="username"
                        onChange={(e) => set('usernameKey', e.target.value)}
                      />
                    </Field>
                    <Field label={i18n.t('Password key')}>
                      <Input
                        mono
                        value={value.passwordKey}
                        placeholder="password"
                        onChange={(e) => set('passwordKey', e.target.value)}
                      />
                    </Field>
                  </>
                )}
              </div>
            </>
          )}

          {tls && (
            <div className="space-y-3">
              <div>
                <span className={SECTION_LABEL}>{i18n.t('Certificate authority')}</span>
                <div className="flex flex-wrap items-center gap-1">
                  {(['system', 'ConfigMap', 'Secret'] as AccessCaKind[]).map((kind) => (
                    <Chip key={kind} active={value.ca === kind} onClick={() => set('ca', kind)}>
                      {kind === 'system' ? i18n.t('System roots') : kind}
                    </Chip>
                  ))}
                </div>
                <span className="text-fg-dim mt-1 block text-[11px]">
                  {i18n.t('Used when the service speaks https, with the name {name}.', {
                    name:
                      config.mode === 'service'
                        ? `${config.service}.${config.namespace}.svc`
                        : '<service>.<namespace>.svc',
                  })}
                </span>
              </div>
              {value.ca !== 'system' && !value.skipVerify && (
                <div className="grid gap-3 @md:grid-cols-3">
                  <Field label={i18n.t('Namespace')}>
                    <Input
                      mono
                      value={value.caNamespace}
                      placeholder="monitoring"
                      onChange={(e) => set('caNamespace', e.target.value)}
                    />
                  </Field>
                  <Field label={i18n.t('Name')}>
                    <Input
                      mono
                      value={value.caName}
                      placeholder="prometheus-ca"
                      onChange={(e) => set('caName', e.target.value)}
                    />
                  </Field>
                  <Field label={i18n.t('Key')}>
                    <Input
                      mono
                      value={value.caKey}
                      placeholder="ca.crt"
                      onChange={(e) => set('caKey', e.target.value)}
                    />
                  </Field>
                </div>
              )}
              <Switch
                checked={value.skipVerify}
                onChange={(skip) => set('skipVerify', skip)}
                label={
                  <span className="inline-flex items-center gap-2">
                    {i18n.t('Skip TLS verification')}
                    {value.skipVerify && (
                      <Badge tone="warning" size="xs" icon={<ShieldAlert className="h-3 w-3" />}>
                        {i18n.t('Insecure')}
                      </Badge>
                    )}
                  </span>
                }
                description={i18n.t(
                  'Accepts any certificate, so anyone on the path could read the credentials.',
                )}
              />
            </div>
          )}

          {problem && <p className="text-status-error text-[11px]">{problem}</p>}
        </div>
      )}
    </div>
  );
}
