import type {
  AppInfo,
  ClusterDef,
  ClusterInput,
  ClusterStatus,
  KubeconfigSource,
  PortForward,
  PortForwardRequest,
  Settings,
  TerminalOutput,
  WorkspaceSnapshot,
} from '@/types';
import { DEFAULT_ALERT_SETTINGS } from '@/lib/alerts/policy';
import { DEFAULT_HISTORY_SETTINGS } from '@/lib/history/audit';
import { windowLabel } from '@/lib/windowSeed';
import { mockEmit, mockEmitAllWindows, sleep } from './bus';
import { register, type MockArgs } from './registry';
import { demoOverview } from './resources';

const now = Date.now();
const DAY = 86_400_000;

function def(
  partial: Partial<ClusterDef> & Pick<ClusterDef, 'id' | 'name' | 'context'>,
): ClusterDef {
  return {
    kubeconfig_path: '~/.kube/config',
    managed: false,
    tags: [],
    environment: null,
    color: null,
    default_namespace: null,
    accessible_namespaces: [],
    read_only: false,
    notes: '',
    created_at: now - 40 * DAY,
    last_connected_at: now - DAY,
    prometheus: { mode: 'auto' },
    ...partial,
  };
}

let clusters: ClusterDef[] = [
  def({
    id: 'c-prod-eu',
    name: 'prod-eu-west-1',
    context: 'arn:aws:eks:eu-west-1:123456789012:cluster/prod-eu-west-1',
    environment: 'production',
    tags: ['aws', 'eu', 'payments'],
    color: '#ef4444',
    read_only: true,
    notes: 'Primary production cluster. Changes go through GitOps.',
  }),
  def({
    id: 'c-prod-us',
    name: 'prod-us-east-1',
    context: 'arn:aws:eks:us-east-1:123456789012:cluster/prod-us-east-1',
    environment: 'production',
    tags: ['aws', 'us'],
    color: '#f97316',
  }),
  def({
    id: 'c-staging',
    name: 'staging-gke',
    context: 'gke_acme-staging_europe-west4_staging',
    environment: 'staging',
    tags: ['gcp', 'eu'],
    color: '#eab308',
    default_namespace: 'checkout',
  }),
  def({
    id: 'c-dev',
    name: 'dev-shared',
    context: 'dev-shared-aks',
    environment: 'development',
    tags: ['azure', 'shared'],
    color: '#3b82f6',
  }),
  def({
    id: 'c-kind',
    name: 'kind-kubepit',
    context: 'kind-kubepit',
    environment: 'local',
    tags: ['local'],
    color: '#10b981',
  }),
  def({
    id: 'c-minikube',
    name: 'minikube',
    context: 'minikube',
    environment: 'local',
    tags: ['local'],
    color: '#a855f7',
    last_connected_at: null,
  }),
];

const PLATFORM: Record<string, [string, string, string]> = {
  'c-prod-eu': ['EKS', 'v1.31.4-eks-2d98532', 'https://A1B2C3.gr7.eu-west-1.eks.amazonaws.com'],
  'c-prod-us': ['EKS', 'v1.30.8-eks-2d98532', 'https://D4E5F6.yl4.us-east-1.eks.amazonaws.com'],
  'c-staging': ['GKE', 'v1.31.5-gke.1068000', 'https://34.91.10.22'],
  'c-dev': ['AKS', 'v1.30.6', 'https://dev-shared-dns-1f2e.hcp.westeurope.azmk8s.io:443'],
  'c-kind': ['kind', 'v1.32.2', 'https://127.0.0.1:52341'],
  'c-minikube': ['minikube', 'v1.32.0', 'https://192.168.49.2:8443'],
};

const statuses: Record<string, ClusterStatus> = {};
for (const c of clusters) {
  statuses[c.id] = {
    id: c.id,
    state: 'disconnected',
    error: null,
    version: null,
    platform: null,
    server: PLATFORM[c.id]?.[2] ?? null,
    connected_at: null,
  };
}

function setStatus(status: ClusterStatus) {
  statuses[status.id] = status;
  mockEmit('cluster://status', status);
}

