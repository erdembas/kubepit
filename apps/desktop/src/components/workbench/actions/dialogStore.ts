import { create } from 'zustand';
import type { FileContextMenuEntry } from '@/components/ui/FileContextMenu';
import type { Gvk, KubeObject } from '@/types';

/** Workbench-local dialogs opened by resource actions (one at a time). */

export interface PortOption {
  port: number;
  name: string;
  protocol: string;
}

export type ActionDialog =
  | { kind: 'scale'; clusterId: string; gvk: Gvk; obj: KubeObject }
  | {
      kind: 'port-forward';
      clusterId: string;
      target: 'pod' | 'service';
      namespace: string;
      name: string;
      ports: PortOption[];
      port?: number;
    }
  | { kind: 'menu'; clusterId: string; x: number; y: number; items: FileContextMenuEntry[] }
  | { kind: 'set-image'; clusterId: string; gvk: Gvk; obj: KubeObject }
  // Logs & debug: ephemeral debug container for a pod.
  | { kind: 'debug'; clusterId: string; pod: KubeObject; target?: string | null }
  // GitOps: Argo CD sync options, Flux reconcile options.
  | { kind: 'argo-sync'; clusterId: string; gvk: Gvk; obj: KubeObject; revision?: string }
  | { kind: 'flux-reconcile'; clusterId: string; gvk: Gvk; obj: KubeObject };

interface DialogState {
  dialog: ActionDialog | null;
  open: (dialog: ActionDialog) => void;
  close: () => void;
}

export const useActionDialogs = create<DialogState>((set) => ({
  dialog: null,
  open: (dialog) => set({ dialog }),
  close: () => set({ dialog: null }),
}));
