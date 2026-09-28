import * as i18n from '@/i18n';
import { useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Radio } from '@/components/ui/Choice';
import { Field, Input } from '@/components/ui/Input';
import { IconButton } from '@/components/ui/IconButton';
import { SearchableSelect } from '@/components/ui/SearchableSelect';
import { Select } from '@/components/ui/Select';
import { Switch } from '@/components/ui/Switch';
import { Tabs } from '@/components/ui/Tabs';
import { manifestYaml } from '@/lib/kube/wizards/encoding';
import {
  buildService,
  emptyPort,
  EXPOSABLE_KINDS,
  exposeBlocked,
  exposeDefaults,
  foreignPods,
  matchedPods,
  templatePorts,
  validateExpose,
  type ExposeInput,
  type PortProtocol,
  type ServiceKind,
  type ServicePortDraft,
} from '@/lib/kube/wizards/expose';
import {
  buildIngress,
  ingressBlocked,
  ingressDefaults,
  validateIngress,
  type IngressInput,
  type ServicePortOption,
} from '@/lib/kube/wizards/ingress';
import type { Gvk, KubeObject } from '@/types';
import { GVK, useLiveList } from './data';
import { FieldError, FieldGrid, KeyValueRows, NamespaceSelect, Notice, Section } from './fields';
import { IngressFields } from './IngressFields';
import { WizardShell } from './WizardShell';
import type { WizardRequest } from './wizardStore';

type ExposableKind = (typeof EXPOSABLE_KINDS)[number];

const KIND_GVK: Record<ExposableKind, Gvk> = {
  Deployment: GVK.deployment,
  StatefulSet: GVK.statefulSet,
  DaemonSet: GVK.daemonSet,
  ReplicaSet: GVK.replicaSet,
  ReplicationController: GVK.replicationController,
  Pod: GVK.pod,
};

const SERVICE_KINDS: readonly ServiceKind[] = ['ClusterIP', 'NodePort', 'LoadBalancer', 'Headless'];

function typeHint(type: ServiceKind): string {
  switch (type) {
    case 'ClusterIP':
      return i18n.t('A stable virtual IP reachable only inside the cluster.');
    case 'NodePort':
      return i18n.t('Also opens the port on every node (30000–32767 by default).');
    case 'LoadBalancer':
      return i18n.t('Asks the cloud provider for an external load balancer.');
    case 'Headless':
      return i18n.t(
        'No virtual IP: DNS returns the pod IPs (StatefulSets, client-side balancing).',
      );
  }
}

