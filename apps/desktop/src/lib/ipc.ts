import { call, callWithChannel, listenEvent } from './ipc/invoke';
import { terminalIpc } from './ipc/terminalIpc';
import type {
  AccessCheck,
  AccessDecision,
  AccessRules,
  Alert,
  AlertNotice,
  ApiResourceInfo,
  AppInfo,
  ApplyMode,
  ClientCertificate,
  ClusterDef,
  ClusterId,
  ClusterInput,
  ClusterOverview,
  ClusterProxyInfo,
  ClusterStatus,
  ContainerImage,
  DeleteOptions,
  DryRunResult,
  FleetSearchEvent,
  FleetSearchQuery,
  Gvk,
  HelmChartDetail,
  HelmChartSummary,
  HelmChartVersion,
  HelmHubChart,
  HelmInstallRequest,
  HelmInstallResult,
  HelmRelease,
  HelmReleaseDetail,
  HelmRepo,
  HelmRepoAddOptions,
  HelmRepoUpdateResult,
  HelmRevisionDetail,
  HelmSearchOptions,
  HelmUpgradeRequest,
  KubeconfigChanged,
  KubeconfigSource,
  KubeObject,
  LocalPortStatus,
  LogChunk,
  LogOptions,
  ManifestApplyResult,
  ManifestRecent,
  ManifestRender,
  ManifestSource,
  MetricsHistoryQuery,
  MetricsResult,
  MetricsSeries,
  NodeMetric,
  OpenApiDocument,
  OpenApiIndex,
  PatchType,
  PodDebugRequest,
  PodDirListing,
  PodFileContent,
  PodFsTransfer,
  PodMetric,
  PortForward,
  PortForwardRequest,
  PrometheusMetric,
  PrometheusMetricsResult,
  PrometheusRange,
  PrometheusStatus,
  PrometheusTarget,
  PromQueryResult,
  ResourceList,
  RolloutRevision,
  SavedPortForward,
  SavedPortForwardInput,
  Settings,
  UpdateInfo,
  UpdateProgress,
  UpdaterStatus,
  WatchBatch,
  WhoAmI,
  WorkloadLogBatch,
  WorkloadLogOptions,
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

  // -- Updates (inert until release signing is configured) -----------------
  updateStatus: () => call<UpdaterStatus>('update_status'),
  /** Null when this is the newest version; rejects when updates are not configured. */
  updateCheck: () => call<UpdateInfo | null>('update_check'),
  /** Downloads and installs the update found by the last check; relaunch afterwards. */
  updateInstall: (onEvent: (progress: UpdateProgress) => void) =>
    callWithChannel<void, UpdateProgress>('update_install', {}, 'onEvent', onEvent),

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
  /** Client certificate of the context's user (reads the kubeconfig only); `null` for other auth. */
  clusterClientCertificate: (id: ClusterId) =>
    call<ClientCertificate | null>('cluster_client_certificate', { id }),
  clusterOverview: (clusterId: ClusterId) =>
    call<ClusterOverview>('cluster_overview', { clusterId }),

  // -- Discovery ------------------------------------------------------------
  apiResources: (clusterId: ClusterId) => call<ApiResourceInfo[]>('api_resources', { clusterId }),
  namespaceNames: (clusterId: ClusterId) => call<string[]>('namespace_names', { clusterId }),

  // -- OpenAPI v3 (schema-aware YAML editing, API explorer; read-only) ------
  /** `/openapi/v3`, cached per connection for a minute; `refresh` re-reads it. */
  openapiV3Index: (clusterId: ClusterId, refresh = false) =>
    call<OpenApiIndex>('openapi_v3_index', { clusterId, refresh }),
  /** `components.schemas` of one group-version (`v1`, `apps/v1`), cached by content hash. */
  openapiV3Document: (clusterId: ClusterId, apiVersion: string) =>
    call<OpenApiDocument>('openapi_v3_document', { clusterId, apiVersion }),

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

  // -- Workload operations --------------------------------------------------
  /** Revisions of a Deployment / StatefulSet / DaemonSet, newest first. */
  rolloutHistory: (clusterId: ClusterId, gvk: Gvk, namespace: string, name: string) =>
    call<RolloutRevision[]>('rollout_history', { clusterId, gvk, namespace, name }),
  /** `kubectl rollout undo --to-revision`; `revision: 0` = the previous revision. */
  rolloutUndo: (
    clusterId: ClusterId,
    gvk: Gvk,
    namespace: string,
    name: string,
    revision: number,
  ) => call<void>('rollout_undo', { clusterId, gvk, namespace, name, revision }),
  /** `kubectl set image`; workloads also record a change-cause. Returns the patched object. */
  resourceSetImage: (
    clusterId: ClusterId,
    gvk: Gvk,
    namespace: string | null,
    name: string,
    images: ContainerImage[],
  ) => call<KubeObject>('resource_set_image', { clusterId, gvk, namespace, name, images }),
  /**
   * The same requests as `resourceApplyYaml`, with `dryRun=All`: one result
   * per document, failures included. Allowed on read-only clusters.
   */
  resourceDryRunYaml: (
    clusterId: ClusterId,
    yaml: string,
    mode: ApplyMode,
    namespace: string | null,
  ) => call<DryRunResult[]>('resource_dry_run_yaml', { clusterId, yaml, mode, namespace }),

  // -- Local manifests (render locally; diff / apply per cluster) -----------
  /** Reads a plain folder or runs `kubectl kustomize` / `helm template`; never touches a cluster. */
  manifestsRender: (source: ManifestSource) => call<ManifestRender>('manifests_render', { source }),
  /** Changes whenever a file the source depends on changes. */
  manifestsFingerprint: (source: ManifestSource) =>
    call<string>('manifests_fingerprint', { source }),
  manifestsRecentList: () => call<ManifestRecent[]>('manifests_recent_list'),
  manifestsRecentRemove: (paths: string[]) =>
    call<ManifestRecent[]>('manifests_recent_remove', { paths }),
  /** Server-side apply dry run, one result per document (one object each). Allowed on read-only clusters. */
  manifestsDryRun: (clusterId: ClusterId, documents: string[], namespace: string | null) =>
    call<DryRunResult[]>('manifests_dry_run', { clusterId, documents, namespace }),
  /** Server-side apply in dependency order, continuing past failures. Refused on read-only clusters. */
  manifestsApply: (clusterId: ClusterId, documents: string[], namespace: string | null) =>
    call<ManifestApplyResult[]>('manifests_apply', { clusterId, documents, namespace }),

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

  // -- Logs & debug -------------------------------------------------------
  /** Merged logs of every pod matching `selector`. Resolves to the stream id. */
  workloadLogsStream: (
    clusterId: ClusterId,
    namespace: string,
    selector: string,
    options: WorkloadLogOptions,
    onEvent: (batch: WorkloadLogBatch) => void,
  ) =>
    callWithChannel<string, WorkloadLogBatch>(
      'workload_logs_stream',
      { clusterId, namespace, selector, options },
      'onEvent',
      onEvent,
    ),
  workloadLogsStop: (streamId: string) => call<void>('workload_logs_stop', { streamId }),
  /** Writes text to a path picked in a save dialog (log export). */
  saveTextFile: (path: string, contents: string) =>
    call<void>('save_text_file', { path, contents }),
  /** Adds an ephemeral debug container; resolves to its name once it runs. */
  podDebug: (clusterId: ClusterId, namespace: string, pod: string, request: PodDebugRequest) =>
    call<string>('pod_debug', { clusterId, namespace, pod, request }),
  /** `path` '' lists the container's working directory. */
  podFsList: (
    clusterId: ClusterId,
    namespace: string,
    pod: string,
    container: string | null,
    path: string,
  ) => call<PodDirListing>('pod_fs_list', { clusterId, namespace, pod, container, path }),
  /** First `maxBytes` (default 512 KiB, max 1 MiB) of a file for previews. */
  podFsRead: (
    clusterId: ClusterId,
    namespace: string,
    pod: string,
    container: string | null,
    path: string,
    maxBytes: number | null = null,
  ) =>
    call<PodFileContent>('pod_fs_read', { clusterId, namespace, pod, container, path, maxBytes }),
  /** A file, or a directory as a `.tar` archive, streamed to `localPath`. */
  podFsDownload: (
    clusterId: ClusterId,
    namespace: string,
    pod: string,
    container: string | null,
    remotePath: string,
    localPath: string,
  ) =>
    call<PodFsTransfer>('pod_fs_download', {
      clusterId,
      namespace,
      pod,
      container,
      remotePath,
      localPath,
    }),
  /** Copies one local file into `remoteDir` (replacing a file of the same name). */
  podFsUpload: (
    clusterId: ClusterId,
    namespace: string,
    pod: string,
    container: string | null,
    localPath: string,
    remoteDir: string,
  ) =>
    call<PodFsTransfer>('pod_fs_upload', {
      clusterId,
      namespace,
      pod,
      container,
      localPath,
      remoteDir,
    }),

  // -- Metrics --------------------------------------------------------------
  metricsNodes: (clusterId: ClusterId) =>
    call<MetricsResult<NodeMetric>>('metrics_nodes', { clusterId }),
  metricsPods: (clusterId: ClusterId, namespace: string | null) =>
    call<MetricsResult<PodMetric>>('metrics_pods', { clusterId, namespace }),

  // -- Prometheus metrics (optional source; read-only) ----------------------
  /** Detection result cached per connection; `refresh` detects again. */
  prometheusStatus: (clusterId: ClusterId, refresh = false) =>
    call<PrometheusStatus>('prometheus_status', { clusterId, refresh }),
  /** Preset series of `target`; empty `metrics` = every metric that applies. */
  prometheusMetrics: (
    clusterId: ClusterId,
    target: PrometheusTarget,
    metrics: PrometheusMetric[],
    range: PrometheusRange,
  ) => call<PrometheusMetricsResult>('prometheus_metrics', { clusterId, target, metrics, range }),
  /** Ad-hoc PromQL range query (PromQL dock tab). */
  prometheusQueryRange: (clusterId: ClusterId, query: string, range: PrometheusRange) =>
    call<PromQueryResult>('prometheus_query_range', { clusterId, query, range }),

  // -- Port forwarding ------------------------------------------------------
  portForwardStart: (request: PortForwardRequest) =>
    call<PortForward>('port_forward_start', { request }),
  portForwardStop: (id: string) => call<void>('port_forward_stop', { id }),
  portForwardList: () => call<PortForward[]>('port_forward_list'),

  // -- Connectivity: saved port forwards, proxies, keychain storage ---------
  portForwardSavedList: () => call<SavedPortForward[]>('port_forward_saved_list'),
  /** Creates the definition of a target or updates the existing one; links a running forward. */
  portForwardSave: (input: SavedPortForwardInput) =>
    call<SavedPortForward>('port_forward_save', { input }),
  /** Label, local port and start-on-connect only; the target is fixed. */
  portForwardSavedUpdate: (saved: SavedPortForward) =>
    call<SavedPortForward>('port_forward_saved_update', { saved }),
  /** A running forward keeps running, unlinked. */
  portForwardUnsave: (id: string) => call<void>('port_forward_unsave', { id }),
  /** Connects the cluster if needed; resolves to the running forward. */
  portForwardSavedStart: (id: string) => call<PortForward>('port_forward_saved_start', { id }),
  /** Same target and local port; on failure the forward stays listed as `error`. */
  portForwardRestart: (id: string) => call<PortForward>('port_forward_restart', { id }),
  portForwardLocalPort: (port: number) =>
    call<LocalPortStatus>('port_forward_local_port', { port }),
  clusterProxyInfo: (id: ClusterId) => call<ClusterProxyInfo>('cluster_proxy_info', { id }),
  /** Moves every pasted kubeconfig into (true) or out of the OS credential store. */
  kubeconfigStorageSet: (keychain: boolean) =>
    call<Settings>('kubeconfig_storage_set', { keychain }),

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

  // -- Access (RBAC self-reviews; read-only, allowed on read-only clusters) --
  /** One SelfSubjectAccessReview per check, in order; failed checks carry `error`. */
  accessReview: (clusterId: ClusterId, checks: AccessCheck[]) =>
    call<AccessDecision[]>('access_review', { clusterId, checks }),
  /** SelfSubjectRulesReview for one namespace. */
  accessRules: (clusterId: ClusterId, namespace: string) =>
    call<AccessRules>('access_rules', { clusterId, namespace }),
  /** SelfSubjectReview; rejects with "not supported by this cluster" before 1.27. */
  accessWhoami: (clusterId: ClusterId) => call<WhoAmI>('access_whoami', { clusterId }),
  // -- Fleet: metrics history & fleet search -------------------------------
  /** Last 60 minutes sampled in the background while the cluster is connected. */
  metricsHistory: (clusterId: ClusterId, query: MetricsHistoryQuery) =>
    call<MetricsSeries>('metrics_history', { clusterId, query }),
  /** Cluster totals of every sampled cluster, downsampled to one point per minute. */
  metricsHistoryFleet: () => call<Record<ClusterId, MetricsSeries>>('metrics_history_fleet'),
  /** Searches every connected cluster; resolves to the search id, results stream on `onEvent`. */
  fleetSearch: (query: FleetSearchQuery, onEvent: (event: FleetSearchEvent) => void) =>
    callWithChannel<string, FleetSearchEvent>('fleet_search', { query }, 'onEvent', onEvent),
  fleetSearchCancel: (searchId: string) => call<void>('fleet_search_cancel', { searchId }),
  // -- Helm charts (repositories and catalog are local helm commands) -------
  helmRepoList: () => call<HelmRepo[]>('helm_repo_list'),
  helmRepoAdd: (name: string, url: string, options: HelmRepoAddOptions) =>
    call<void>('helm_repo_add', { name, url, options }),
  helmRepoRemove: (name: string) => call<void>('helm_repo_remove', { name }),
  /** Empty `names` updates every repository. */
  helmRepoUpdate: (names: string[]) => call<HelmRepoUpdateResult[]>('helm_repo_update', { names }),
  /** Empty `query` lists every chart of the configured repositories. */
  helmChartSearch: (query: string, options: HelmSearchOptions) =>
    call<HelmChartSummary[]>('helm_chart_search', { query, options }),
  /** Newest first, pre-releases included. */
  helmChartVersions: (chartRef: string) =>
    call<HelmChartVersion[]>('helm_chart_versions', { chartRef }),
  /** Queries artifacthub.io; only on user request. */
  helmHubSearch: (query: string) => call<HelmHubChart[]>('helm_hub_search', { query }),
  /** `version = null` shows the newest stable version. */
  helmChartShow: (chartRef: string, version: string | null) =>
    call<HelmChartDetail>('helm_chart_show', { chartRef, version }),
  helmInstall: (clusterId: ClusterId, request: HelmInstallRequest) =>
    call<HelmInstallResult>('helm_install', { clusterId, request }),
  helmUpgrade: (
    clusterId: ClusterId,
    namespace: string,
    name: string,
    request: HelmUpgradeRequest,
  ) => call<HelmInstallResult>('helm_upgrade', { clusterId, namespace, name, request }),
  helmReleaseRevision: (clusterId: ClusterId, namespace: string, name: string, revision: number) =>
    call<HelmRevisionDetail>('helm_release_revision', { clusterId, namespace, name, revision }),

  // -- Alerts (read-only observations; allowed on read-only clusters) -------
  /** Every alert of this session, newest activity first. */
  alertsList: () => call<Alert[]>('alerts_list'),
  /** `ids: null` marks everything read; broadcasts `alerts://changed`. */
  alertsMarkRead: (ids: string[] | null) => call<void>('alerts_mark_read', { ids }),
  /** `ids: null` clears everything; broadcasts `alerts://changed`. */
  alertsClear: (ids: string[] | null) => call<void>('alerts_clear', { ids }),

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
  onSavedPortForwards: (handler: (saved: SavedPortForward[]) => void) =>
    listenEvent<SavedPortForward[]>('portforward://saved', handler),
  onKubeconfigChanged: (handler: (change: KubeconfigChanged) => void) =>
    listenEvent<KubeconfigChanged>('kubeconfig://changed', handler),
  onTerminalExit: (handler: (payload: { id: string; code: number | null }) => void) =>
    listenEvent<{ id: string; code: number | null }>('terminal://exit', handler),
  onWorkspaceChanged: (handler: (payload: WorkspaceChanged) => void) =>
    listenEvent<WorkspaceChanged>('workspace://changed', handler),
  /** An alert was raised or a repeat merged into one (every window hears it). */
  onAlert: (handler: (notice: AlertNotice) => void) =>
    listenEvent<AlertNotice>('alerts://new', handler),
  /** Alerts were marked read or cleared: refetch `alertsList`. */
  onAlertsChanged: (handler: () => void) => listenEvent<null>('alerts://changed', () => handler()),
};
