import * as i18n from '@/i18n';
import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/Input';
import { ipc } from '@/lib/ipc';
import { proxyUrlProblem } from '@/lib/proxy';
import { Field } from './Field';

/**
 * Per-cluster proxy override. In edit mode, the proxy the kubeconfig already
 * sets is shown so users know what an empty field means.
 */
export function ProxyField({
  value,
  onChange,
  clusterId,
}: {
  value: string;
  onChange: (value: string) => void;
  clusterId: string | null;
}) {
  i18n.useLocale();
  const [fromKubeconfig, setFromKubeconfig] = useState<string | null>(null);
  useEffect(() => {
    if (!clusterId) return;
    let cancelled = false;
    void ipc
      .clusterProxyInfo(clusterId)
      .then(
        (info) => !cancelled && setFromKubeconfig(info.source === 'kubeconfig' ? info.url : null),
      )
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [clusterId]);
  const problem = proxyUrlProblem(value);
  return (
    <Field label={i18n.t('Proxy')}>
      <Input
        mono
        value={value}
        spellCheck={false}
        placeholder="socks5://bastion.internal:1080"
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={!!problem}
      />
      {problem ? (
        <span className="text-status-error mt-1 block text-[11px]">{problem}</span>
      ) : (
        <span className="text-fg-dim mt-1 block text-[11px]">
          {fromKubeconfig && !value.trim()
            ? i18n.t('Empty uses the kubeconfig proxy {url}.', { url: fromKubeconfig })
            : i18n.t(
                'http, https, socks5 or socks5h. Used by Kubepit, kubectl, helm and terminals; overrides the kubeconfig proxy-url.',
              )}
        </span>
      )}
    </Field>
  );
}
