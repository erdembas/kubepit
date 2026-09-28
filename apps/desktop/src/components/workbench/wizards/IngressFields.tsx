import * as i18n from '@/i18n';
import { useMemo } from 'react';
import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Radio } from '@/components/ui/Choice';
import { Field, Input } from '@/components/ui/Input';
import { IconButton } from '@/components/ui/IconButton';
import { SearchableSelect } from '@/components/ui/SearchableSelect';
import { Select } from '@/components/ui/Select';
import { Switch } from '@/components/ui/Switch';
import { asObject, asString, field } from '@/lib/kube/accessors';
import {
  certCoversHost,
  emptyPath,
  ingressController,
  isDefaultClass,
  NGINX_OPTIONS,
  PATH_TYPES,
  ruleHosts,
  servicePorts,
  type IngressErrors,
  type IngressInput,
  type IngressPathDraft,
  type IngressRuleDraft,
  type ServicePortOption,
  type TlsMode,
} from '@/lib/kube/wizards/ingress';
import { certificateExpiry, earliestNotAfter } from '@/lib/kube/x509';
import type { ClusterId, KubeObject } from '@/types';
import { GVK, useLiveList, useServedKind } from './data';
import { ExpiryLine, FieldError, FieldGrid, Notice, Section } from './fields';

/**
 * The Ingress form, used by the Ingress wizard and the Expose wizard's
 * optional Ingress step. With `fixedService` every path routes to that
 * (not yet created) Service and its ports.
 */
