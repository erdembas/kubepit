import * as i18n from '@/i18n';
import { useState } from 'react';
import {
  Check,
  Circle,
  Download,
  ExternalLink,
  Loader2,
  RotateCcw,
  TriangleAlert,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import {
  GATEWAY_API_GUIDE_URL,
  GATEWAY_API_RELEASES_URL,
  GATEWAY_API_VERSION,
  GATEWAY_CRDS_INSTALL_ACCESS,
  defaultInstallVersion,
  installCommand,
  installRisk,
  validVersion,
} from '@/lib/kube/gateway';
import { cn } from '@/lib/cn';
import { useAppStore } from '@/store/useAppStore';
import type { GatewayApiChannel } from '@/types';
import { useActionGate, type GateableAction } from '../access/gates';
import { openExternal } from '../actions/openExternal';
import { useCluster } from '../data/hooks';
import { CodeBlock } from '../details/primitives';
import {
  installGatewayCrds,
  retriesDiscoverOnly,
  useCrdInstall,
  type CrdInstallStep,
} from './crdInstall';

/**
 * The Gateway API CRD install form: channel, version, gates (RBAC,
 * read-only), the production typed confirmation, progress and failure, and
 * the equivalent `kubectl` command. Shown as the view's missing state and
 * in the upgrade dialog.
 */

const ACTION: GateableAction = {
  id: 'gateway-api-crds-install',
  mutating: true,
  access: GATEWAY_CRDS_INSTALL_ACCESS,
};

const STEPS: readonly CrdInstallStep[] = ['download', 'apply', 'discover'];

function stepLabel(step: CrdInstallStep, version: string, channel: GatewayApiChannel): string {
  switch (step) {
    case 'download':
      return i18n.t('Download the {channel} manifest of {version}', { channel, version });
    case 'apply':
      return i18n.t('Apply the CRDs with server-side apply');
    default:
      return i18n.t('Load the Gateway API resources');
  }
}

export function GatewayCrdsInstall({
  clusterId,
  installed,
}: {
  clusterId: string;
  /** Installed bundle (`v1.6.3 standard`), when upgrading. */
  installed?: { version: string; channel: string } | null;
}) {
  i18n.useLocale();
  const { cluster, readOnly } = useCluster(clusterId);
  const install = useCrdInstall(clusterId);
  const [channel, setChannel] = useState<GatewayApiChannel>(
    (install?.channel ??
      (installed?.channel === 'experimental' ? 'experimental' : 'standard')) as GatewayApiChannel,
  );
  const [version, setVersion] = useState(
    install?.version ?? defaultInstallVersion(installed?.version),
  );
  const gate = useActionGate(clusterId, ACTION, readOnly);
  const running = install?.status === 'running';
  const valid = validVersion(version);
  const rediscover = retriesDiscoverOnly(install, channel, version);
  const risk = installRisk(installed, version, channel);

  const start = () => {
    if (running || gate.blocked || !valid) return;
    if (rediscover) {
      void installGatewayCrds(clusterId, channel, version);
      return;
    }
    // Every other run changes the cluster: production, and going back from
    // the installed bundle, ask for the typed version.
    if (cluster?.environment === 'production' || risk) {
      const warning =
        risk === 'downgrade'
          ? i18n.t('This replaces the installed {installed} CRDs with an older release.', {
              installed: installed?.version ?? '',
            })
          : risk === 'channel'
            ? i18n.t(
                'The standard channel drops the experimental resources and fields the installed CRDs serve.',
              )
            : null;
      useAppStore.getState().requestConfirm({
        title: i18n.t('Install Gateway API CRDs'),
        message: [
          i18n.t('Apply the Gateway API {version} {channel} CRDs to {cluster}?', {
            version: version.trim(),
            channel,
            cluster: cluster?.name ?? clusterId,
          }),
          i18n.t(
            'CustomResourceDefinitions are cluster-wide and affect every Gateway API implementation.',
          ),
          warning,
          cluster?.environment === 'production'
            ? `\n${i18n.t('This is a production cluster.')}`
            : null,
        ]
          .filter(Boolean)
          .join('\n'),
        confirmLabel: i18n.t('Install'),
        typeToConfirm: version.trim(),
        onConfirm: () => void installGatewayCrds(clusterId, channel, version),
      });
      return;
    }
    void installGatewayCrds(clusterId, channel, version);
  };

  const at = install ? STEPS.indexOf(install.step) : -1;
  const channels: Array<{ id: GatewayApiChannel; label: string; body: string }> = [
    {
      id: 'standard',
      label: i18n.t('Standard'),
      body: i18n.t(
        'GA and beta resources: GatewayClass, Gateway, HTTPRoute, GRPCRoute, ReferenceGrant, BackendTLSPolicy.',
      ),
    },
    {
      id: 'experimental',
      label: i18n.t('Experimental'),
      body: i18n.t(
        'Adds alpha resources and fields (TLSRoute, TCPRoute, UDPRoute, the x-k8s.io kinds). Some implementations require it.',
      ),
    },
  ];

  return (
    <div>
      <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label={i18n.t('Channel')}>
        {channels.map((c) => (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={channel === c.id}
            disabled={running}
            onClick={() => setChannel(c.id)}
            className={cn(
              'rounded-lg border px-3 py-2 text-left transition',
              channel === c.id
                ? 'border-accent/60 bg-accent/[0.06]'
                : 'border-border hover:bg-fg/4',
            )}
          >
            <span className="text-fg block text-[12px] font-semibold">{c.label}</span>
            <span className="text-fg-dim mt-0.5 block text-[11px] leading-relaxed">{c.body}</span>
          </button>
        ))}
      </div>
      <label className="mt-3 flex items-center gap-2 text-[12px]">
        <span className="text-fg-dim w-16 shrink-0">{i18n.t('Version')}</span>
        <input
          value={version}
          disabled={running}
          onChange={(e) => setVersion(e.target.value)}
          spellCheck={false}
          className={cn(
            'bg-surface border-border focus:border-accent/50 text-fg h-7 w-32 rounded-md border px-2 font-mono text-[12px] outline-none',
            !valid && 'border-status-error/60',
          )}
          aria-invalid={!valid}
        />
        {installed && (
          <span className={cn('text-[11px]', risk ? 'text-status-starting' : 'text-fg-dim')}>
            {i18n.t('Installed: {version} ({channel})', {
              version: installed.version,
              channel: installed.channel || '—',
            })}
          </span>
        )}
      </label>

      {risk && (
        <p className="text-status-starting mt-2 flex items-start gap-1.5 text-[11.5px]">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {risk === 'downgrade'
            ? i18n.t('This replaces the installed {installed} CRDs with an older release.', {
                installed: installed?.version ?? '',
              })
            : i18n.t(
                'The standard channel drops the experimental resources and fields the installed CRDs serve.',
              )}
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          disabled={running || gate.blocked || !valid}
          title={gate.message ?? undefined}
          onClick={start}
          leftIcon={
            running ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : install?.status === 'failed' ? (
              <RotateCcw className="h-3.5 w-3.5" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )
          }
        >
          {running
            ? i18n.t('Installing…')
            : install?.status === 'failed' &&
                install.channel === channel &&
                install.version === version.trim()
              ? i18n.t('Try again')
              : installed
                ? i18n.t('Install or upgrade CRDs')
                : i18n.t('Install Gateway API CRDs')}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void openExternal(GATEWAY_API_GUIDE_URL)}
          rightIcon={<ExternalLink className="h-3 w-3" />}
        >
          {i18n.t('Getting started')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void openExternal(GATEWAY_API_RELEASES_URL)}
          rightIcon={<ExternalLink className="h-3 w-3" />}
        >
          {i18n.t('Releases')}
        </Button>
      </div>
      <p className="text-fg-dim mt-2 text-[11px] leading-relaxed">
        {gate.message ??
          i18n.t(
            'Kubepit downloads the official release manifest, checks that it only contains Gateway API CRDs, and applies it with server-side apply (recorded in the audit log). If an implementation’s Helm chart manages these CRDs, upgrade them through that chart instead.',
          )}
      </p>

      {install && (
        <ol className="mt-4 flex flex-col gap-1.5" aria-label={i18n.t('Installation progress')}>
          {STEPS.map((step, i) => {
            const current = i === at;
            const failed = current && install.status === 'failed';
            const busy = current && install.status === 'running';
            return (
              <li
                key={step}
                className={cn(
                  'flex items-center gap-2 text-[12px]',
                  i > at ? 'text-fg-dim' : failed ? 'text-status-error' : 'text-fg-muted',
                  busy && 'text-fg',
                )}
              >
                {i < at ? (
                  <Check className="text-status-running h-3.5 w-3.5 shrink-0" />
                ) : failed ? (
                  <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
                ) : busy ? (
                  <Loader2 className="text-accent h-3.5 w-3.5 shrink-0 animate-spin" />
                ) : (
                  <Circle className="h-3.5 w-3.5 shrink-0 opacity-50" />
                )}
                <span className="min-w-0">{stepLabel(step, install.version, install.channel)}</span>
                {step === 'download' && install.manifest && (
                  <span className="text-fg-dim ml-auto shrink-0 text-[11px]">
                    {i18n.plural('{count} CRD', '{count} CRDs', install.manifest.crds.length)}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {install?.status === 'failed' && (
        <div className="border-status-error/30 bg-status-error/[0.06] mt-3 rounded-lg border px-3 py-2">
          <p className="text-status-error flex items-center gap-1.5 text-[12px] font-semibold">
            <TriangleAlert className="h-3.5 w-3.5" />
            {install.step === 'discover'
              ? i18n.t('Could not load the Gateway API resources')
              : i18n.t('Install failed')}
          </p>
          <pre className="text-status-error/90 mt-1 max-h-40 overflow-auto font-mono text-[11px] break-words whitespace-pre-wrap">
            {install.error}
          </pre>
        </div>
      )}

      <p className="text-fg-muted mt-6 text-[12px] leading-relaxed">
        {i18n.t('Or run the same command yourself:')}
      </p>
      <div className="mt-2">
        <CodeBlock text={installCommand(channel, valid ? version.trim() : GATEWAY_API_VERSION)} />
      </div>
    </div>
  );
}

/** The view's missing state: what the Gateway API is, and the install. */
export function GatewayApiMissing({ clusterId }: { clusterId: string }) {
  i18n.useLocale();
  return (
    <div className="overlay-scroll flex min-h-0 flex-1 overflow-auto p-6">
      <div className="m-auto w-full max-w-lg">
        <h3 className="text-fg text-[13.5px] font-semibold">
          {i18n.t('The Gateway API is not installed on this cluster')}
        </h3>
        <p className="text-fg-muted mt-2 text-[12px] leading-relaxed">
          {i18n.t(
            'The Gateway API is the successor of Ingress: GatewayClasses, Gateways and routes (HTTP, gRPC, TLS, TCP, UDP), shared across namespaces through ReferenceGrants. Its CRDs are installed once per cluster; an implementation such as Envoy Gateway, Istio, Cilium or NGINX Gateway Fabric then programs the data plane.',
          )}
        </p>
        <div className="mt-4">
          <GatewayCrdsInstall clusterId={clusterId} />
        </div>
      </div>
    </div>
  );
}
