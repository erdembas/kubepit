import { create } from 'zustand';
import type { RoleKind } from '@/lib/kube/wizards/rbac';
import type { SecretFlavor } from '@/lib/kube/wizards/secret';
import { dock } from '@/store/useDockStore';
import type { ClusterId, KubeObject } from '@/types';

/**
 * Resource creation wizards (one open at a time). A wizard only builds
 * YAML: `handOff` gives it to the create editor, which runs the dry-run
 * review and applies — wizards never write to a cluster themselves.
 */

/** Receives a wizard's manifest instead of a new create editor tab. */
export type WizardResultHandler = (yaml: string, namespace: string | null, review: boolean) => void;

interface Base {
  clusterId: ClusterId;
  /** Set when the wizard was opened from a create editor's template picker. */
  onYaml?: WizardResultHandler;
}

export type WizardRequest = Base &
  (
    | { kind: 'expose'; namespace: string; target: KubeObject | null }
    | { kind: 'ingress'; namespace: string; service: { name: string; port: string } | null }
    | { kind: 'secret'; namespace: string; flavor: SecretFlavor }
    | { kind: 'configmap'; namespace: string }
    | { kind: 'namespace' }
    | {
        kind: 'serviceaccount';
        namespace: string;
        mode: 'create' | 'bind';
        name?: string;
        role?: { kind: RoleKind; name: string } | null;
      }
    | { kind: 'cronjob'; namespace: string }
    | { kind: 'job-from-cronjob'; namespace: string }
  );

interface WizardState {
  request: WizardRequest | null;
  open: (request: WizardRequest) => void;
  close: () => void;
}

export const useWizardStore = create<WizardState>((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
}));

export function openWizard(request: WizardRequest) {
  useWizardStore.getState().open(request);
}

/**
 * Hand a finished manifest to the create editor (a new tab, or the editor
 * that opened the wizard). `review` starts the server-side dry run right
 * away; applying stays an explicit step there.
 */
export function handOff(
  request: WizardRequest,
  yaml: string,
  namespace: string | null,
  review: boolean,
) {
  useWizardStore.getState().close();
  if (request.onYaml) request.onYaml(yaml, namespace, review);
  else dock.create(request.clusterId, namespace, yaml, { review });
}
