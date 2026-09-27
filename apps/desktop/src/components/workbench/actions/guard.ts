import * as i18n from '@/i18n/core';
import { useAppStore } from '@/store/useAppStore';
import type { ClusterDef } from '@/types';
import { errorText } from '../util';

/**
 * Confirmation policy for destructive actions:
 *  - production clusters always confirm and require typing the target name;
 *  - other clusters confirm when `settings.confirm_destructive` is on (default);
 *  - otherwise the action runs immediately.
 */
export function confirmDestructive(opts: {
  cluster: ClusterDef | undefined;
  title: string;
  message: string;
  confirmLabel: string;
  /** Text the user types on production clusters (usually the object name). */
  typeName: string;
  run: () => Promise<void> | void;
  /** GitOps ownership notice; it always asks (without blocking) so the user sees it. */
  warning?: string | null;
}) {
  const store = useAppStore.getState();
  const production = opts.cluster?.environment === 'production';
  const ask = production || !!opts.warning || (store.settings?.confirm_destructive ?? true);
  if (!ask) {
    void opts.run();
    return;
  }
  const message = opts.warning ? `${opts.message}\n\n${opts.warning}` : opts.message;
  store.requestConfirm({
    title: opts.title,
    message: production ? `${message}\n\n${i18n.t('This is a production cluster.')}` : message,
    confirmLabel: opts.confirmLabel,
    tone: 'danger',
    typeToConfirm: production ? opts.typeName : undefined,
    onConfirm: opts.run,
  });
}

/** Runs an IPC mutation with success / error toasts. */
export async function runMutation(task: () => Promise<unknown>, success?: string) {
  try {
    await task();
    if (success) useAppStore.getState().pushToast('success', success);
    return true;
  } catch (error) {
    useAppStore.getState().pushToast('error', errorText(error));
    return false;
  }
}
