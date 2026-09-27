import * as i18n from '@/i18n';
import { KeyRound } from 'lucide-react';
import { ipc } from '@/lib/ipc';
import { certificateExpiry, type Expiry } from '@/lib/kube/x509';
import { cn } from '@/lib/cn';
import type { ClientCertificate } from '@/types';
import { usePolled } from '../data/polled';

/**
 * Expiry of the kubeconfig client certificate a cluster authenticates with
 * (read from the kubeconfig by the backend; the cluster is never contacted).
 * Only shown when it expires within 30 days or already expired.
 */

const REFRESH_MS = 30 * 60_000;

export function useClientCertificate(clusterId: string, enabled: boolean) {
  return usePolled<ClientCertificate | null>(
    `${clusterId}|client-certificate`,
    () => ipc.clusterClientCertificate(clusterId),
    REFRESH_MS,
    enabled,
  ).data;
}

function expiryOf(cert: ClientCertificate | null | undefined, now: number): Expiry | null {
  if (!cert) return null;
  const e = certificateExpiry({ notBefore: cert.not_before, notAfter: cert.not_after }, now);
  return e.state === 'expired' || e.state === 'expiring' ? e : null;
}

function message(e: Expiry): string {
  return e.state === 'expired'
    ? i18n.plural(
        'Client certificate expired {count} day ago',
        'Client certificate expired {count} days ago',
        Math.max(0, -e.daysLeft - 1),
      )
    : i18n.plural(
        'Client certificate expires in {count} day',
        'Client certificate expires in {count} days',
        e.daysLeft,
      );
}

function details(cert: ClientCertificate): string {
  return i18n.t('User {subject} · issued by {issuer} · {source}', {
    subject: cert.subject || '—',
    issuer: cert.issuer || '—',
    source: cert.source === 'inline' ? 'client-certificate-data' : cert.source,
  });
}

/** Compact pill for the dashboard cluster card. */
export function ClientCertBadge({ clusterId, visible }: { clusterId: string; visible: boolean }) {
  i18n.useLocale();
  const cert = useClientCertificate(clusterId, visible);
  const expiry = expiryOf(cert, Date.now());
  if (!cert || !expiry) return null;
  return (
    <span
      title={details(cert)}
      className={cn(
        '-mt-1 inline-flex w-fit items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[10.5px] font-medium ring-1',
        expiry.state === 'expired'
          ? 'bg-tone-critical/12 text-tone-critical-fg ring-tone-critical/30'
          : 'bg-tone-warning/15 text-tone-warning-fg ring-tone-warning/35',
      )}
    >
      <KeyRound className="h-3 w-3" />
      {message(expiry)}
    </span>
  );
}

/** Notice row for the cluster overview page. */
export function ClientCertNotice({
  clusterId,
  isActive,
}: {
  clusterId: string;
  isActive: boolean;
}) {
  i18n.useLocale();
  const cert = useClientCertificate(clusterId, isActive);
  const expiry = expiryOf(cert, Date.now());
  if (!cert || !expiry) return null;
  const expired = expiry.state === 'expired';
  return (
    <div
      className={cn(
        'rounded-app flex items-start gap-2.5 border px-4 py-2.5 text-[12px]',
        expired
          ? 'border-status-error/30 bg-status-error/8'
          : 'border-status-starting/30 bg-status-starting/8',
      )}
    >
      <KeyRound
        className={cn(
          'mt-0.5 h-3.5 w-3.5 shrink-0',
          expired ? 'text-status-error' : 'text-status-starting',
        )}
      />
      <span className="min-w-0">
        <span className="text-fg block font-medium">{message(expiry)}</span>
        <span className="text-fg-muted block text-[11.5px]">{details(cert)}</span>
        <span className="text-fg-dim block text-[11.5px]">
          {i18n.t(
            'Renew it (kubeadm certs renew, or ask your cluster admin) and update the kubeconfig before it expires.',
          )}
        </span>
      </span>
    </div>
  );
}