async function connect(id: string): Promise<ClusterStatus> {
  const [platform, version, server] = PLATFORM[id] ?? [
    'Kubernetes',
    'v1.31.0',
    'https://127.0.0.1:6443',
  ];
  setStatus({ ...statuses[id]!, state: 'connecting', error: null });
  await sleep(500 + Math.random() * 700);
  if (id === 'c-minikube') {
    const status: ClusterStatus = {
      id,
      state: 'error',
      error: 'dial tcp 192.168.49.2:8443: connect: connection refused — is minikube running?',
      version: null,
      platform: null,
      server,
      connected_at: null,
    };
    setStatus(status);
    return status;
  }
  const status: ClusterStatus = {
    id,
    state: 'connected',
    error: null,
    version,
    platform,
    server,
    connected_at: Date.now(),
  };
  setStatus(status);
  clusters = clusters.map((c) => (c.id === id ? { ...c, last_connected_at: Date.now() } : c));
  return status;
}

let settings: Settings = {
  kubectl_path: null,
  helm_path: null,
  shell_path: null,
  kubeconfig_sync_paths: [],
  terminal_font_size: 13,
  log_tail_lines: 1000,
  confirm_destructive: true,
  node_shell_image: 'docker.io/library/alpine:3.20',
  debug_image: 'docker.io/library/busybox:1.36',
  auto_check_updates: true,
  alerts: DEFAULT_ALERT_SETTINGS,
  keychain_kubeconfigs: false,
  change_journal: true,
  change_journal_disabled: [],
  // staging-gke keeps its events and changes on disk (demo persisted history).
  history: { ...DEFAULT_HISTORY_SETTINGS, persist_clusters: ['c-staging'] },
  keyboard_mode: false,
};

const WORKSPACE_KEY = 'kubepit.demo.workspace';
const defaultWorkspace: WorkspaceSnapshot = {
  version: 1,
  sections: [
    { id: 'sec_prod', name: 'Production', color: 'orange' },
    { id: 'sec_staging', name: 'Staging', color: 'yellow' },
    { id: 'sec_dev', name: 'Development', color: 'blue' },
  ],
  clusterSection: {
    'c-prod-eu': 'sec_prod',
    'c-prod-us': 'sec_prod',
    'c-staging': 'sec_staging',
    'c-dev': 'sec_dev',
  },
  collapsedSections: {},
  sectionItemOrder: {},
};

let forwards: PortForward[] = [];

/** Live demo forwards, for the connectivity mock (saved forwards, restarts, failures). */
export const demoForwards = {
  list: () => forwards,
  replace: (next: PortForward[]) => {
    forwards = next;
    mockEmit('portforward://changed', forwards);
  },
};

const discovered: KubeconfigSource[] = [
  {
    path: '~/.kube/config',
    current_context: 'kind-kubepit',
    error: null,
    contexts: [
      {
        name: 'kind-kubepit',
        cluster: 'kind-kubepit',
        user: 'kind-kubepit',
        namespace: null,
        server: 'https://127.0.0.1:52341',
      },
      {
        name: 'minikube',
        cluster: 'minikube',
        user: 'minikube',
        namespace: 'default',
        server: 'https://192.168.49.2:8443',
      },
      {
        name: 'docker-desktop',
        cluster: 'docker-desktop',
        user: 'docker-desktop',
        namespace: null,
        server: 'https://kubernetes.docker.internal:6443',
      },
    ],
  },
  {
    path: '~/.kube/acme-eks.yaml',
    current_context: null,
    error: null,
    contexts: [
      {
        name: 'arn:aws:eks:eu-west-1:123456789012:cluster/prod-eu-west-1',
        cluster: 'prod-eu-west-1',
        user: 'aws-prod',
        namespace: null,
        server: 'https://A1B2C3.gr7.eu-west-1.eks.amazonaws.com',
      },
      {
        name: 'arn:aws:eks:eu-central-1:123456789012:cluster/analytics',
        cluster: 'analytics',
        user: 'aws-analytics',
        namespace: 'airflow',
        server: 'https://9Z8Y7X.sk1.eu-central-1.eks.amazonaws.com',
      },
    ],
  },
  {
    path: '~/.kube/old-cluster.conf',
    current_context: null,
    error: 'invalid kubeconfig: missing "clusters"',
    contexts: [],
  },
];