/** `kubectl expose` for a workload or pod, with an optional Ingress in front. */
export function ExposeWizard({
  request,
  onClose,
}: {
  request: Extract<WizardRequest, { kind: 'expose' }>;
  onClose: () => void;
}) {
  i18n.useLocale();
  const fixedTarget = request.target;
  const [target, setTarget] = useState<KubeObject | null>(fixedTarget);
  const [pickKind, setPickKind] = useState<ExposableKind>(
    (fixedTarget?.kind as ExposableKind | undefined) ?? 'Deployment',
  );
  const [input, setInput] = useState<ExposeInput>(() =>
    exposeDefaults(fixedTarget, request.namespace),
  );
  const [withIngress, setWithIngress] = useState(false);
  const [ingress, setIngress] = useState<IngressInput>(() => ingressDefaults(request.namespace));
  const patch = (p: Partial<ExposeInput>) => setInput((s) => ({ ...s, ...p }));

  const candidates = useLiveList(
    request.clusterId,
    fixedTarget ? null : KIND_GVK[pickKind],
    input.namespace,
  );
  const pods = useLiveList(request.clusterId, GVK.pod, input.namespace);
  const containerPorts = useMemo(() => (target ? templatePorts(target) : []), [target]);

  const errors = useMemo(() => validateExpose(input), [input]);
  const service = useMemo(() => buildService(input), [input]);

  // The Ingress routes to the Service being created, on one of its TCP ports.
  const ingressPorts = useMemo<ServicePortOption[]>(
    () =>
      input.ports
        .filter((p) => p.protocol === 'TCP' && Number(p.port) > 0)
        .map((p) => ({ value: p.port, port: Number(p.port), name: p.name, protocol: 'TCP' })),
    [input.ports],
  );
  const effectiveIngress = useMemo<IngressInput>(
    () => ({
      ...ingress,
      name: ingress.name || input.name,
      namespace: input.namespace,
      rules: ingress.rules.map((r) => ({
        ...r,
        paths: r.paths.map((p) => ({
          ...p,
          service: input.name,
          port: ingressPorts.some((o) => o.value === p.port || o.name === p.port)
            ? p.port
            : (ingressPorts[0]?.value ?? ''),
        })),
      })),
    }),
    [ingress, input.name, input.namespace, ingressPorts],
  );
  const ingressErrors = useMemo(() => validateIngress(effectiveIngress), [effectiveIngress]);

  const yaml = useMemo(
    () => manifestYaml(withIngress ? [service, buildIngress(effectiveIngress)] : [service]),
    [service, withIngress, effectiveIngress],
  );
  const matched = useMemo(
    () => matchedPods(input.selector, pods.items),
    [input.selector, pods.items],
  );
  const foreign = useMemo(
    () => foreignPods(input.selector, target, pods.items),
    [input.selector, target, pods.items],
  );
  const external = input.type === 'NodePort' || input.type === 'LoadBalancer';

  const choose = (obj: KubeObject | null) => {
    setTarget(obj);
    setInput((s) => ({ ...exposeDefaults(obj, s.namespace), type: s.type }));
  };
  const setPort = (index: number, p: Partial<ServicePortDraft>) =>
    patch({ ports: input.ports.map((port, i) => (i === index ? { ...port, ...p } : port)) });

  return (
    <WizardShell
      request={request}
      title={i18n.t('Expose as a Service')}
      subtitle={
        target
          ? `kubectl expose ${target.kind.toLowerCase()} ${target.metadata.name}`
          : 'kubectl expose'
      }
      yaml={yaml}
      namespace={input.namespace}
      blocked={exposeBlocked(errors) || (withIngress && ingressBlocked(ingressErrors))}
      errors={withIngress ? { errors, ingressErrors } : errors}
      creates={[
        { gvk: GVK.service, namespace: input.namespace },
        ...(withIngress ? [{ gvk: GVK.ingress, namespace: input.namespace }] : []),
      ]}
      onClose={onClose}
    >
      {!fixedTarget && (
        <Section
          title={i18n.t('Workload')}
          hint={i18n.t('Ports and selector are filled in from its pod template.')}
        >
          <div className="grid gap-3 @md:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
            <Select<string>
              value={pickKind}
              onChange={(kind) => {
                setPickKind(kind as ExposableKind);
                choose(null);
              }}
              options={EXPOSABLE_KINDS.map((k) => ({ value: k, label: k }))}
              size="md"
              ariaLabel={i18n.t('Kind')}
              className="w-full"
            />
            <SearchableSelect
              value={target?.metadata.name ?? ''}
              onChange={(name) =>
                choose(candidates.items.find((o) => o.metadata.name === name) ?? null)
              }
              options={candidates.items.map((o) => ({
                value: o.metadata.name,
                label: o.metadata.name,
              }))}
              label={pickKind}
              placeholder={i18n.t('Pick a {kind}…', { kind: pickKind })}
              className="w-full font-mono"
            />
          </div>
          {candidates.synced && candidates.items.length === 0 && (
            <p className="text-fg-dim text-[11px]">
              {i18n.t('No {kind} in {namespace}.', { kind: pickKind, namespace: input.namespace })}
            </p>
          )}
        </Section>
      )}

      <FieldGrid>
        <Field
          label={i18n.rich('{kind} name', { kind: <span lang="en">Service</span> })}
          error={input.name ? errors.name : null}
        >
          <Input
            mono
            autoFocus={!!fixedTarget}
            value={input.name}
            placeholder="web"
            onChange={(e) => patch({ name: e.target.value })}
          />
        </Field>
        <Field label={i18n.t('Namespace')}>
          <NamespaceSelect
            clusterId={request.clusterId}
            value={input.namespace}
            disabled={!!fixedTarget}
            onChange={(namespace) => {
              setTarget(null);
              setInput(exposeDefaults(null, namespace));
            }}
          />
        </Field>
      </FieldGrid>

      <Section title={i18n.t('Type')}>
        <div className="-mx-1 overflow-x-auto px-1">
          <Tabs
            tabs={SERVICE_KINDS.map((k) => ({
              key: k,
              label: k === 'Headless' ? i18n.t('Headless') : k,
            }))}
            value={input.type}
            onChange={(type) => patch({ type })}
          />
        </div>
        <p className="text-fg-dim text-[11px]">{typeHint(input.type)}</p>
      </Section>

      <Section
        title={i18n.t('Ports')}
        action={
          <Button
            size="xs"
            variant="ghost"
            leftIcon={<Plus className="h-3 w-3" />}
            onClick={() => patch({ ports: [...input.ports, emptyPort()] })}
          >
            {i18n.t('Add port')}
          </Button>
        }
      >
        <datalist id="kp-expose-target-ports">
          {containerPorts.map((p) => (
            <option key={p.targetPort} value={p.targetPort}>
              {p.port}
            </option>
          ))}
        </datalist>
        <div className="space-y-1.5">
          {input.ports.map((port, index) => {
            const e = errors.ports[index] ?? {};
            return (
              <div key={index} className="bg-fg/3 space-y-1 rounded-md p-2">
                <div
                  className={
                    external
                      ? 'grid grid-cols-2 gap-1.5 @lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,0.9fr)_auto]'
                      : 'grid grid-cols-2 gap-1.5 @lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,0.9fr)_auto]'
                  }
                >
                  <Input
                    mono
                    value={port.name}
                    placeholder={i18n.t('name')}
                    aria-label={i18n.t('Port name')}
                    onChange={(ev) => setPort(index, { name: ev.target.value })}
                  />
                  <Input
                    mono
                    value={port.port}
                    inputMode="numeric"
                    placeholder={i18n.t('port')}
                    aria-label={i18n.t('Service port')}
                    onChange={(ev) => setPort(index, { port: ev.target.value.trim() })}
                  />
                  <Input
                    mono
                    value={port.targetPort}
                    list="kp-expose-target-ports"
                    placeholder={i18n.t('target port')}
                    aria-label={i18n.t('Target port')}
                    title={i18n.t('Container port number or name')}
                    onChange={(ev) => setPort(index, { targetPort: ev.target.value.trim() })}
                  />
                  <Select<string>
                    value={port.protocol}
                    onChange={(protocol) => setPort(index, { protocol: protocol as PortProtocol })}
                    options={['TCP', 'UDP', 'SCTP'].map((p) => ({ value: p, label: p }))}
                    size="md"
                    ariaLabel={i18n.t('Protocol')}
                    className="w-full"
                  />
                  {external && (
                    <Input
                      mono
                      value={port.nodePort}
                      inputMode="numeric"
                      placeholder={i18n.t('node port')}
                      aria-label={i18n.t('Node port')}
                      title={i18n.t('Empty: allocated by the cluster')}
                      onChange={(ev) => setPort(index, { nodePort: ev.target.value.trim() })}
                    />
                  )}
                  <IconButton
                    label={i18n.t('Remove port')}
                    icon={<X />}
                    className="justify-self-end"
                    disabled={input.ports.length === 1 && input.type !== 'Headless'}
                    onClick={() => patch({ ports: input.ports.filter((_, i) => i !== index) })}
                  />
                </div>
                <FieldError>
                  {(port.port ? e.port : null) ?? e.name ?? e.targetPort ?? e.nodePort ?? null}
                </FieldError>
              </div>
            );
          })}
        </div>
        <FieldError>{errors.portsGeneral}</FieldError>
        {target && containerPorts.length === 0 && (
          <p className="text-fg-dim text-[11px]">
            {i18n.t(
              'The pod template declares no container ports; enter the port the app listens on.',
            )}
          </p>
        )}
      </Section>

      <Section
        title={i18n.t('Selector')}
        hint={i18n.t('The Service sends traffic to ready pods with all of these labels.')}
      >
        <KeyValueRows
          rows={input.selector}
          onChange={(selector) => patch({ selector })}
          keyPlaceholder={i18n.t('Label key')}
          valuePlaceholder={i18n.t('Value')}
          addLabel={i18n.t('Add label')}
        />
        <FieldError>{errors.selector}</FieldError>
        {errors.selectorWarning ? (
          <Notice tone="warning">{errors.selectorWarning}</Notice>
        ) : (
          pods.synced && (
            <p className="text-fg-dim text-[11px]">
              {i18n.plural(
                'Matches {count} pod in {namespace} right now.',
                'Matches {count} pods in {namespace} right now.',
                matched.length,
                { namespace: input.namespace },
              )}
            </p>
          )
        )}
        {foreign.length > 0 && (
          <Notice tone="warning">
            {i18n.plural(
              'The selector also matches {count} pod that is not part of {name}: {pods}',
              'The selector also matches {count} pods that are not part of {name}: {pods}',
              foreign.length,
              {
                name: target?.metadata.name ?? '',
                pods: foreign
                  .slice(0, 5)
                  .map((p) => p.metadata.name)
                  .join(', '),
              },
            )}
          </Notice>
        )}
      </Section>

      <Section title={i18n.t('Traffic')}>
        <div className="space-y-1">
          <p className="text-fg-dim text-[11px]">{i18n.t('Session affinity')}</p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5" role="radiogroup">
            {(['None', 'ClientIP'] as const).map((value) => (
              <label key={value} className="flex cursor-pointer items-center gap-2 text-[12px]">
                <Radio
                  name="session-affinity"
                  className="mt-0"
                  checked={input.sessionAffinity === value}
                  onChange={() => patch({ sessionAffinity: value })}
                />
                <span className="text-fg">
                  {value === 'None' ? i18n.t('None') : i18n.t('Same client, same pod (ClientIP)')}
                </span>
              </label>
            ))}
            {input.sessionAffinity === 'ClientIP' && (
              <label className="text-fg-muted flex items-center gap-2 text-[12px]">
                {i18n.t('Timeout (s)')}
                <Input
                  mono
                  value={input.affinityTimeout}
                  inputMode="numeric"
                  onChange={(ev) => patch({ affinityTimeout: ev.target.value.trim() })}
                  className="w-24"
                />
              </label>
            )}
          </div>
          <FieldError>{errors.affinityTimeout}</FieldError>
        </div>
        {external && (
          <Switch
            checked={input.externalTrafficPolicy === 'Local'}
            onChange={(local) => patch({ externalTrafficPolicy: local ? 'Local' : 'Cluster' })}
            label={i18n.t('Keep traffic on the receiving node (externalTrafficPolicy: Local)')}
            description={i18n.t(
              'Preserves client IPs; nodes without a ready pod stop receiving traffic.',
            )}
          />
        )}
      </Section>

      <Section title={i18n.t('Labels')}>
        <KeyValueRows
          rows={input.labels}
          onChange={(labels) => patch({ labels })}
          keyPlaceholder={i18n.t('Label key')}
          valuePlaceholder={i18n.t('Value')}
          addLabel={i18n.t('Add label')}
        />
        <FieldError>{errors.labels}</FieldError>
      </Section>

      <Section
        title={<span lang="en">Ingress</span>}
        action={<Switch bare checked={withIngress} onChange={setWithIngress} />}
        hint={i18n.t('Also route HTTP(S) traffic from a host name to this Service.')}
      >
        {withIngress &&
          (ingressPorts.length ? (
            <div className="border-border/70 space-y-4 rounded-lg border p-3">
              <Field
                label={i18n.rich('{kind} name', { kind: <span lang="en">Ingress</span> })}
                error={ingress.name ? ingressErrors.name : null}
              >
                <Input
                  mono
                  value={ingress.name}
                  placeholder={input.name || 'web'}
                  onChange={(ev) => setIngress((s) => ({ ...s, name: ev.target.value }))}
                />
              </Field>
              <IngressFields
                clusterId={request.clusterId}
                input={effectiveIngress}
                errors={ingressErrors}
                onChange={(p) => setIngress((s) => ({ ...s, ...p }))}
                fixedService={{ name: input.name || '…', ports: ingressPorts }}
              />
            </div>
          ) : (
            <Notice tone="warning">
              {i18n.t('Add a TCP port first; an Ingress routes HTTP.')}
            </Notice>
          ))}
      </Section>
    </WizardShell>
  );
}
