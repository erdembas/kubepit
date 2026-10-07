export interface NamespaceCleanupKind {
  gvk: {
    group: string;
    version: string;
    kind: string;
    plural: string;
    namespaced: boolean;
  };
  count: number;
  /** A bounded sample of the object names. */
  names: string[];
}

/** `namespace_cleanup_preview`: everything the run would delete (read-only). */
export interface NamespaceCleanupPlan {
  namespace: string;
  /** Epoch ms when the inventory was read. */
  checked_at: number;
  read_only: boolean;
  terminating: boolean;
  /** Kinds in deletion order (controllers first, data last). */
  kinds: NamespaceCleanupKind[];
  total_objects: number;
  /** False when some kinds could not be listed; they are not in the plan. */
  inventory_complete: boolean;
  /** Fixed codes; never API error prose. */
  warnings: string[];
}

/** `namespace_cleanup_run` request; `confirm_name` must equal `namespace`. */
export interface NamespaceCleanupRequest {
  namespace: string;
  confirm_name: string;
}

export interface NamespaceCleanupKindResult {
  gvk: {
    group: string;
    version: string;
    kind: string;
    plural: string;
    namespaced: boolean;
  };
  planned: number;
  deleted: number;
  already_gone: number;
  failed: number;
  /** First errors, bounded. */
  errors: string[];
}

/** `namespace_cleanup_run` receipt. */
export interface NamespaceCleanupResult {
  namespace: string;
  /** Epoch ms. */
  started_at: number;
  /** Epoch ms. */
  finished_at: number;
  kinds: NamespaceCleanupKindResult[];
  deleted: number;
  already_gone: number;
  failed: number;
  inventory_complete: boolean;
}
