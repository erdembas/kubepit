import * as i18n from '@/i18n';
import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { ipc } from '@/lib/ipc';
import type { LocalPortStatus } from '@/types';

/**
 * Checks a local port as the user types (debounced) and, when another
 * program holds it, offers a free one. `ownPort` is a port this forward
 * already listens on, which is not a conflict.
 */
export function useLocalPortCheck(port: number | null, ownPort?: number | null) {
  const [status, setStatus] = useState<LocalPortStatus | null>(null);
  useEffect(() => {
    setStatus(null);
    if (port == null || port === ownPort) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void ipc
        .portForwardLocalPort(port)
        .then((next) => !cancelled && setStatus(next))
        .catch(() => undefined);
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [port, ownPort]);
  return status && status.port === port ? status : null;
}

export function LocalPortHint({
  status,
  onUse,
}: {
  status: LocalPortStatus | null;
  onUse: (port: number) => void;
}) {
  i18n.useLocale();
  if (!status || status.available) return null;
  return (
    <p className="text-status-starting mt-1.5 flex flex-wrap items-center gap-1.5 text-[11.5px]">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
      {i18n.t('Port {port} is already in use by another program.', { port: status.port })}
      {status.suggestion != null && (
        <button
          type="button"
          onClick={() => onUse(status.suggestion!)}
          className="text-accent font-medium hover:underline"
        >
          {i18n.t('Use {port}', { port: status.suggestion })}
        </button>
      )}
    </p>
  );
}
