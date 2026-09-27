import { call, callWithChannel, listenEvent } from './ipc/invoke';
import { terminalIpc } from './ipc/terminalIpc';
import type {
  ApiResourceInfo,
  AppInfo,
  ApplyMode,
  ClusterDef,
  ClusterId,
  ClusterInput,
  ClusterOverview,
  ClusterStatus,
  DeleteOptions,
  Gvk,
  HelmRelease,
  HelmReleaseDetail,
  KubeconfigSource,
  KubeObject,
  LogChunk,
  LogOptions,
  MetricsResult,
  NodeMetric,
  PatchType,
  PodMetric,
  PortForward,
  PortForwardRequest,
  ResourceList,
  Settings,
  WatchBatch,
  WorkspaceChanged,
  WorkspaceSnapshot,
} from '@/types';

export { isTauri } from './ipc/invoke';

/**
 * Typed Tauri IPC surface — the single frontend entry point for backend
 * calls. Argument names are camelCase here; Tauri maps them onto the
 * snake_case parameters of each `#[tauri::command]`.
 */
export const ipc = {
  // -- App ------------------------------------------------------------------
  appInfo: () => call<AppInfo>('app_info'),
  settingsGet: () => call<Settings>('settings_get'),
  settingsSet: (settings: Settings) => call<Settings>('settings_set', { settings }),
  workspaceLoad: () => call<WorkspaceSnapshot | null>('workspace_load'),
  /** Saves and broadcasts `workspace://changed` to every window. */
  workspaceSave: (snapshot: WorkspaceSnapshot) => call<void>('workspace_save', { snapshot }),
  revealPath: (path: string) => call<void>('reveal_path', { path }),

  // -- Windows --------------------------------------------------------------
  /** Open another app window labelled `label` (`win-…`), cascaded from this one. */
  windowOpen: (label: string) => call<void>('window_open', { label }),

  // -- Kubeconfig discovery -------------------------------------------------
  kubeconfigDiscover: () => call<KubeconfigSource[]>('kubeconfig_discover'),
  kubeconfigParseFile: (path: string) => call<KubeconfigSource>('kubeconfig_parse_file', { path }),
  kubeconfigParseText: (text: string) => call<KubeconfigSource>('kubeconfig_parse_text', { text }),

  // -- Cluster registry & connections --------------------------------------
  clusterList: () => call<ClusterDef[]>('cluster_list'),
  clusterAdd: (inputs: ClusterInput[]) => call<ClusterDef[]>('cluster_add', { inputs }),
  clusterUpdate: (cluster: ClusterDef) => call<ClusterDef>('cluster_update', { cluster }),
  clusterRemove: (id: ClusterId) => call<void>('cluster_remove', { id }),
  clusterConnect: (id: ClusterId) => call<ClusterStatus>('cluster_connect', { id }),
  clusterDisconnect: (id: ClusterId) => call<void>('cluster_disconnect', { id }),
  clusterStatuses: () => call<Record<ClusterId, ClusterStatus>>('cluster_statuses'),
  /** Writes a single-context kubeconfig for external tools; returns its path. */
  clusterExportKubeconfig: (id: ClusterId) => call<string>('cluster_export_kubeconfig', { id }),
  clusterOverview: (clusterId: ClusterId) =>
    call<ClusterOverview>('cluster_overview', { clusterId }),

  // -- Discovery ------------------------------------------------------------
  apiResources: (clusterId: ClusterId) => call<ApiResourceInfo[]>('api_resources', { clusterId }),
  namespaceNames: (clusterId: ClusterId) => call<string[]>('namespace_names', { clusterId }),

  // -- Generic resources ----------------------------------------------------
  resourceList: (
    clusterId: ClusterId,
    gvk: Gvk,
    namespace: string | null,
    labelSelector?: string | null,
    fieldSelector?: string | null,
  ) =>
    call<ResourceList>('resource_list', {
      clusterId,
      gvk,
      namespace,
      labelSelector: labelSelector ?? null,
      fieldSelector: fieldSelector ?? null,
    }),
  /** Starts a batched watch. Empty `namespaces` watches cluster-wide. Resolves to the watch id. */
  resourceWatch: (
    clusterId: ClusterId,
    gvk: Gvk,
    namespaces: string[],
    onBatch: (batch: WatchBatch) => void,
  ) =>
    callWithChannel<string, WatchBatch>(
      'resource_watch',
      { clusterId, gvk, namespaces },
      'onEvent',
      onBatch,
    ),
  resourceUnwatch: (watchId: string) => call<void>('resource_unwatch', { watchId }),
  resourceGet: (clusterId: ClusterId, gvk: Gvk, namespace: string | null, name: string) =>
    call<KubeObject>('resource_get', { clusterId, gvk, namespace, name }),
  resourceGetYaml: (clusterId: ClusterId, gvk: Gvk, namespace: string | null, name: string) =>
    call<string>('resource_get_yaml', { clusterId, gvk, namespace, name }),
  /** Multi-document YAML. `namespace` fills objects that omit metadata.namespace. */
  resourceApplyYaml: (
    clusterId: ClusterId,
    yaml: string,
    mode: ApplyMode,
    namespace: string | null,
  ) => call<KubeObject[]>('resource_apply_yaml', { clusterId, yaml, mode, namespace }),
  resourceDelete: (
    clusterId: ClusterId,
    gvk: Gvk,
    namespace: string | null,
    name: string,
    options: DeleteOptions = {},
  ) => call<void>('resource_delete', { clusterId, gvk, namespace, name, options }),
  resourcePatch: (
    clusterId: ClusterId,
    gvk: Gvk,
    namespace: string | null,
    name: string,
    patch: unknown,
    patchType: PatchType,
  ) => call<KubeObject>('resource_patch', { clusterId, gvk, namespace, name, patch, patchType }),
  resourceScale: (
    clusterId: ClusterId,
    gvk: Gvk,
    namespace: string,
    name: string,
    replicas: number,
  ) => call<void>('resource_scale', { clusterId, gvk, namespace, name, replicas }),
  /** `kubectl rollout restart` for Deployments, StatefulSets and DaemonSets. */
  resourceRestart: (clusterId: ClusterId, gvk: Gvk, namespace: string, name: string) =>
    call<void>('resource_restart', { clusterId, gvk, namespace, name }),
  /** Events whose involvedObject.uid matches. */
  resourceEvents: (clusterId: ClusterId, namespace: string | null, uid: string) =>
    call<KubeObject[]>('resource_events', { clusterId, namespace, uid }),
  cronjobTrigger: (clusterId: ClusterId, namespace: string, name: string) =>
    call<string>('cronjob_trigger', { clusterId, namespace, name }),
  nodeCordon: (clusterId: ClusterId, name: string, unschedulable: boolean) =>
    call<void>('node_cordon', { clusterId, name, unschedulable }),
  /** Cordon + evict every pod except DaemonSet and mirror pods. */
  nodeDrain: (clusterId: ClusterId, name: string, force: boolean) =>
    call<void>('node_drain', { clusterId, name, force }),

  // -- Logs -----------------------------------------------------------------
  podLogsStream: (
    clusterId: ClusterId,
    namespace: string,
    pod: string,
    container: string | null,
    options: LogOptions,
    onChunk: (chunk: LogChunk) => void,
  ) =>
    callWithChannel<string, LogChunk>(
      'pod_logs_stream',
      { clusterId, namespace, pod, container, options },
      'onChunk',
      onChunk,
    ),
  podLogsStop: (streamId: string) => call<void>('pod_logs_stop', { streamId }),

  // -- Metrics --------------------------------------------------------------
  metricsNodes: (clusterId: ClusterId) =>
    call<MetricsResult<NodeMetric>>('metrics_nodes', { clusterId }),
  metricsPods: (clusterId: ClusterId, namespace: string | null) =>
    call<MetricsResult<PodMetric>>('metrics_pods', { clusterId, namespace }),

  // -- Port forwarding ------------------------------------------------------
  portForwardStart: (request: PortForwardRequest) =>
    call<PortForward>('port_forward_start', { request }),
  portForwardStop: (id: string) => call<void>('port_forward_stop', { id }),
  portForwardList: () => call<PortForward[]>('port_forward_list'),

  // -- Helm -----------------------------------------------------------------
  helmReleases: (clusterId: ClusterId, namespace: string | null) =>
    call<HelmRelease[]>('helm_releases', { clusterId, namespace }),
  helmReleaseDetail: (clusterId: ClusterId, namespace: string, name: string) =>
    call<HelmReleaseDetail>('helm_release_detail', { clusterId, namespace, name }),
  helmRollback: (clusterId: ClusterId, namespace: string, name: string, revision: number) =>
    call<void>('helm_rollback', { clusterId, namespace, name, revision }),
  helmUninstall: (clusterId: ClusterId, namespace: string, name: string) =>
    call<void>('helm_uninstall', { clusterId, namespace, name }),
  helmUpgradeValues: (clusterId: ClusterId, namespace: string, name: string, values: string) =>
    call<void>('helm_upgrade_values', { clusterId, namespace, name, values }),

  // -- Terminal -------------------------------------------------------------
  ...terminalIpc,
};

export const events = {
  onClusterStatus: (handler: (status: ClusterStatus) => void) =>
    listenEvent<ClusterStatus>('cluster://status', handler),
  onClustersChanged: (handler: (clusters: ClusterDef[]) => void) =>
    listenEvent<ClusterDef[]>('cluster://list', handler),
  onPortForwards: (handler: (forwards: PortForward[]) => void) =>
    listenEvent<PortForward[]>('portforward://changed', handler),
  onTerminalExit: (handler: (payload: { id: string; code: number | null }) => void) =>
    listenEvent<{ id: string; code: number | null }>('terminal://exit', handler),
  onWorkspaceChanged: (handler: (payload: WorkspaceChanged) => void) =>
    listenEvent<WorkspaceChanged>('workspace://changed', handler),
};