export function IngressFields({
  clusterId,
  input,
  errors,
  onChange,
  fixedService,
}: {
  clusterId: ClusterId;
  input: IngressInput;
  errors: IngressErrors;
  onChange: (patch: Partial<IngressInput>) => void;
  fixedService?: { name: string; ports: ServicePortOption[] };
}) {
  i18n.useLocale();
  const classes = useLiveList(clusterId, GVK.ingressClass, null);
  const services = useLiveList(clusterId, GVK.service, input.namespace, !fixedService);
  const secrets = useLiveList(clusterId, GVK.secret, input.namespace, input.tls.mode === 'secret');
  const clusterIssuerGvk = useServedKind(clusterId, 'cert-manager.io/v1', 'ClusterIssuer');
  const issuerGvk = useServedKind(clusterId, 'cert-manager.io/v1', 'Issuer');
  const certManager = !!clusterIssuerGvk || !!issuerGvk;
  const clusterIssuers = useLiveList(
    clusterId,
    clusterIssuerGvk,
    null,
    input.tls.mode === 'cert-manager',
  );
  const issuers = useLiveList(
    clusterId,
    issuerGvk,
    input.namespace,
    input.tls.mode === 'cert-manager',
  );

  const defaultClass = classes.items.find(isDefaultClass) ?? null;
  const selectedClass = input.className
    ? (classes.items.find((c) => c.metadata.name === input.className) ?? null)
    : defaultClass;
  const nginx = ingressController(selectedClass) === 'nginx';

  const serviceByName = useMemo(
    () => new Map(services.items.map((s) => [s.metadata.name, s])),
    [services.items],
  );
  const portsOf = (name: string): ServicePortOption[] => {
    if (fixedService) return fixedService.ports;
    const svc = serviceByName.get(name);
    return svc ? servicePorts(svc) : [];
  };

  const tlsSecrets = useMemo(
    () => secrets.items.filter((s) => field(s, 'type') === 'kubernetes.io/tls'),
    [secrets.items],
  );
  const hosts = ruleHosts(input);

  const setRule = (index: number, rule: Partial<IngressRuleDraft>) =>
    onChange({ rules: input.rules.map((r, i) => (i === index ? { ...r, ...rule } : r)) });
  const setPath = (ruleIndex: number, pathIndex: number, p: Partial<IngressPathDraft>) => {
    const rule = input.rules[ruleIndex]!;
    setRule(ruleIndex, {
      paths: rule.paths.map((path, i) => (i === pathIndex ? { ...path, ...p } : path)),
    });
  };
  const newPath = () => emptyPath(fixedService?.name ?? '', fixedService?.ports[0]?.value ?? '');

  return (
    <>
      <Field
        label={i18n.rich('{kind} class', { kind: <span lang="en">Ingress</span> })}
        hint={
          defaultClass
            ? i18n.t('Empty uses the cluster default ({name}).', {
                name: defaultClass.metadata.name,
              })
            : undefined
        }
      >
        <Select<string>
          value={input.className}
          onChange={(className) => onChange({ className })}
          options={[
            { value: '', label: i18n.t('Cluster default') },
            ...classes.items.map((c) => ({
              value: c.metadata.name,
              label: c.metadata.name,
              description: asString(asObject(c.spec).controller),
            })),
          ]}
          size="md"
          ariaLabel={i18n.t('{kind} class', { kind: 'Ingress' })}
          className="w-full font-mono"
        />
      </Field>

      <Section
        title={i18n.t('Rules')}
        action={
          <Button
            size="xs"
            variant="ghost"
            leftIcon={<Plus className="h-3 w-3" />}
            onClick={() => onChange({ rules: [...input.rules, { host: '', paths: [newPath()] }] })}
          >
            {i18n.t('Add host')}
          </Button>
        }
      >
        <div className="space-y-2.5">
          {input.rules.map((rule, ri) => (
            <div key={ri} className="border-border/70 space-y-2 rounded-lg border p-2.5">
              <div className="flex items-center gap-1.5">
                <Input
                  mono
                  lang="en"
                  value={rule.host}
                  placeholder={i18n.t('app.example.com (empty: every host)')}
                  aria-label={i18n.t('Host')}
                  onChange={(e) => setRule(ri, { host: e.target.value })}
                  className="min-w-0 flex-1"
                />
                {input.rules.length > 1 && (
                  <IconButton
                    label={i18n.t('Remove host')}
                    icon={<X />}
                    onClick={() => onChange({ rules: input.rules.filter((_, i) => i !== ri) })}
                  />
                )}
              </div>
              <FieldError>{errors.hosts[ri]}</FieldError>
              {rule.paths.map((path, pi) => {
                const pathErrors = errors.paths[ri]?.[pi];
                const ports = portsOf(path.service);
                return (
                  <div key={pi} className="bg-fg/3 space-y-1.5 rounded-md p-2">
                    <div className="grid gap-1.5 @md:grid-cols-[minmax(0,1fr)_minmax(0,11rem)_auto]">
                      <Input
                        mono
                        lang="en"
                        value={path.path}
                        placeholder="/"
                        aria-label={i18n.t('Path')}
                        onChange={(e) => setPath(ri, pi, { path: e.target.value })}
                      />
                      <Select<string>
                        value={path.pathType}
                        onChange={(pathType) =>
                          setPath(ri, pi, { pathType: pathType as IngressPathDraft['pathType'] })
                        }
                        options={PATH_TYPES.map((t) => ({ value: t, label: t }))}
                        size="md"
                        ariaLabel={i18n.t('Path type')}
                        className="w-full"
                      />
                      {rule.paths.length > 1 && (
                        <IconButton
                          label={i18n.t('Remove path')}
                          icon={<X />}
                          className="justify-self-end"
                          onClick={() =>
                            setRule(ri, { paths: rule.paths.filter((_, i) => i !== pi) })
                          }
                        />
                      )}
                    </div>
                    <div className="grid gap-1.5 @md:grid-cols-2">
                      {fixedService ? (
                        <Input mono value={fixedService.name} disabled aria-label="Service" />
                      ) : (
                        <SearchableSelect
                          value={path.service}
                          onChange={(service) => {
                            const first = portsOf(service)[0];
                            setPath(ri, pi, { service, port: first?.value ?? '' });
                          }}
                          options={services.items.map((s) => ({
                            value: s.metadata.name,
                            label: s.metadata.name,
                            description: servicePorts(s)
                              .map((p) => (p.name ? `${p.port}/${p.name}` : String(p.port)))
                              .join(', '),
                          }))}
                          label="Service"
                          placeholder={i18n.t('Pick a Service…')}
                          className="w-full font-mono"
                        />
                      )}
                      {ports.length ? (
                        <Select<string>
                          value={path.port}
                          onChange={(port) => setPath(ri, pi, { port })}
                          options={ports.flatMap((p) => [
                            {
                              value: p.value,
                              label: String(p.port),
                              description: p.name || undefined,
                            },
                            ...(p.name
                              ? [
                                  {
                                    value: p.name,
                                    label: p.name,
                                    description: i18n.t('by name → {port}', { port: p.port }),
                                  },
                                ]
                              : []),
                          ])}
                          size="md"
                          ariaLabel={i18n.t('Service port')}
                          className="w-full font-mono"
                        />
                      ) : (
                        <Input
                          mono
                          value={path.port}
                          placeholder={i18n.t('Port number or name')}
                          aria-label={i18n.t('Service port')}
                          onChange={(e) => setPath(ri, pi, { port: e.target.value })}
                        />
                      )}
                    </div>
                    <FieldError>
                      {pathErrors?.path ??
                        (path.service ? pathErrors?.service : null) ??
                        (path.port ? pathErrors?.port : null)}
                    </FieldError>
                  </div>
                );
              })}
              <Button
                size="xs"
                variant="ghost"
                leftIcon={<Plus className="h-3 w-3" />}
                onClick={() => setRule(ri, { paths: [...rule.paths, newPath()] })}
              >
                {i18n.t('Add path')}
              </Button>
            </div>
          ))}
        </div>
      </Section>

      <Section title="TLS">
        <div className="flex flex-wrap gap-x-4 gap-y-1" role="radiogroup">
          {(
            [
              ['none', i18n.t('No TLS')],
              ['secret', i18n.t('Existing TLS Secret')],
              ...(certManager ? [['cert-manager', i18n.t('Issue with cert-manager')]] : []),
            ] as Array<[TlsMode, string]>
          ).map(([mode, label]) => (
            <label key={mode} className="flex cursor-pointer items-center gap-2 text-[12px]">
              <Radio
                name="ingress-tls"
                className="mt-0"
                checked={input.tls.mode === mode}
                onChange={() =>
                  onChange({
                    tls: {
                      ...input.tls,
                      mode,
                      secretName:
                        mode === 'cert-manager' && !input.tls.secretName && input.name
                          ? `${input.name}-tls`
                          : input.tls.secretName,
                    },
                  })
                }
              />
              <span className="text-fg">{label}</span>
            </label>
          ))}
        </div>
        {input.tls.mode === 'secret' && (
          <TlsSecretPicker
            secrets={tlsSecrets}
            synced={secrets.synced}
            value={input.tls.secretName}
            hosts={hosts}
            onChange={(secretName) => onChange({ tls: { ...input.tls, secretName } })}
          />
        )}
        {input.tls.mode === 'cert-manager' && (
          <>
            <FieldGrid>
              <Field label={i18n.t('Issuer')}>
                <SearchableSelect
                  value={
                    input.tls.issuerName ? `${input.tls.issuerKind}/${input.tls.issuerName}` : ''
                  }
                  onChange={(value) => {
                    const [kind, ...name] = value.split('/');
                    onChange({
                      tls: {
                        ...input.tls,
                        issuerKind: kind === 'Issuer' ? 'Issuer' : 'ClusterIssuer',
                        issuerName: name.join('/'),
                      },
                    });
                  }}
                  options={[
                    ...clusterIssuers.items.map((i) => ({
                      value: `ClusterIssuer/${i.metadata.name}`,
                      label: i.metadata.name,
                      badge: 'ClusterIssuer',
                    })),
                    ...issuers.items.map((i) => ({
                      value: `Issuer/${i.metadata.name}`,
                      label: i.metadata.name,
                      badge: 'Issuer',
                    })),
                  ]}
                  label={i18n.t('Issuer')}
                  placeholder={i18n.t('Pick an issuer…')}
                  className="w-full font-mono"
                />
              </Field>
              <Field
                label={i18n.t('Certificate Secret')}
                hint={i18n.t('cert-manager writes the certificate here.')}
              >
                <Input
                  mono
                  value={input.tls.secretName}
                  placeholder={input.name ? `${input.name}-tls` : 'app-tls'}
                  onChange={(e) => onChange({ tls: { ...input.tls, secretName: e.target.value } })}
                />
              </Field>
            </FieldGrid>
          </>
        )}
        {input.tls.mode !== 'none' && hosts.length > 0 && (
          <p className="text-fg-dim text-[11px]">
            {i18n.t('Covers {hosts}.', { hosts: hosts.join(', ') })}
          </p>
        )}
        <FieldError>{input.tls.mode !== 'none' ? errors.tls : null}</FieldError>
      </Section>

      {nginx && (
        <Section
          title={i18n.rich('{controller} options', {
            controller: <span lang="en">ingress-nginx</span>,
          })}
          hint={i18n.t('Optional annotations understood by the ingress-nginx controller.')}
        >
          <div className="space-y-2">
            {NGINX_OPTIONS.map((option) => {
              const enabled = option.annotation in input.annotations;
              const value = input.annotations[option.annotation] ?? option.defaultValue;
              const toggle = (on: boolean) => {
                const next = { ...input.annotations };
                if (on) next[option.annotation] = option.defaultValue;
                else delete next[option.annotation];
                onChange({ annotations: next });
              };
              return (
                <div key={option.id} className="space-y-1">
                  <Switch
                    checked={enabled}
                    onChange={toggle}
                    label={option.label()}
                    description={option.hint()}
                  />
                  {enabled && option.editable && (
                    <Input
                      mono
                      value={value}
                      aria-label={option.label()}
                      onChange={(e) =>
                        onChange({
                          annotations: {
                            ...input.annotations,
                            [option.annotation]: e.target.value,
                          },
                        })
                      }
                    />
                  )}
                </div>
              );
            })}
          </div>
        </Section>
      )}
    </>
  );
}

