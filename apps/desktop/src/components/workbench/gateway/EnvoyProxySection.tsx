import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { useState } from 'react';
import { Lock, Microscope } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ipc } from '@/lib/ipc';
import { asNumber, asObject, asString, status } from '@/lib/kube/accessors';
import { BUILTIN, toGvk } from '@/lib/kube/catalog';
import { RefLink } from '@/lib/kube/columns/cells';
import type { ColumnContext } from '@/lib/kube/columns';
import {
  ENVOY_ADMIN_PORT,
  isEnvoyProxyRef,
  mergesGateways,
  parametersRef,
  proxySelector,
} from '@/lib/kube/gateway';
import { podStatus, podStatusTone } from '@/lib/kube/pods';
import type { KubeObject } from '@/types';
import { useActionGate } from '../access/gates';
import { usePolled } from '../data/polled';
import { MiniTable, Row, Rows, Section, ToneText } from '../details/primitives';
import { errorText } from '../util';
import { EnvoyInspector } from './EnvoyInspector';

/**
 * Envoy Gateway runs one proxy fleet per Gateway (or per class with
 * `mergeGateways`) and labels it with the owning Gateway, so the Gateway's
 * details link to its Deployment / DaemonSet, Service and pods, and every
 * pod can be inspected through the Envoy admin interface (read-only).
 */

interface ProxyResources {
  workloads: KubeObject[];
  services: KubeObject[];
  pods: KubeObject[];
  errors: string[];
}

const KINDS = {
  deployments: toGvk(BUILTIN.Deployment),
  daemonsets: toGvk(BUILTIN.DaemonSet),
  services: toGvk(BUILTIN.Service),
  pods: toGvk(BUILTIN.Pod),
};

async function fetchProxy(clusterId: string, selector: string): Promise<ProxyResources> {
  const errors: string[] = [];
  const list = (gvk: (typeof KINDS)[keyof typeof KINDS]) =>
    ipc
      .resourceList(clusterId, gvk, null, selector)
      .then((r) => r.items)
      .catch((e: unknown) => {
        errors.push(`${gvk.kind}: ${errorText(e)}`);
        return [] as KubeObject[];
      });
  const [deployments, daemonsets, services, pods] = await Promise.all([
    list(KINDS.deployments),
    list(KINDS.daemonsets),
    list(KINDS.services),
    list(KINDS.pods),
  ]);
  return { workloads: [...deployments, ...daemonsets], services, pods, errors };
}

function serviceAddress(svc: KubeObject): string {
  const ingress = asObject(asObject(status(svc).loadBalancer)).ingress;
  const first = Array.isArray(ingress) ? asObject(ingress[0]) : {};
  return asString(first.ip) || asString(first.hostname) || asString(asObject(svc.spec).clusterIP);
}

