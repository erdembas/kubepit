import { call, callWithChannel, listenEvent } from './ipc/invoke';
import { terminalIpc } from './ipc/terminalIpc';
import type {
  AccessCheck,
  AccessDecision,
  AccessRules,
  AiEvent,
  AiLogDetail,
  AiLogFilter,
  AiLogPage,
  AiModelInfo,
  AiPreview,
  AiRequest,
  AiStatus,
  AiToolDecision,
  Alert,
  AlertNotice,
  ApiResourceInfo,
  AppInfo,
  ApplyMode,
  AuditDetail,
  AuditFilter,
  AuditPage,
  ClientCertificate,
  ClusterRecommendationSummary,
  ChangeDetail,
  ChangeFilter,
  ChangePage,
  ContainerResourceChange,
  CostQuery,
  CostReport,
  CostStatus,
  CostSummary,
  ClusterDef,
  ClusterId,
  ClusterInput,
  ClusterOverview,
  ClusterProxyInfo,
  ClusterStatus,
  ContainerImage,
  CustomAction,
  CustomActionImport,
  CustomActionResult,
  CustomActionsState,
  CustomActionTarget,
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
  HelmUpgradePreview,
  HelmUpgradeRequest,
  JsonSchema,
  HistoryChangePage,
  HistoryEventFilter,
  HistoryEventPage,
  HistoryKind,
  HistoryStatus,
  KubeconfigChanged,
  KubeconfigSource,
  KubeObject,
  LocalFile,
  LocalPortStatus,
  LogChunk,
  LogOptions,
  LokiQuery,
  LokiQueryResult,
  LokiStatus,
  ManifestApplyResult,
  ManifestRecent,
  ManifestRender,
  ManifestSource,
  ManifestsWatchEvent,
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
  PodSecurityDryRun,
  PortForward,
  PortForwardRequest,
  PrometheusMetric,
  PrometheusMetricsResult,
  PrometheusRange,
  PrometheusStatus,
  PrometheusTarget,
  PromQueryResult,
  RecommendationExportFormat,
  RecommendationLatest,
  RecommendationRun,
  RecommendationScanStatus,
  RecommendationTrendPoint,
  ResolvedCustomAction,
  PssLevel,
  ResourceList,
  RightsizingReport,
  RightsizingRequest,
  RolloutRevision,
  SavedPortForward,
  SavedPortForwardInput,
  Settings,
  SettingsChanged,
  UpdateInfo,
  UpdateProgress,
  UpdaterStatus,
  UpgradeReport,
  UpgradeScanOptions,
  WatchBatch,
  WhoAmI,
  WorkloadLogBatch,
  WorkloadLogOptions,
  WorkloadRecommendation,
  WorkloadRef,
  WorkloadUsageHistory,
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
  /** Saves and broadcasts `settings://changed` to every window. */
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
  /** Discovery is cached per connection; this rediscovers (after new CRDs were installed). */
  apiResourcesRefresh: (clusterId: ClusterId) =>
    call<ApiResourceInfo[]>('api_resources_refresh', { clusterId }),
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
  /** Every batch of `watchId` up to `seq` is applied (`WatchBatch.seq`). */
  resourceWatchAck: (watchId: string, seq: number) =>
    call<void>('resource_watch_ack', { watchId, seq }),
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
  /**
   * Watches the source's files (`notify`, debounced); `onEvent` fires when
   * their fingerprint changes, and right away when it already differs from
   * `since` (the rendered fingerprint). Resolves to the watch id; stop it
   * with `manifestsUnwatch`.
   */
  manifestsWatch: (
    source: ManifestSource,
    since: string | null,
    onEvent: (event: ManifestsWatchEvent) => void,
  ) =>
    callWithChannel<string, ManifestsWatchEvent>(
      'manifests_watch',
      { source, since },
      'onEvent',
      onEvent,
    ),
  manifestsUnwatch: (watchId: string) => call<void>('manifests_unwatch', { watchId }),
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

  // -- Loki historical logs (optional; read-only) ---------------------------
  /** Detection result cached per connection; `refresh` detects again. */
  lokiStatus: (clusterId: ClusterId, refresh = false) =>
    call<LokiStatus>('loki_status', { clusterId, refresh }),
  /** LogQL range query: log lines (streams) or a metric query's series. */
  lokiQueryRange: (clusterId: ClusterId, query: LokiQuery) =>
    call<LokiQueryResult>('loki_query_range', { clusterId, query }),
  /** Label names in [start, end] (ns strings), optionally of streams matching `query`. */
  lokiLabels: (clusterId: ClusterId, start: string, end: string, query: string | null = null) =>
    call<string[]>('loki_labels', { clusterId, start, end, query }),
  /** Values of `label` in [start, end] (ns strings), optionally of streams matching `query`. */
  lokiLabelValues: (
    clusterId: ClusterId,
    label: string,
    start: string,
    end: string,
    query: string | null = null,
  ) => call<string[]>('loki_label_values', { clusterId, label, start, end, query }),

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
  /**
   * Moves every pasted kubeconfig into (true) or out of the OS credential
   * store; broadcasts the saved settings (`settings://changed`).
   */
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
  // -- Security (Pod Security Standards; a dry run, allowed on read-only clusters) --
  /** What enforcing `level` at `version` on `namespace` would report about its existing pods. */
  podSecurityDryRun: (clusterId: ClusterId, namespace: string, level: PssLevel, version: string) =>
    call<PodSecurityDryRun>('pod_security_dry_run', { clusterId, namespace, level, version }),
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
  // -- Change timeline (recorded in memory while the cluster is connected) --
  /** Journaled changes, newest first; `status` says whether the cluster records. */
  changesList: (clusterId: ClusterId, filter: ChangeFilter) =>
    call<ChangePage>('changes_list', { clusterId, filter }),
  /** One change with its normalized before/after YAML (Secret values are never kept). */
  changesGet: (clusterId: ClusterId, id: number) =>
    call<ChangeDetail>('changes_get', { clusterId, id }),
  // -- Persistent history (history.db on this machine) ----------------------
  historyStatus: () => call<HistoryStatus>('history_status'),
  /** Own actions (every cluster), newest first. */
  historyAuditList: (filter: AuditFilter) => call<AuditPage>('history_audit_list', { filter }),
  /** One action with the redacted before/after of its targets. */
  historyAuditGet: (id: number) => call<AuditDetail>('history_audit_get', { id }),
  /** The filtered actions as JSON lines (bodies left out). */
  historyAuditExport: (filter: AuditFilter) => call<string>('history_audit_export', { filter }),
  /** Persisted Events of an opted-in cluster, newest occurrence first. */
  historyEventsList: (clusterId: ClusterId, filter: HistoryEventFilter) =>
    call<HistoryEventPage>('history_events_list', { clusterId, filter }),
  /** Persisted change-journal entries (ids of the database, not the live journal). */
  historyChangesList: (clusterId: ClusterId, filter: ChangeFilter) =>
    call<HistoryChangePage>('history_changes_list', { clusterId, filter }),
  historyChangesGet: (clusterId: ClusterId, id: number) =>
    call<ChangeDetail>('history_changes_get', { clusterId, id }),
  /** `clusterId: null` clears every cluster; compacts the database. */
  historyClear: (kind: HistoryKind, clusterId: ClusterId | null) =>
    call<HistoryStatus>('history_clear', { kind, clusterId }),
  // -- Cost insight and right-sizing (read-only except rightsizingApply) ----
  /** Cost source (OpenCost, Kubecost or estimate), price model, Prometheus availability. */
  costStatus: (clusterId: ClusterId, refresh = false) =>
    call<CostStatus>('cost_status', { clusterId, refresh }),
  /** Monthly totals, breakdown and daily trend; cached for a few minutes unless `refresh`. */
  costReport: (clusterId: ClusterId, query: CostQuery) =>
    call<CostReport>('cost_report', { clusterId, query }),
  /** Totals of the 7-day namespace report (dashboard). */
  costSummary: (clusterId: ClusterId) => call<CostSummary>('cost_summary', { clusterId }),
  /** Request recommendations per container from usage history. */
  rightsizingReport: (clusterId: ClusterId, request: RightsizingRequest) =>
    call<RightsizingReport>('rightsizing_report', { clusterId, request }),
  /**
   * Patch a workload's container resources. `dryRun` reviews (allowed on
   * read-only clusters); otherwise the backend refuses read-only clusters.
   */
  rightsizingApply: (
    clusterId: ClusterId,
    target: WorkloadRef,
    changes: ContainerResourceChange[],
    dryRun: boolean,
  ) => call<DryRunResult>('rightsizing_apply', { clusterId, target, changes, dryRun }),
  // -- Recommendations (stored, scheduled scans; read-only for the cluster) --
  /** Scan state, schedule and "Scan now" availability of one cluster. */
  recommendationsStatus: (clusterId: ClusterId) =>
    call<RecommendationScanStatus>('recommendations_status', { clusterId }),
  /**
   * "Scan now": refused while disconnected and within a minute of the last
   * manual scan; returns the running status while a scan runs. Progress
   * arrives on `events.onRecommendationScan`.
   */
  recommendationsScan: (clusterId: ClusterId) =>
    call<RecommendationScanStatus>('recommendations_scan', { clusterId }),
  /** The latest successful scan (or run `runId`), re-evaluated with the current strategy and settings. */
  recommendationsLatest: (clusterId: ClusterId, runId: number | null = null) =>
    call<RecommendationLatest>('recommendations_latest', { clusterId, runId }),
  /** Stored runs, newest first (at most 500). */
  recommendationsRuns: (clusterId: ClusterId, limit = 500) =>
    call<RecommendationRun[]>('recommendations_runs', { clusterId, limit }),
  /** One workload across the runs whose rows are kept, oldest first. */
  recommendationsTrend: (clusterId: ClusterId, workload: WorkloadRef) =>
    call<RecommendationTrendPoint[]>('recommendations_trend', { clusterId, workload }),
  /**
   * CPU and memory history of one container of a recommended workload
   * (Prometheus range queries; `days` null = 7). A row whose pod list was
   * truncated sends no pod names, so the workload's name pattern is used.
   */
  recommendationsUsageHistory: (
    clusterId: ClusterId,
    rec: Pick<WorkloadRecommendation, 'kind' | 'namespace' | 'name' | 'pods' | 'pods_truncated'>,
    container: string,
    days: number | null = null,
  ) =>
    call<WorkloadUsageHistory>('recommendations_usage_history', {
      clusterId,
      workload: { kind: rec.kind, namespace: rec.namespace, name: rec.name },
      container,
      pods: rec.pods_truncated ? [] : rec.pods,
      days,
    }),
  /** Every registered cluster with its latest successful run (stored data only). */
  recommendationsFleet: () => call<ClusterRecommendationSummary[]>('recommendations_fleet'),
  /** JSON or YAML of the selected workloads (empty = all), re-evaluated; no connection metadata. */
  recommendationsExport: (
    clusterId: ClusterId,
    runId: number | null,
    workloads: WorkloadRef[],
    format: RecommendationExportFormat,
  ) => call<string>('recommendations_export', { clusterId, runId, workloads, format }),
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
  /** `values.schema.json` the running revision was installed with (null = none). */
  helmReleaseValuesSchema: (clusterId: ClusterId, namespace: string, name: string) =>
    call<JsonSchema | null>('helm_release_values_schema', { clusterId, namespace, name }),
  /** `values.schema.json` of a repository / OCI chart version (pulled, cached; null = none). */
  helmChartValuesSchema: (chartRef: string, version: string | null) =>
    call<JsonSchema | null>('helm_chart_values_schema', { chartRef, version }),
  /**
   * Dry-run upgrade split into added / changed / removed objects versus the
   * running revision; `live` also dry-runs them against the live objects.
   * Never changes the cluster (allowed on read-only clusters).
   */
  helmUpgradePreview: (
    clusterId: ClusterId,
    namespace: string,
    name: string,
    request: HelmUpgradeRequest,
    live: boolean,
  ) =>
    call<HelmUpgradePreview>('helm_upgrade_preview', { clusterId, namespace, name, request, live }),

  // -- Upgrade readiness (read-only; allowed on read-only clusters) ---------
  /** Deprecated / removed API usage for an upgrade to `options.target_version`. */
  upgradeReadinessScan: (clusterId: ClusterId, options: UpgradeScanOptions) =>
    call<UpgradeReport>('upgrade_readiness_scan', { clusterId, options }),

  // -- Custom actions (k9s-plugin style, `actions.json`) ----------------------
  customActionsList: () => call<CustomActionsState>('custom_actions_list'),
  /** Replaces the whole list; broadcasts `customactions://changed`. */
  customActionsSave: (actions: CustomAction[]) =>
    call<CustomAction[]>('custom_actions_save', { actions }),
  /** Reads a Kubepit export or a k9s `plugins.yaml` (path in the desktop app, text in previews); saves nothing. */
  customActionsImport: (source: { path: string } | { text: string }) =>
    call<CustomActionImport>('custom_actions_import', {
      path: 'path' in source ? source.path : null,
      text: 'text' in source ? source.text : null,
    }),
  /** Preview of a (possibly unsaved) definition; `clusterId: null` uses sample cluster values. */
  customActionResolve: (
    action: CustomAction,
    clusterId: ClusterId | null,
    target: CustomActionTarget,
  ) => call<ResolvedCustomAction>('custom_action_resolve', { action, clusterId, target }),
  /** Runs a saved background action, or returns an open-url action's URL. */
  customActionRun: (clusterId: ClusterId, actionId: string, target: CustomActionTarget) =>
    call<CustomActionResult>('custom_action_run', { clusterId, actionId, target }),

  // -- Alerts (read-only observations; allowed on read-only clusters) -------
  /** Every alert of this session, newest activity first. */
  alertsList: () => call<Alert[]>('alerts_list'),
  /** `ids: null` marks everything read; broadcasts `alerts://changed`. */
  alertsMarkRead: (ids: string[] | null) => call<void>('alerts_mark_read', { ids }),
  /** `ids: null` clears everything; broadcasts `alerts://changed`. */
  alertsClear: (ids: string[] | null) => call<void>('alerts_clear', { ids }),

  // -- Resource wizards -----------------------------------------------------
  /** Bytes of a file picked in the open dialog, base64 (at most 1 MiB; never logged). */
  localFileRead: (path: string) => call<LocalFile>('local_file_read', { path }),

  // -- Assistant (opt-in; the backend holds keys, redacts and is the only egress) --
  /** Switches, credential store and per-provider key / egress status (no network). */
  aiStatus: () => call<AiStatus>('ai_status'),
  /** Stores the key in the OS credential store; it is never returned. */
  aiKeySet: (providerId: string, key: string) => call<AiStatus>('ai_key_set', { providerId, key }),
  aiKeyDelete: (providerId: string) => call<AiStatus>('ai_key_delete', { providerId }),
  /** The provider's model list (a network call, only on request; no cluster data). */
  aiModels: (providerId: string) => call<AiModelInfo[]>('ai_models', { providerId }),
  /** Production clusters need `acknowledgeProduction` (typed confirmation). */
  aiClusterSet: (clusterId: ClusterId, enabled: boolean, acknowledgeProduction: boolean) =>
    call<Settings>('ai_cluster_set', { clusterId, enabled, acknowledgeProduction }),
  /** Redacts, budgets and stores the exact payload; nothing leaves the machine yet. */
  aiPreview: (request: AiRequest) => call<AiPreview>('ai_preview', { request }),
  /** Sends a stored preview (single use); resolves to the run id, events stream on `onEvent`. */
  aiSend: (previewId: string, onEvent: (event: AiEvent) => void) =>
    callWithChannel<string, AiEvent>('ai_send', { previewId }, 'onEvent', onEvent),
  /** Answers a `pending-approval` tool call of a run. */
  aiToolDecision: (runId: string, callId: string, decision: AiToolDecision) =>
    call<void>('ai_tool_decision', { runId, callId, decision }),
  /** False when the run already ended. */
  aiCancel: (runId: string) => call<boolean>('ai_cancel', { runId }),
  /** Drops the session's in-memory history. */
  aiSessionEnd: (sessionId: string) => call<void>('ai_session_end', { sessionId }),
  /** The local request log (history.db), newest first, with totals. */
  aiLogList: (filter: AiLogFilter) => call<AiLogPage>('ai_log_list', { filter }),
  /** One logged run with the exact redacted request and the response. */
  aiLogGet: (id: number) => call<AiLogDetail>('ai_log_get', { id }),
  /** The filtered runs as JSON lines, bodies included. */
  aiLogExport: (filter: AiLogFilter) => call<string>('ai_log_export', { filter }),

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
  /** A window saved the settings (every window hears it, the saving one too). */
  onSettingsChanged: (handler: (payload: SettingsChanged) => void) =>
    listenEvent<SettingsChanged>('settings://changed', handler),
  /** An alert was raised or a repeat merged into one (every window hears it). */
  onAlert: (handler: (notice: AlertNotice) => void) =>
    listenEvent<AlertNotice>('alerts://new', handler),
  /** Alerts were marked read or cleared: refetch `alertsList`. */
  onAlertsChanged: (handler: () => void) => listenEvent<null>('alerts://changed', () => handler()),
  /** A cluster's recommendation scan changed state or progressed (at most every 250 ms). */
  onRecommendationScan: (handler: (status: RecommendationScanStatus) => void) =>
    listenEvent<RecommendationScanStatus>('recommendations://scan', handler),
  /** The saved custom actions after any save (every window hears it). */
  onCustomActionsChanged: (handler: (actions: CustomAction[]) => void) =>
    listenEvent<CustomAction[]>('customactions://changed', handler),
};