function TlsSecretPicker({
  secrets,
  synced,
  value,
  hosts,
  onChange,
}: {
  secrets: KubeObject[];
  synced: boolean;
  value: string;
  hosts: string[];
  onChange: (name: string) => void;
}) {
  i18n.useLocale();
  const selected = secrets.find((s) => s.metadata.name === value) ?? null;
  const cert = selected ? earliestNotAfter(selected) : null;
  const expiry = cert ? certificateExpiry(cert) : null;
  const uncovered = cert ? hosts.filter((h) => !certCoversHost(cert, h)) : [];
  if (synced && secrets.length === 0)
    return (
      <Notice tone="warning">
        {i18n.t(
          'There are no kubernetes.io/tls Secrets in this namespace; create one with the TLS Secret wizard.',
        )}
      </Notice>
    );
  return (
    <div className="space-y-1.5">
      <SearchableSelect
        value={value}
        onChange={onChange}
        options={secrets.map((s) => {
          const c = earliestNotAfter(s);
          const e = c ? certificateExpiry(c) : null;
          return {
            value: s.metadata.name,
            label: s.metadata.name,
            description: c
              ? [
                  c.subject.cn,
                  e?.state === 'expired'
                    ? i18n.t('expired')
                    : i18n.plural(
                        '{count} day left',
                        '{count} days left',
                        Math.max(0, e?.daysLeft ?? 0),
                      ),
                ]
                  .filter(Boolean)
                  .join(' · ')
              : undefined,
          };
        })}
        label={i18n.t('TLS Secret')}
        placeholder={i18n.t('Pick a TLS Secret…')}
        className="w-full font-mono"
      />
      {cert && expiry && (
        <div className="border-border/70 rounded-lg border px-3 py-2">
          <p className="text-fg truncate font-mono text-[12px]" lang="en">
            {cert.sans.length ? cert.sans.join(', ') : cert.subject.cn}
          </p>
          <ExpiryLine notAfter={cert.notAfter} state={expiry.state} days={expiry.daysLeft} />
        </div>
      )}
      {uncovered.length > 0 && (
        <Notice tone="warning">
          {i18n.t('The certificate does not cover {hosts}.', { hosts: uncovered.join(', ') })}
        </Notice>
      )}
    </div>
  );
}