function emitClusters() {
  mockEmit('cluster://list', clusters);
}

register({
  app_info: (): AppInfo => ({
    version: '0.1.0',
    platform: /Mac/.test(navigator.userAgent) ? 'macos' : 'linux',
    data_dir: '~/.kubepit',
    kubectl: { path: '/usr/local/bin/kubectl', version: 'v1.32.2' },
    helm: { path: '/opt/homebrew/bin/helm', version: 'v3.17.1' },
  }),
  settings_get: () => settings,
  settings_set: ({ settings: next }: MockArgs) => (settings = next as Settings),
  workspace_load: () => {
    try {
      const raw = localStorage.getItem(WORKSPACE_KEY);
      return raw ? JSON.parse(raw) : defaultWorkspace;
    } catch {
      return defaultWorkspace;
    }
  },
  workspace_save: ({ snapshot }: MockArgs) => {
    try {
      localStorage.setItem(WORKSPACE_KEY, JSON.stringify(snapshot));
    } catch {
      /* ignore */
    }
    mockEmitAllWindows('workspace://changed', { source: windowLabel, snapshot });
  },
  // Another browser window on the same demo; it reads its seed like a Tauri window.
  window_open: ({ label }: MockArgs) => {
    const url = new URL(location.href);
    url.search = '';
    url.searchParams.set('window', String(label));
    if (!window.open(url, String(label), 'popup,width=1400,height=900')) {
      throw new Error('The browser blocked the new window.');
    }
  },
  reveal_path: () => undefined,
  kubeconfig_discover: async () => {
    await sleep(350);
    return discovered;
  },
  kubeconfig_parse_file: async ({ path }: MockArgs) =>
    discovered.find((d) => d.path === path) ?? {
      path,
      current_context: null,
      error: null,
      contexts: [
        {
          name: 'picked-context',
          cluster: 'picked',
          user: 'picked',
          namespace: null,
          server: 'https://10.0.0.1:6443',
        },
      ],
    },
  kubeconfig_parse_text: ({ text }: MockArgs): KubeconfigSource => {
    const names = [...String(text).matchAll(/^\s*-?\s*name:\s*(\S+)\s*$/gm)].map((m) => m[1]!);
    const hasContexts = /contexts:/.test(String(text));
    return {
      path: '',
      current_context: null,
      error: hasContexts ? null : 'This does not look like a kubeconfig (no "contexts" found).',
      contexts: hasContexts
        ? [...new Set(names)].slice(0, 3).map((name) => ({
            name,
            cluster: name,
            user: name,
            namespace: null,
            server: 'https://10.0.0.1:6443',
          }))
        : [],
    };
  },
  cluster_list: () => clusters,
  cluster_add: ({ inputs }: MockArgs) => {
    const added = (inputs as ClusterInput[]).map((input) =>
      def({
        id: `c-${crypto.randomUUID().slice(0, 8)}`,
        name: input.name,
        context: input.context,
        kubeconfig_path: input.kubeconfig_path ?? '~/.kubepit/kubeconfigs/pasted.yaml',
        managed: !input.kubeconfig_path,
        tags: input.tags,
        environment: input.environment,
        color: input.color,
        default_namespace: input.default_namespace,
        accessible_namespaces: input.accessible_namespaces,
        read_only: input.read_only,
        notes: input.notes,
        proxy_url: input.proxy_url ?? null,
        prometheus: input.prometheus ?? { mode: 'auto' },
        loki: input.loki,
        cost: input.cost,
        created_at: Date.now(),
        last_connected_at: null,
      }),
    );
    for (const c of added) {
      statuses[c.id] = {
        id: c.id,
        state: 'disconnected',
        error: null,
        version: null,
        platform: null,
        server: null,
        connected_at: null,
      };
      PLATFORM[c.id] = ['kind', 'v1.32.2', 'https://127.0.0.1:6443'];
    }
    clusters = [...clusters, ...added];
    emitClusters();
    return added;
  },
  cluster_update: ({ cluster }: MockArgs) => {
    clusters = clusters.map((c) => (c.id === cluster.id ? (cluster as ClusterDef) : c));
    emitClusters();
    return cluster;
  },
  cluster_remove: ({ id }: MockArgs) => {
    clusters = clusters.filter((c) => c.id !== id);
    delete statuses[id];
    emitClusters();
  },
  cluster_connect: ({ id }: MockArgs) => connect(id),
  cluster_disconnect: ({ id }: MockArgs) => {
    setStatus({ ...statuses[id]!, state: 'disconnected', error: null, connected_at: null });
    forwards = forwards.filter((f) => f.cluster_id !== id);
    mockEmit('portforward://changed', forwards);
  },
  cluster_statuses: () => statuses,
  cluster_export_kubeconfig: ({ id }: MockArgs) => `~/.kubepit/run/${id}.kubeconfig`,
  cluster_overview: async ({ clusterId }: MockArgs) => {
    await sleep(250);
    if (statuses[clusterId]?.state !== 'connected') throw new Error('cluster not connected');
    return demoOverview(clusterId);
  },
  port_forward_start: async ({ request }: MockArgs) => {
    const req = request as PortForwardRequest;
    const pf: PortForward = {
      ...req,
      id: crypto.randomUUID(),
      local_port: req.local_port || 30000 + Math.floor(Math.random() * 20000),
      state: 'active',
      error: null,
      created_at: Date.now(),
    };
    await sleep(300);
    forwards = [...forwards, pf];
    mockEmit('portforward://changed', forwards);
    return pf;
  },
  port_forward_stop: ({ id }: MockArgs) => {
    forwards = forwards.filter((f) => f.id !== id);
    mockEmit('portforward://changed', forwards);
  },
  port_forward_list: () => forwards,
});