export function EnvoyProxySection({
  gateway,
  gatewayClass,
  envoyProxies,
  ctx,
  isActive,
  readOnly,
}: {
  gateway: KubeObject;
  gatewayClass: KubeObject | null;
  envoyProxies: readonly KubeObject[];
  ctx: ColumnContext;
  isActive: boolean;
  readOnly: boolean;
}) {
  i18n.useLocale();
  const [inspect, setInspect] = useState<KubeObject | null>(null);
  // The Gateway's own EnvoyProxy wins over the class's.
  const proxyRef = [parametersRef(gateway), gatewayClass ? parametersRef(gatewayClass) : null].find(
    isEnvoyProxyRef,
  );
  const envoyProxy = proxyRef
    ? (envoyProxies.find(
        (p) => p.metadata.name === proxyRef.name && p.metadata.namespace === proxyRef.namespace,
      ) ?? null)
    : null;
  const merged = mergesGateways(envoyProxy);
  const selector = proxySelector(gateway, merged);
  const proxy = usePolled(
    `${ctx.clusterId}|envoy-proxy|${selector}`,
    () => fetchProxy(ctx.clusterId, selector),
    15_000,
    isActive,
  );
  const data = proxy.data;
  const pods = useMemo(
    () => [...(data?.pods ?? [])].sort((a, b) => a.metadata.name.localeCompare(b.metadata.name)),
    [data?.pods],
  );
  const podNamespace = pods[0]?.metadata.namespace ?? null;
  const access = useMemo(
    () => ({
      id: 'envoy-admin',
      mutating: false,
      access: [
        {
          verb: 'create',
          group: '',
          resource: 'pods',
          subresource: 'portforward',
          namespace: podNamespace,
        },
      ],
    }),
    [podNamespace],
  );
  const gate = useActionGate(ctx.clusterId, podNamespace ? access : null, readOnly);

  return (
    <Section title={i18n.t('Envoy proxy')}>
      <Rows>
        {proxyRef && (
          <Row label="EnvoyProxy">
            <RefLink
              target={{
                apiVersion: `${proxyRef.group}/v1alpha1`,
                kind: 'EnvoyProxy',
                name: proxyRef.name,
                namespace: proxyRef.namespace,
              }}
              ctx={ctx}
            />
          </Row>
        )}
        {merged && (
          <Row label={i18n.t('Merged')}>
            {i18n.t('One proxy fleet serves every Gateway of the class')}
          </Row>
        )}
        <Row label={i18n.t('Workload')}>
          {data?.workloads.length ? (
            <span className="flex flex-col gap-0.5">
              {data.workloads.map((w) => {
                const s = status(w);
                const ready = asNumber(s.readyReplicas ?? s.numberReady);
                const want = asNumber(asObject(w.spec).replicas ?? s.desiredNumberScheduled);
                return (
                  <span key={w.metadata.uid} className="flex min-w-0 items-baseline gap-1.5">
                    <span className="text-fg-dim text-[11px]">{w.kind}</span>
                    <RefLink
                      target={{
                        apiVersion: w.apiVersion,
                        kind: w.kind,
                        name: w.metadata.name,
                        namespace: w.metadata.namespace ?? null,
                      }}
                      ctx={ctx}
                    />
                    <ToneText tone={ready >= want && want > 0 ? 'success' : 'warning'}>
                      {ready}/{want}
                    </ToneText>
                  </span>
                );
              })}
            </span>
          ) : data ? (
            <span className="text-fg-dim">{i18n.t('No proxy workload found')}</span>
          ) : null}
        </Row>
        <Row label={i18n.t('Service')}>
          {data?.services.length ? (
            <span className="flex flex-col gap-0.5">
              {data.services.map((svc) => (
                <span key={svc.metadata.uid} className="flex min-w-0 items-baseline gap-1.5">
                  <RefLink
                    target={{
                      apiVersion: 'v1',
                      kind: 'Service',
                      name: svc.metadata.name,
                      namespace: svc.metadata.namespace ?? null,
                    }}
                    ctx={ctx}
                  />
                  <span className="text-fg-dim text-[11px]">
                    {asString(asObject(svc.spec).type)}
                  </span>
                  <span className="text-fg-muted font-mono text-[11px]">{serviceAddress(svc)}</span>
                </span>
              ))}
            </span>
          ) : null}
        </Row>
      </Rows>
      {data?.errors.length ? (
        <p className="text-status-starting mt-2 text-[11px] break-words">
          {data.errors.join('\n')}
        </p>
      ) : null}
      {proxy.error && <p className="text-status-error mt-2 text-[11px]">{proxy.error}</p>}
      {pods.length > 0 && (
        <div className="mt-3">
          <MiniTable
            rows={pods}
            rowKey={(p) => p.metadata.uid}
            columns={[
              {
                label: i18n.t('Pod'),
                cell: (p) => (
                  <RefLink
                    target={{
                      apiVersion: 'v1',
                      kind: 'Pod',
                      name: p.metadata.name,
                      namespace: p.metadata.namespace ?? null,
                    }}
                    ctx={ctx}
                  />
                ),
              },
              {
                label: i18n.t('Status'),
                cell: (p) => <ToneText tone={podStatusTone(podStatus(p))}>{podStatus(p)}</ToneText>,
              },
              {
                label: i18n.t('Node'),
                className: 'font-mono',
                cell: (p) => asString(asObject(p.spec).nodeName) || '—',
              },
              {
                label: '',
                className: 'text-right',
                cell: (p) => (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={gate.blocked || podStatus(p) !== 'Running'}
                    title={
                      gate.message ??
                      i18n.t('Envoy admin: config dump, clusters and stats (read-only)')
                    }
                    leftIcon={
                      gate.reason === 'permission' ? (
                        <Lock className="h-3 w-3" />
                      ) : (
                        <Microscope className="h-3 w-3" />
                      )
                    }
                    onClick={() => setInspect(p)}
                  >
                    {i18n.t('Inspect')}
                  </Button>
                ),
              },
            ]}
          />
        </div>
      )}
      {data && !pods.length && !data.errors.length && (
        <p className="text-fg-dim mt-2 text-[11px]">
          {i18n.t('No pods carry the labels {selector}.', { selector })}
        </p>
      )}
      {inspect && (
        <EnvoyInspector
          clusterId={ctx.clusterId}
          namespace={inspect.metadata.namespace ?? ''}
          pod={inspect.metadata.name}
          port={ENVOY_ADMIN_PORT}
          onOpen={(ref) => {
            setInspect(null);
            ctx.navigate(ref);
          }}
          onClose={() => setInspect(null)}
        />
      )}
    </Section>
  );
}
