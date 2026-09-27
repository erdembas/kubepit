import * as i18n from '@/i18n';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useAppStore } from '@/store/useAppStore';

/**
 * Renders the single app-wide confirmation requested through
 * `useAppStore.requestConfirm`. Async handlers keep the dialog open until
 * they settle so errors surface as a toast instead of being swallowed.
 */
export function ConfirmHost() {
  i18n.useLocale();
  const request = useAppStore((s) => s.confirm);
  const close = useAppStore((s) => s.closeConfirm);
  const pushToast = useAppStore((s) => s.pushToast);
  const [busy, setBusy] = useState(false);
  if (!request) return null;
  return (
    <ConfirmDialog
      title={request.title}
      message={request.message}
      confirmLabel={busy ? i18n.t('Working…') : request.confirmLabel}
      tone={request.tone === 'default' ? 'info' : 'danger'}
      confirmWord={request.typeToConfirm}
      onCancel={() => {
        if (!busy) close();
      }}
      onConfirm={async () => {
        if (busy) return;
        setBusy(true);
        try {
          await request.onConfirm();
          close();
        } catch (error) {
          pushToast('error', error instanceof Error ? error.message : String(error));
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}
