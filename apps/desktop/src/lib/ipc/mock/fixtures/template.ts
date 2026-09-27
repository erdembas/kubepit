import type { PodTemplate } from './pods';
import { container, type ContainerDsl } from './containers';

/** Pod template helper shared by every fixture builder. */

export function tpl(
  app: string,
  containers: ContainerDsl[],
  opts: {
    init?: ContainerDsl[];
    sa?: string;
    volumes?: Array<Record<string, unknown>>;
    labels?: Record<string, string>;
    nodeSelector?: Record<string, string>;
    priorityClassName?: string;
    hostNetwork?: boolean;
    tolerations?: Array<Record<string, unknown>>;
    annotations?: Record<string, string>;
    imagePullSecrets?: string[];
  } = {},
): PodTemplate {
  return {
    metadata: {
      labels: { app, 'app.kubernetes.io/name': app, ...opts.labels },
      ...(opts.annotations ? { annotations: opts.annotations } : {}),
    },
    spec: {
      containers: containers.map(container),
      ...(opts.init ? { initContainers: opts.init.map(container) } : {}),
      serviceAccountName: opts.sa ?? 'default',
      serviceAccount: opts.sa ?? 'default',
      securityContext: opts.hostNetwork ? {} : { runAsNonRoot: true, fsGroup: 65534 },
      ...(opts.volumes ? { volumes: opts.volumes } : {}),
      ...(opts.nodeSelector ? { nodeSelector: opts.nodeSelector } : {}),
      ...(opts.priorityClassName ? { priorityClassName: opts.priorityClassName } : {}),
      ...(opts.hostNetwork ? { hostNetwork: true, hostPID: true } : {}),
      ...(opts.tolerations ? { tolerations: opts.tolerations } : {}),
      ...(opts.imagePullSecrets
        ? { imagePullSecrets: opts.imagePullSecrets.map((name) => ({ name })) }
        : {}),
    },
  };
}

export const cfg = (name: string) => ({ name, configMap: { name, defaultMode: 420 } });
