import * as i18n from '@/i18n';
import { ShieldAlert } from 'lucide-react';
import { CopyableCodeBlock } from '@/components/ui/CopyableCodeBlock';
import { cn } from '@/lib/cn';

/** The check a user can run themselves (a command: never translated). */
export function proxyAccessCommand(namespace: string): string {
  return `kubectl auth can-i get services/proxy -n ${namespace}`;
}

const CODE = 'text-fg-muted font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap break-all';

/**
 * Why a service-proxy source (Prometheus, Loki, OpenCost / Kubecost) is not
 * used although it was found: the API server refused the proxy request, so
 * the account lacks `get` on `services/proxy` in the service's namespace.
 * Shows the API server's message verbatim and a copyable `kubectl auth
 * can-i` check. Used by the usage charts, the PromQL and Loki tabs and the
 * cost view instead of their "does not answer" state.
 */
export function ProxyForbiddenNotice({
  what,
  namespace,
  message,
  className,
}: {
  /** Product name of the source, e.g. "Prometheus" (not translated). */
  what: string;
  /** Namespace of the refused service. */
  namespace: string;
  /** The API server's message, verbatim. */
  message: string | null;
  className?: string;
}) {
  i18n.useLocale();
  const command = proxyAccessCommand(namespace);
  return (
    <div
      className={cn(
        'border-status-starting/30 bg-status-starting/5 rounded-app-sm w-full max-w-lg space-y-2 border px-3 py-2.5 text-left',
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <ShieldAlert className="text-status-starting mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
        <div className="min-w-0 space-y-0.5">
          <p className="text-fg text-[12px] font-medium">
            {i18n.t('Your account may not use the service proxy for {what}.', { what })}
          </p>
          <p className="text-fg-dim text-[11px]">
            {i18n.t(
              'Kubepit reaches it through the API server, which needs get on services/proxy in namespace {namespace}.',
              { namespace },
            )}
          </p>
        </div>
      </div>
      {message && (
        <div className="space-y-1">
          <p className="text-fg-dim text-[10px] font-medium tracking-wider uppercase">
            {i18n.t('API server message')}
          </p>
          <CopyableCodeBlock raw={message} preClassName="py-1.5 pr-8">
            <code className={CODE}>{message}</code>
          </CopyableCodeBlock>
        </div>
      )}
      <div className="space-y-1">
        <p className="text-fg-dim text-[10px] font-medium tracking-wider uppercase">
          {i18n.t('Check your access')}
        </p>
        <CopyableCodeBlock raw={command} preClassName="py-1.5 pr-8">
          <code className={CODE}>{command}</code>
        </CopyableCodeBlock>
      </div>
    </div>
  );
}