// -- Demo terminal: a tiny line-echo shell so terminal panes render in previews.
const encoder = new TextEncoder();
const terminals = new Map<
  string,
  { emit: (o: TerminalOutput) => void; stream: string; line: string }
>();
const b64 = (text: string) => btoa(String.fromCharCode(...encoder.encode(text)));

register({
  terminal_create: ({ id, streamId, spec, onOutput }: MockArgs) => {
    const emit = onOutput as (o: TerminalOutput) => void;
    terminals.set(id, { emit, stream: streamId, line: '' });
    const target =
      spec.kind === 'pod-exec'
        ? `${spec.namespace}/${spec.pod}${spec.container ? ` (${spec.container})` : ''}`
        : spec.kind === 'node-shell'
          ? `node/${spec.node}`
          : spec.cluster_id
            ? `cluster ${spec.cluster_id}`
            : 'local shell';
    setTimeout(
      () =>
        emit({
          stream_id: streamId,
          data: b64(
            `\x1b[38;5;208mKubepit demo terminal\x1b[0m — ${target}\r\n\x1b[2mThis browser preview echoes input. The desktop app runs a real PTY.\x1b[0m\r\n\r\n\x1b[32m$\x1b[0m `,
          ),
        }),
      50,
    );
  },
  terminal_write: ({ id, data }: MockArgs) => {
    const t = terminals.get(id);
    if (!t) return;
    const text = new TextDecoder().decode(new Uint8Array(data as number[]));
    let out = '';
    for (const ch of text) {
      if (ch === '\r') {
        out += `\r\n${t.line ? `demo: ${t.line}: command not available in preview\r\n` : ''}\x1b[32m$\x1b[0m `;
        t.line = '';
      } else if (ch === '\x7f') {
        if (t.line) {
          t.line = t.line.slice(0, -1);
          out += '\b \b';
        }
      } else {
        t.line += ch;
        out += ch;
      }
    }
    t.emit({ stream_id: t.stream, data: b64(out) });
  },
  terminal_resize: () => undefined,
  terminal_acknowledge: () => undefined,
  terminal_destroy: ({ id }: MockArgs) => {
    terminals.delete(id);
  },
});
