# Falco Runtime Threats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect or one-click install Falco, read its events from the Falco pods' logs into a local store, show them in a new Security ▸ Runtime threats tab and per-object details sections, and raise desktop notifications for dangerous events through the existing alert center.

**Architecture:** A new core module `crates/kubepit-core/src/falco/` holds a pure parser, a token-bucket guard, detection and an opt-in background watcher per connected cluster. The watcher reuses the merged workload-log driver (`run_workload_logs`) to follow the `falco` container of every Falco pod, stores events in `history.db` (`history/falco.rs`), pushes batches to the UI (`falco://events`) and raises `RuntimeThreat` alerts through `AlertCenter::raise`. The UI reads the store through three read-only commands. The Trivy one-click installer is generalised into an operator installer that also installs Falco.

**Tech Stack:** Rust (tokio, kube-rs watchers and log streams, rusqlite, serde, regex, chrono), Tauri 2 commands and events, React 18 + Tailwind v4 + Zustand, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-29-falco-runtime-threats-design.md`

## Global Constraints

- **IPC contract:** every new command, type and event changes `apps/desktop/src/types/index.ts` **and** `apps/desktop/src/lib/ipc.ts` in the same task as the Rust side. Serde names are snake_case like the TS interfaces; tagged unions use `#[serde(tag = "mode", rename_all = "lowercase")]` (config) or `rename_all = "kebab-case"` (states). Every new Tauri command is listed in `apps/desktop/src-tauri/src/ipc/audit_coverage.rs` (`NOT_MUTATING` for all three Falco commands) and gets a mock handler in `apps/desktop/src/lib/ipc/mock/`.
- **Design:** visually identical to RunHQ. Tokens from `src/styles/theme.css`, primitives from `src/components/ui/` (`Button`, `IconButton`, `Select`, `Switch`, `Dialog`, `Drawer`, `Badge`), 11–13px UI text, uppercase tracked labels, `bg-fg/N` hover pads, the accent strip for active rows. **No chart or UI libraries**: the histogram is SVG with tokens. Layouts use container queries (`@container`, `@2xl:`), like `SecurityPage`.
- **i18n:** every user-visible string ships in English **and** Turkish in the same task. Components: `import * as i18n from '@/i18n'` + `i18n.useLocale()`; pure helpers: `@/i18n/core`. `i18n.t` / `i18n.rich` / `i18n.plural`, never concatenated fragments. Run `pnpm i18n:check -- --fix`, then add Turkish by hand; `pnpm i18n:check` must pass. Catalog ownership (`scripts/check-i18n.mjs`): `components/workbench/**` and `lib/kube/**` → `workbench.json`; everything else (`lib/alerts`, `components/cluster-editor`, `components/settings`) → `shell.json`. **Never translate** rule names, Falco messages, output fields, tags, commands, node/pod/namespace names or Falco's own words. Falco priority names are translated like Trivy severities (`severityName` in `security/severity.tsx`).
- **Safety:** tests never connect to a real cluster and never read `~/.kube`. Rust tests use the fake API server (`crates/kubepit-core/tests/support/`), `Paths::new(tempdir)` and fake helm; frontend tests mock `@/lib/ipc`. The Falco watcher never mutates anything. The install runs only the existing audited `resource_apply_yaml` and `helm_install`, which honour `ClusterDef.read_only` in the backend.
- **Background work is opt-in per process and per cluster:** `Kubepit::set_falco_watching(true)` only in `apps/desktop/src-tauri/src/setup.rs`; per cluster via `Settings.falco.watch_clusters`. The watcher uses `pool.connected_client` and never connects on its own. It stops in `stop_cluster_work`, on removal, on opt-out, on a `ClusterDef.falco` change and on shutdown.
- **Limits:** 64 streamed sources (the workload-log cap); ingest 50 events/s sustained, burst 500; UI batches every 500 ms with ≤ 200 events; queries ≤ 1000 events per page (default 200); ≤ 200 mutes; message ≤ 4 KiB, command ≤ 1 KiB, ≤ 64 fields of ≤ 1 KiB, ≤ 32 tags; retention 1–90 days (default 7); cap 1 000–500 000 events per cluster (default 50 000); alert only events ≤ 10 min old.
- **History migration number:** use the next free number in `crates/kubepit-core/src/history/db.rs` `MIGRATIONS` at implementation time (2 is taken by recommendations; the AI assistant plan may take 3).
- **Checks, all passing at the end of every task that touches their area:** `pnpm typecheck` · `pnpm i18n:check` · `pnpm test:ui` · `cargo fmt --all -- --check` · `cargo clippy --workspace --all-targets -- -D warnings` · `cargo test --workspace`. `pnpm dev:ui` must keep working against the demo backend.
- **Existing work to rebase on:** the Trivy one-click install (`b2f8b60`). A separate task ("Refresh API discovery after Helm installs and applies") may have added a shared `rediscover(clusterId)` helper next to `useApiResources` in `components/workbench/data/hooks.ts`; if it exists, Task 7 uses it instead of `publishDiscovery`.

## Execution

- **Task 1 first, alone** (contract, stubs and the Security tab skeleton), merged into `main` before anything else, so the groups below can run in parallel worktrees without touching the same files except the i18n catalogs.
- **Group A — core** (Tasks 2 → 6, one worktree, in order): parser and guard, storage, detection, watcher and alerts, commands and wiring.
- **Group B — installer** (Tasks 7 → 8): generic operator installer with Trivy moved onto it, then the Falco install.
- **Group C — runtime UI** (Tasks 9 → 12): pure helpers, live store and hooks, the Runtime tab, the details section.
- **Group D — integration** (Tasks 13 → 14): alerts UI, cluster editor and settings; the demo backend.
- **Task 15 last:** docs, full verification, manual smoke in English and Turkish.
- After every group: an independent `code-reviewer` agent on the group's diff, fixes, then a re-review. i18n catalogs conflict on merge: resolve by keeping both sides and re-running `pnpm i18n:check -- --fix`.
- **Phase 2 (optional, after release):** Task 16 (Loki search for older events) and Task 17 (Falcosidekick PolicyReports).

## Review Focus

- **Noisy rule storm** (thousands of events per second from one rule): the guard drops the excess and reports `dropped`, the UI stays responsive, and alerts collapse through the book's burst grouping. Tested in Task 2 (`bucket_limits_bursts_and_refills`) and Task 5 (`storm_is_bounded_and_reported`).
- **Reconnect after a long disconnect:** the backfill brings old events back once, without duplicates and **without notifications** for events older than 10 minutes. Tested in Task 5 (`backfill_restores_without_duplicates_or_alerts`).
- **Text output / buffered output / other labels:** text lines still produce events (priority, message, node, no rule); `tty: false` shows the buffering notice; pods mode finds non-standard installs. Tested in Tasks 2, 4 and 11.
- **RBAC-restricted users:** cluster-wide pod listing forbidden → fallback namespaces; logs forbidden → `forbidden` status, no retry storm. Tested in Task 4 (`detection_falls_back_on_403`) and Task 5.
- **Disconnect during a stream / window closed:** the watcher stops with the cluster work, never reconnects, and a new connect resumes from the store. Tested in Task 5 (`never_connects_and_stops_on_disconnect`).
- **Trivy install unchanged:** the generalised installer keeps every Trivy behaviour (retry semantics, production confirm, discovery wait, operator-missing card). Tested in Task 7 (the existing `trivyInstall.test.ts` cases, moved).

---

## File Structure

**Core (Rust)**
- `crates/kubepit-core/src/falco/mod.rs`: create. Module doc, `FalcoWatchers` state, `set_falco_watching`, lifecycle hooks, `falco_status` / `falco_events` / `falco_summary`.
- `crates/kubepit-core/src/falco/types.rs`: create. Every contract type (spec §10.1).
- `crates/kubepit-core/src/falco/parse.rs`: create. Pure line parser.
- `crates/kubepit-core/src/falco/guard.rs`: create. Token bucket, backfill window, alert gate, mute matching (pure).
- `crates/kubepit-core/src/falco/detect.rs`: create. Finding Falco pods, status.
- `crates/kubepit-core/src/falco/watcher.rs`: create. The per-cluster loop.
- `crates/kubepit-core/src/history/falco.rs`: create. Migration SQL, insert, query, summary, recent ids, prune.
- `crates/kubepit-core/src/history/db.rs`: modify. `MIGRATIONS` entry, `PrunePolicy.falco_before` / `falco_max_per_cluster`, `clear` for `HistoryKind::Falco`, size-cap tier.
- `crates/kubepit-core/src/history/writer.rs`: modify. `WriteOp::Falco`, `is_data`.
- `crates/kubepit-core/src/history/types.rs`: modify. `HistoryKind::Falco`.
- `crates/kubepit-core/src/history.rs`: modify. `policy()` fills the Falco fields; readers for the Falco queries.
- `crates/kubepit-core/src/alerts/model.rs`, `alerts/detect.rs`, `alerts/book.rs`: modify. `AlertReason::RuntimeThreat`, `Finding.severity` override, `Finding::runtime_threat`.
- `crates/kubepit-core/src/workload_logs.rs`: modify. `run_workload_logs` becomes `pub(crate)`.
- `crates/kubepit-core/src/types.rs`: modify. `ClusterDef.falco`, `ClusterInput.falco`, `Settings.falco`.
- `crates/kubepit-core/src/cluster.rs`: modify. Validate/normalize `falco`, restart the watcher on change, clear stored events on removal.
- `crates/kubepit-core/src/connection.rs`: modify. Start after connect, stop in `stop_cluster_work`.
- `crates/kubepit-core/src/app.rs`: modify. `falco` field, `set_settings` normalizes and syncs, shutdown stops.
- `crates/kubepit-core/src/events.rs`: modify. `falco_events`, `falco_status` (no-op defaults).
- `crates/kubepit-core/src/lib.rs`: modify. `pub mod falco;` + module table row.
- `crates/kubepit-core/tests/falco.rs`: create. Integration tests on the fake API server.

**Desktop shell**
- `apps/desktop/src-tauri/src/ipc/falco.rs`: create. `falco_status`, `falco_events`, `falco_summary`.
- `apps/desktop/src-tauri/src/ipc/mod.rs`, `src-tauri/src/lib.rs`: modify. Module and `generate_handler!`.
- `apps/desktop/src-tauri/src/ipc/audit_coverage.rs`: modify. `NOT_MUTATING`.
- `apps/desktop/src-tauri/src/app_state.rs`: modify. `EVENT_FALCO_EVENTS`, `EVENT_FALCO_STATUS`, the two sink methods.
- `apps/desktop/src-tauri/src/setup.rs`: modify. `set_falco_watching(true)`.

**Frontend**
- `apps/desktop/src/types/index.ts`, `apps/desktop/src/lib/ipc.ts`: modify (contract).
- `apps/desktop/src/lib/kube/falco/{priority,model,index}.ts` (+ `*.test.ts`): create.
- `apps/desktop/src/lib/kube/operators/{install,specs,index}.ts` (+ `install.test.ts`): create. `lib/kube/trivy/install.ts`: modify (wrappers).
- `apps/desktop/src/components/workbench/security/operatorInstall.ts` (+ `.test.ts`): create. `trivyInstall.ts` (+ test): modify (thin wrapper).
- `apps/desktop/src/components/workbench/security/OperatorInstallCard.tsx`: create (extracted from `TrivyMissing.tsx`). `TrivyMissing.tsx`: modify.
- `apps/desktop/src/components/workbench/security/securityTabs.ts`: create. Picked tab + runtime focus per cluster (moved out of `SecurityPage.tsx`).
- `apps/desktop/src/components/workbench/security/SecurityPage.tsx`: modify. `runtime` tab.
- `apps/desktop/src/components/workbench/security/runtime/`: create. `RuntimeTab.tsx`, `FalcoMissing.tsx`, `FalcoWatchCard.tsx`, `RuntimeOverview.tsx`, `RuntimeHistogram.tsx`, `RuntimeTopLists.tsx`, `RuntimeEventList.tsx`, `RuntimeEventDrawer.tsx`, `RuntimeSettingsDialog.tsx`, `priority.tsx`, `useFalco.ts`, `falcoSettings.ts`.
- `apps/desktop/src/store/useFalcoStore.ts` (+ `.test.ts`): create.
- `apps/desktop/src/components/workbench/security/ObjectRuntime.tsx`: create. `details/DetailsOverview.tsx`: modify.
- `apps/desktop/src/lib/alerts/{policy,text,actions}.ts`: modify. `RuntimeThreat`.
- `apps/desktop/src/components/cluster-editor/FalcoFields.tsx`: create. `ClusterEditor.tsx`: modify.
- `apps/desktop/src/lib/ipc/mock/falco.ts`, `mock/fixtures/falco.ts`: create. `mock/index.ts`, `mock/helmCharts.ts`, `mock/fixtures/charts.ts`, `mock/fixtures/build.ts`, `mock/app.ts`, `mock/alerts.ts`, `mock/history.ts`: modify.
- `apps/desktop/src/i18n/{en,tr}/{workbench,shell}.json`: modify.
- `docs/ARCHITECTURE.md`, `README.md`, `docs/superpowers/plans/README.md`: modify.

---

### Task 1: Contract, stubs and the Security tab skeleton

**Files:**
- Create: `crates/kubepit-core/src/falco/{mod.rs,types.rs}`, `apps/desktop/src-tauri/src/ipc/falco.rs`, `apps/desktop/src/lib/ipc/mock/falco.ts`, `apps/desktop/src/components/workbench/security/securityTabs.ts`, `apps/desktop/src/components/workbench/security/runtime/{RuntimeTab,FalcoMissing}.tsx`
- Modify: `crates/kubepit-core/src/{lib.rs,types.rs,events.rs,app.rs,cluster.rs}`, `crates/kubepit-core/src/alerts/model.rs`, `crates/kubepit-core/src/history/types.rs`, `apps/desktop/src-tauri/src/{lib.rs,app_state.rs,ipc/mod.rs,ipc/audit_coverage.rs}`, `apps/desktop/src/types/index.ts`, `apps/desktop/src/lib/ipc.ts`, `apps/desktop/src/lib/ipc/mock/index.ts`, `apps/desktop/src/lib/alerts/{policy,text}.ts`, `apps/desktop/src/components/workbench/security/SecurityPage.tsx`, i18n catalogs
- Test: `crates/kubepit-core/src/falco/types.rs` (unit), `apps/desktop/src/lib/alerts/text.test.ts` (extend or create)

**Interfaces:**
- Produces: every type in spec §10.1 on both sides; `ipc.falcoStatus(clusterId, refresh?)`, `ipc.falcoEvents(clusterId, query)`, `ipc.falcoSummary(clusterId, query)`; `events.onFalcoEvents(handler)`, `events.onFalcoStatus(handler)`; `AlertReason::RuntimeThreat`; `HistoryKind::Falco`; `EventSink::falco_events(&FalcoEventBatch)` and `EventSink::falco_status(&FalcoStatus)`; the `runtime` Security tab rendering `<RuntimeTab/>`; `securityTabs.ts` (`pickedSecurityTab`, `setSecurityTab`, `useRuntimeFocus`, `setRuntimeFocus`).
- The three commands return stubs in this task (`falco_status` → `state: "not-found"`, the others empty) so later groups can build on a compiling tree.

- [ ] **Step 1: Write the Rust types with round-trip tests**

```rust
// crates/kubepit-core/src/falco/types.rs
//! Contract types of the Falco runtime-threats feature (spec §10.1).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Falco's priorities, lowest first, so `>=` compares severity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum FalcoPriority {
    Debug,
    Informational,
    Notice,
    #[default]
    Warning,
    Error,
    Critical,
    Alert,
    Emergency,
}

impl FalcoPriority {
    pub const ALL: [FalcoPriority; 8] = [
        Self::Debug, Self::Informational, Self::Notice, Self::Warning,
        Self::Error, Self::Critical, Self::Alert, Self::Emergency,
    ];

    /// Falco's spelling, any case; `Info` is an alias of `Informational`.
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "debug" => Some(Self::Debug),
            "informational" | "info" => Some(Self::Informational),
            "notice" => Some(Self::Notice),
            "warning" | "warn" => Some(Self::Warning),
            "error" => Some(Self::Error),
            "critical" => Some(Self::Critical),
            "alert" => Some(Self::Alert),
            "emergency" => Some(Self::Emergency),
            _ => None,
        }
    }

    /// 0 (debug) … 7 (emergency): the stored column.
    pub fn rank(self) -> i64 {
        self as i64
    }

    pub fn from_rank(rank: i64) -> Self {
        Self::ALL[rank.clamp(0, 7) as usize]
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FalcoEvent {
    /// Falco's `uuid`, else `h:` + 16 hex digits (see `parse::event_id`).
    pub id: String,
    pub cluster_id: String,
    /// Epoch ms.
    pub time: i64,
    pub priority: FalcoPriority,
    /// `None` for plain-text output.
    pub rule: Option<String>,
    /// `syscall`, `k8saudit`, … (`""` unknown).
    pub source: String,
    /// The node name with the official chart (`FALCO_HOSTNAME` = `spec.nodeName`).
    pub hostname: Option<String>,
    pub namespace: Option<String>,
    pub pod: Option<String>,
    pub container: Option<String>,
    pub image: Option<String>,
    pub command: Option<String>,
    pub user: Option<String>,
    pub message: String,
    pub tags: Vec<String>,
    pub fields: BTreeMap<String, String>,
}

/// `ClusterDef.falco`: where the watcher looks for Falco.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(tag = "mode", rename_all = "lowercase")]
pub enum FalcoConfig {
    /// Label `app.kubernetes.io/name=falco`, container `falco`, any namespace.
    #[default]
    Auto,
    Pods { namespace: String, selector: String, container: String },
    Off,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FalcoMute {
    /// `None`: every cluster.
    pub cluster_id: Option<String>,
    pub rule: String,
    /// `None`: every namespace (and host events).
    pub namespace: Option<String>,
}

/// `Settings.falco`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct FalcoSettings {
    pub watch_clusters: Vec<String>,
    pub alert_priority: FalcoPriority,
    pub retention_days: u32,
    pub max_events: u32,
    pub mutes: Vec<FalcoMute>,
}

impl Default for FalcoSettings {
    fn default() -> Self {
        Self {
            watch_clusters: Vec::new(),
            alert_priority: FalcoPriority::Warning,
            retention_days: 7,
            max_events: 50_000,
            mutes: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum FalcoState {
    Off,
    #[default]
    NotFound,
    Forbidden,
    Found,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum FalcoFormat {
    #[default]
    Unknown,
    Json,
    Text,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct FalcoStatus {
    pub cluster_id: String,
    pub state: FalcoState,
    /// The cluster is opted in and this process watches in the background.
    pub watching: bool,
    pub namespace: Option<String>,
    pub selector: Option<String>,
    pub container: Option<String>,
    pub pods: u32,
    pub ready_pods: u32,
    /// The DaemonSet's `desiredNumberScheduled`, else the pod count.
    pub nodes: u32,
    /// Container streams following / waiting for a slot (64-source cap).
    pub streaming: u32,
    pub skipped: u32,
    pub format: FalcoFormat,
    /// `Some(true)`: the Falco container has no TTY, so output is buffered.
    pub buffered: Option<bool>,
    pub version: Option<String>,
    pub last_event_at: Option<i64>,
    pub backfill_since: Option<i64>,
    /// Events not stored because of the ingest guard, since the watcher started.
    pub dropped: u64,
    pub error: Option<String>,
    pub checked_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FalcoCursor {
    pub time: i64,
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct FalcoQuery {
    pub since: Option<i64>,
    pub until: Option<i64>,
    pub min_priority: Option<FalcoPriority>,
    pub namespaces: Vec<String>,
    pub pod: Option<String>,
    pub pod_prefix: Option<String>,
    pub hostname: Option<String>,
    pub rules: Vec<String>,
    pub text: Option<String>,
    pub include_muted: bool,
    pub before: Option<FalcoCursor>,
    /// 0 → 200; at most 1000.
    pub limit: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct FalcoEventPage {
    pub events: Vec<FalcoEvent>,
    pub next: Option<FalcoCursor>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct FalcoSummaryQuery {
    pub since: i64,
    pub until: i64,
    pub namespaces: Vec<String>,
    pub include_muted: bool,
}

/// Counts by display group: `critical` includes alert and emergency, `info` debug.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct FalcoCounts {
    pub critical: u64,
    pub error: u64,
    pub warning: u64,
    pub notice: u64,
    pub info: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FalcoBucket {
    pub start: i64,
    pub counts: FalcoCounts,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FalcoRuleCount {
    /// `None`: text output without rule names.
    pub rule: Option<String>,
    pub count: u64,
    pub max_priority: FalcoPriority,
    pub last_at: i64,
    pub muted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FalcoPodCount {
    pub namespace: String,
    pub pod: String,
    pub count: u64,
    pub max_priority: FalcoPriority,
    pub last_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct FalcoSummary {
    pub since: i64,
    pub until: i64,
    pub bucket_ms: i64,
    pub buckets: Vec<FalcoBucket>,
    pub totals: FalcoCounts,
    pub top_rules: Vec<FalcoRuleCount>,
    pub top_pods: Vec<FalcoPodCount>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FalcoEventBatch {
    pub cluster_id: String,
    pub events: Vec<FalcoEvent>,
    /// More events arrived than one batch carries: refetch.
    pub truncated: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn priorities_order_parse_and_serialize() {
        assert!(FalcoPriority::Critical > FalcoPriority::Warning);
        assert_eq!(FalcoPriority::parse("Info"), Some(FalcoPriority::Informational));
        assert_eq!(FalcoPriority::parse(" CRITICAL "), Some(FalcoPriority::Critical));
        assert_eq!(FalcoPriority::parse("loud"), None);
        assert_eq!(serde_json::to_string(&FalcoPriority::Informational).unwrap(), "\"informational\"");
        for p in FalcoPriority::ALL {
            assert_eq!(FalcoPriority::from_rank(p.rank()), p);
        }
    }

    #[test]
    fn config_and_settings_defaults_round_trip() {
        let cfg: FalcoConfig = serde_json::from_str(r#"{"mode":"pods","namespace":"sec","selector":"app=falco","container":"falco"}"#).unwrap();
        assert!(matches!(cfg, FalcoConfig::Pods { .. }));
        assert_eq!(serde_json::from_str::<FalcoConfig>(r#"{"mode":"off"}"#).unwrap(), FalcoConfig::Off);
        let s: FalcoSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(s, FalcoSettings::default());
        assert_eq!(serde_json::to_value(FalcoState::NotFound).unwrap(), "not-found");
    }
}
```

Add `impl FalcoConfig { pub fn normalized(self) -> Result<Self> }` (trim; pods mode needs a DNS-1123 namespace, a non-empty selector without control characters and ≤ 256 bytes, and a container name, defaulting to `falco` when empty) and `impl FalcoSettings { pub fn normalized(mut self) -> Self }` (dedupe/sort `watch_clusters`, clamp `retention_days` 1–90 and `max_events` 1 000–500 000, trim mutes, drop empty rules, dedupe, keep the first 200) and `pub fn watches(&self, cluster_id: &str) -> bool`. Test both in the same module.

- [ ] **Step 2: Run the tests to see them fail, then wire the module**

Run: `cargo test -p kubepit-core falco::types`
Expected: FAIL (module not declared). Add `pub mod falco;` to `lib.rs` (plus a row in its module table), `falco/mod.rs` with `pub mod types; pub use types::*;` and the module doc (spec §5). Run again: PASS.

- [ ] **Step 3: Extend the shared types and the sink**

- `types.rs`: `ClusterDef.falco: FalcoConfig` and `ClusterInput.falco: FalcoConfig` (`#[serde(default)]`, next to `loki`); `Settings.falco: FalcoSettings` (`#[serde(default)]`).
- `cluster.rs`: carry `falco` through `validate_input`/`cluster_add`/`cluster_update` with `.normalized()?` like `loki` (the restart hook comes in Task 6).
- `app.rs` `set_settings`: `settings.falco = settings.falco.normalized();`.
- `events.rs`: `fn falco_events(&self, _batch: &FalcoEventBatch) {}` and `fn falco_status(&self, _status: &FalcoStatus) {}`.
- `alerts/model.rs`: `AlertReason::RuntimeThreat` (doc: raised by `falco::watcher`, not by a watch), add to `ALL` (now 10), `severity()` → `Warning` (the finding can override it, Task 5), `kind()` → `None`.
- `history/types.rs`: `HistoryKind::Falco` (the `clear` arm comes in Task 3; until then map it to no tables).
- `falco/mod.rs`: stub `impl Kubepit { pub async fn falco_status(&self, cluster_id: &str, _refresh: bool) -> Result<FalcoStatus>; pub fn falco_events(&self, cluster_id: &str, _q: &FalcoQuery) -> Result<FalcoEventPage>; pub fn falco_summary(&self, cluster_id: &str, q: &FalcoSummaryQuery) -> Result<FalcoSummary> }` returning `FalcoStatus { cluster_id, state: NotFound, checked_at: now, ..Default::default() }` / empty values, each after `self.cluster_def(cluster_id)?`.

Fix every exhaustive `match` on `AlertReason` and `HistoryKind` the compiler reports (`cargo check --workspace`).

- [ ] **Step 4: Tauri commands, events and the audit list**

```rust
// apps/desktop/src-tauri/src/ipc/falco.rs
//! Falco runtime threats: status, stored events and summaries (read-only).

use kubepit_core::falco::{FalcoEventPage, FalcoQuery, FalcoStatus, FalcoSummary, FalcoSummaryQuery};
use tauri::State;

use super::{blocking, ipc_err, IpcResult};
use crate::AppState;

#[tauri::command]
pub async fn falco_status(cluster_id: String, refresh: bool, state: State<'_, AppState>) -> IpcResult<FalcoStatus> {
    let core = state.core.clone();
    core.falco_status(&cluster_id, refresh).await.map_err(ipc_err)
}

#[tauri::command]
pub async fn falco_events(cluster_id: String, query: FalcoQuery, state: State<'_, AppState>) -> IpcResult<FalcoEventPage> {
    let core = state.core.clone();
    blocking(move || core.falco_events(&cluster_id, &query)).await
}

#[tauri::command]
pub async fn falco_summary(cluster_id: String, query: FalcoSummaryQuery, state: State<'_, AppState>) -> IpcResult<FalcoSummary> {
    let core = state.core.clone();
    blocking(move || core.falco_summary(&cluster_id, &query)).await
}
```

Register in `ipc/mod.rs` (`mod falco; pub use falco::*;`) and in `generate_handler!` (a `// Falco runtime threats` block). Add the three names to `NOT_MUTATING` in `audit_coverage.rs`. In `app_state.rs` add `EVENT_FALCO_EVENTS = "falco://events"` and `EVENT_FALCO_STATUS = "falco://status"` and implement the two `TauriEventSink` methods with `app.emit`. (`blocking` must accept a closure returning `anyhow::Result<T>`; match its real signature in `ipc/mod.rs`.)

Run: `cargo test -p kubepit-desktop audit_coverage` → PASS; `cargo clippy --workspace --all-targets -- -D warnings` → clean.

- [ ] **Step 5: TypeScript contract**

In `types/index.ts` (next to the Loki types) add the TS mirrors of every type in Step 1, with the same field names and unions:

```ts
export type FalcoPriority =
  | 'debug' | 'informational' | 'notice' | 'warning' | 'error' | 'critical' | 'alert' | 'emergency';
export type FalcoConfig =
  | { mode: 'auto' }
  | { mode: 'pods'; namespace: string; selector: string; container: string }
  | { mode: 'off' };
export type FalcoState = 'off' | 'not-found' | 'forbidden' | 'found' | 'error';
export type FalcoFormat = 'unknown' | 'json' | 'text';
// FalcoEvent, FalcoMute, FalcoSettings, FalcoStatus, FalcoCursor, FalcoQuery,
// FalcoEventPage, FalcoSummaryQuery, FalcoCounts, FalcoBucket, FalcoRuleCount,
// FalcoPodCount, FalcoSummary, FalcoEventBatch: field-for-field copies of the
// Rust structs (Option<T> → T | null, Vec<T> → T[], BTreeMap → Record<string, string>).
```

Add `falco?: FalcoConfig` to `ClusterDef` and `ClusterInput`, `falco: FalcoSettings` to `Settings`, `'RuntimeThreat'` to `AlertReason`, `'falco'` to `HistoryKind`. In `lib/ipc.ts`:

```ts
  // -- Falco runtime threats (read-only; events are stored locally) ---------
  falcoStatus: (clusterId: ClusterId, refresh = false) =>
    call<FalcoStatus>('falco_status', { clusterId, refresh }),
  falcoEvents: (clusterId: ClusterId, query: FalcoQuery) =>
    call<FalcoEventPage>('falco_events', { clusterId, query }),
  falcoSummary: (clusterId: ClusterId, query: FalcoSummaryQuery) =>
    call<FalcoSummary>('falco_summary', { clusterId, query }),
```

and in `events`: `onFalcoEvents: (handler: (b: FalcoEventBatch) => void) => listenEvent<FalcoEventBatch>('falco://events', handler)` and `onFalcoStatus` likewise. Fix the TS compile errors the new settings field causes (mock default settings in `lib/ipc/mock/app.ts`: add `falco` with the Rust defaults).

- [ ] **Step 6: Mock stubs**

`lib/ipc/mock/falco.ts` registers `falco_status` (`{ cluster_id, state: 'not-found', watching: false, …, checked_at: Date.now() }`), `falco_events` (`{ events: [], next: null }`) and `falco_summary` (empty buckets for the range). Import it in `mock/index.ts` before `./history`. Task 14 replaces the bodies.

- [ ] **Step 7: Alert wording for the new reason**

- `lib/alerts/policy.ts`: append `'RuntimeThreat'` to `ALERT_REASONS`.
- `lib/alerts/text.ts`: `singleTitle` → `i18n.t('Runtime threat: {rule}', { rule: alert.condition ?? '' })`; `groupTitle` → `i18n.plural('{count} runtime threat in {namespace}', '{count} runtime threats in {namespace}', count, values)`; the body uses `alert.message` verbatim (as other reasons do); `reasonDescription('RuntimeThreat')` → `i18n.t('Falco reported a runtime threat at or above your threshold (Security ▸ Runtime threats).')`.
- Test in `lib/alerts/text.test.ts`: a `RuntimeThreat` alert with `condition: 'Terminal shell in container'` gets that rule in its title; every reason in `ALERT_REASONS` has a non-empty title and description.

Run `pnpm i18n:check -- --fix`, add the Turkish strings (`Çalışma zamanı tehdidi: {rule}`, …).

- [ ] **Step 8: The Security tab skeleton**

Create `security/securityTabs.ts` and move `pickedTab` out of `SecurityPage.tsx` into it:

```ts
import { create } from 'zustand';
import type { ClusterId } from '@/types';

export type SecurityTab = 'trivy' | 'runtime' | 'pss';

/** A filter the Runtime tab applies once (from an alert or a details link). */
export interface RuntimeFocus {
  namespace: string | null;
  pod: string | null;
  hostname: string | null;
  rule: string | null;
}

interface State {
  tabs: Record<ClusterId, SecurityTab>;
  focus: Record<ClusterId, RuntimeFocus | undefined>;
}

export const useSecurityTabs = create<State>(() => ({ tabs: {}, focus: {} }));

export const pickedSecurityTab = (clusterId: ClusterId): SecurityTab =>
  useSecurityTabs.getState().tabs[clusterId] ?? 'trivy';

export function setSecurityTab(clusterId: ClusterId, tab: SecurityTab) {
  useSecurityTabs.setState((s) => ({ tabs: { ...s.tabs, [clusterId]: tab } }));
}

export function setRuntimeFocus(clusterId: ClusterId, focus: RuntimeFocus | undefined) {
  useSecurityTabs.setState((s) => ({ focus: { ...s.focus, [clusterId]: focus } }));
}
```

In `SecurityPage.tsx`: `type Tab = SecurityTab`; the tab state reads `useSecurityTabs((s) => s.tabs[clusterId] ?? 'trivy')` and writes `setSecurityTab`; add `{ id: 'runtime', label: i18n.t('Runtime threats') }` between Trivy and PSS; the placeholder for `runtime` is `i18n.t('Search rule, message, command or pod…')`; the content ternary renders `<RuntimeTab clusterId={clusterId} namespaces={namespaces} isActive={isActive && tab === 'runtime'} query={query} />` for `runtime` (inside the same scroll container as PSS). `runtime/RuntimeTab.tsx` is a stub that renders `<FalcoMissing clusterId={clusterId} />`; `runtime/FalcoMissing.tsx` is a stub that renders the heading `i18n.t('Falco is not running on this cluster')`.

- [ ] **Step 9: Verify and commit**

Run the six checks. Expected: all pass; `pnpm dev:ui` shows the new tab with the stub card.

```bash
git add -A crates apps/desktop/src-tauri apps/desktop/src
git commit -m "feat(contract): Falco runtime-threat types, commands and the Security tab skeleton"
```

---

### Task 2: Parser and ingest guard (pure)

**Files:**
- Create: `crates/kubepit-core/src/falco/parse.rs`, `crates/kubepit-core/src/falco/guard.rs`
- Modify: `crates/kubepit-core/src/falco/mod.rs` (`pub mod parse; pub mod guard;`)
- Test: unit tests in both files

**Interfaces:**
- Produces: `parse::LineContext<'a> { cluster_id: &'a str, kubelet_ms: Option<i64>, node: Option<&'a str> }`; `parse::parse_line(ctx: &LineContext, line: &str) -> Parsed` with `enum Parsed { Event(Box<FalcoEvent>), Version(String), Other }`; `parse::event_id(uuid, time_key, hostname, rule, output) -> String`; `guard::Bucket::{new(rate_per_s, burst, now_ms), take(&mut self, now_ms) -> bool, dropped()}`; `guard::backfill_since_secs(now_ms, last_stored_ms: Option<i64>, retention_days: u32) -> i64`; `guard::is_muted(event: &FalcoEvent, mutes: &[FalcoMute]) -> bool`; `guard::should_alert(event, settings: &FalcoSettings, now_ms) -> bool`.

- [ ] **Step 1: Write the parser tests**

```rust
// crates/kubepit-core/src/falco/parse.rs (tests module)
const JSON_SHELL: &str = r#"{"hostname":"worker-1","output":"13:44:05.478445995: Notice A shell was spawned in a container with an attached terminal | evt_type=execve user=root","priority":"Notice","rule":"Terminal shell in container","source":"syscall","tags":["container","maturity_stable","mitre_execution","shell","T1059"],"time":"2026-09-29T13:44:05.478445995Z","output_fields":{"container.id":"ee97d9c4186f","container.name":"web","container.image.repository":"docker.io/library/nginx","container.image.tag":"1.27","evt.time":1790689445478445995,"k8s.ns.name":"shop","k8s.pod.name":"web-7d9f","proc.cmdline":"sh -c clear; (bash || ash || sh)","user.name":"root","user.loginuid":-1,"proc.tty":34816,"fd.name":"<NA>"}}"#;

fn ctx() -> LineContext<'static> {
    LineContext { cluster_id: "c1", kubelet_ms: Some(1_790_689_445_500), node: Some("node-a") }
}

fn event(p: Parsed) -> FalcoEvent {
    match p { Parsed::Event(e) => *e, other => panic!("not an event: {other:?}") }
}

#[test]
fn json_event_with_kubernetes_context() {
    let e = event(parse_line(&ctx(), JSON_SHELL));
    assert_eq!(e.rule.as_deref(), Some("Terminal shell in container"));
    assert_eq!(e.priority, FalcoPriority::Notice);
    assert_eq!(e.time, 1_790_689_445_478);
    assert_eq!(e.hostname.as_deref(), Some("worker-1"));
    assert_eq!(e.namespace.as_deref(), Some("shop"));
    assert_eq!(e.pod.as_deref(), Some("web-7d9f"));
    assert_eq!(e.container.as_deref(), Some("web"));
    assert_eq!(e.image.as_deref(), Some("docker.io/library/nginx:1.27"));
    assert_eq!(e.command.as_deref(), Some("sh -c clear; (bash || ash || sh)"));
    assert_eq!(e.user.as_deref(), Some("root"));
    // The "13:44:05…: Notice " prefix is stripped.
    assert!(e.message.starts_with("A shell was spawned"), "{}", e.message);
    assert_eq!(e.fields["user.loginuid"], "-1");
    assert!(!e.fields.contains_key("fd.name"), "<NA> is dropped");
    assert!(e.id.starts_with("h:") && e.id.len() == 18);
    assert_eq!(e.id, event(parse_line(&ctx(), JSON_SHELL)).id, "stable id");
}

#[test]
fn json_message_property_uuid_and_host_events() {
    let line = r#"{"uuid":"a1b2c3d4-0000-4000-8000-000000000001","priority":"Critical","rule":"Drop and execute new binary in container","output":"ignored when message is present","message":"Executing binary not part of base image","time":"2026-09-29T10:00:00Z","output_fields":{"container.id":"host","proc.cmdline":"/tmp/x"},"source":"syscall","tags":[]}"#;
    let e = event(parse_line(&ctx(), line));
    assert_eq!(e.id, "a1b2c3d4-0000-4000-8000-000000000001");
    assert_eq!(e.message, "Executing binary not part of base image");
    assert_eq!(e.namespace, None, "host event");
    assert_eq!(e.hostname.as_deref(), Some("node-a"), "falls back to the Falco pod's node");
}

#[test]
fn text_output_lines() {
    let e = event(parse_line(&ctx(), "13:44:05.478445995: Critical A shell was spawned in a container with an attached terminal (user=root k8s.ns=default k8s.pod=kubecon container=ee97d9c4186f)"));
    assert_eq!(e.priority, FalcoPriority::Critical);
    assert_eq!(e.rule, None);
    assert_eq!(e.time, 1_790_689_445_500, "kubelet timestamp");
    assert_eq!(e.namespace.as_deref(), Some("default"));
    assert_eq!(e.pod.as_deref(), Some("kubecon"));
    assert_eq!(event(parse_line(&ctx(), "Info Something")).priority, FalcoPriority::Informational);
}

#[test]
fn banner_version_and_garbage() {
    assert_eq!(parse_line(&ctx(), "Mon Sep 29 10:00:00 2026: Falco version: 0.41.3 (x86_64)"), Parsed::Version("0.41.3".into()));
    for line in ["", "Loading rules from:", "{not json", r#"{"priority":"Warning"}"#, "[falcoctl] INFO follow"] {
        assert_eq!(parse_line(&ctx(), line), Parsed::Other, "{line}");
    }
}

#[test]
fn caps_long_values_on_char_boundaries() {
    let long = "é".repeat(5000);
    let line = format!(r#"{{"priority":"Warning","rule":"r","output":"{long}","time":"2026-09-29T10:00:00Z","output_fields":{{"proc.cmdline":"{long}"}}}}"#);
    let e = event(parse_line(&ctx(), &line));
    assert!(e.message.len() <= 4096 && e.command.as_ref().unwrap().len() <= 1024);
    assert!(e.fields["proc.cmdline"].len() <= 1024);
}
```

- [ ] **Step 2: Run to see them fail**

Run: `cargo test -p kubepit-core falco::parse`
Expected: FAIL (`parse_line` not found).

- [ ] **Step 3: Implement the parser**

```rust
// crates/kubepit-core/src/falco/parse.rs
//! One Falco output line → [`FalcoEvent`] (pure; spec §6). JSON output
//! (`json_output: true`) and plain text are both understood; everything
//! else Falco or falcoctl prints is ignored.

use std::collections::BTreeMap;
use std::sync::LazyLock;

use regex::Regex;
use serde::Deserialize;
use serde_json::Value;

use super::types::{FalcoEvent, FalcoPriority};

const MAX_MESSAGE: usize = 4096;
const MAX_COMMAND: usize = 1024;
const MAX_VALUE: usize = 1024;
const MAX_FIELDS: usize = 64;
const MAX_TAGS: usize = 32;
const NA: &str = "<NA>";

pub struct LineContext<'a> {
    pub cluster_id: &'a str,
    /// The kubelet timestamp of the line (epoch ms).
    pub kubelet_ms: Option<i64>,
    /// The node of the Falco pod that printed it.
    pub node: Option<&'a str>,
}

#[derive(Debug, PartialEq)]
pub enum Parsed {
    Event(Box<FalcoEvent>),
    Version(String),
    Other,
}

#[derive(Deserialize)]
struct Raw {
    #[serde(default)]
    uuid: Option<String>,
    #[serde(default)]
    time: Option<String>,
    #[serde(default)]
    rule: Option<String>,
    priority: String,
    #[serde(default)]
    output: Option<String>,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    output_fields: BTreeMap<String, Value>,
    #[serde(default)]
    hostname: Option<String>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
}

static TEXT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:\d{2}:\d{2}:\d{2}\.\d{1,9}: )?(Emergency|Alert|Critical|Error|Warning|Notice|Informational|Info|Debug) (.+)$").unwrap()
});
static PREFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\d{2}:\d{2}:\d{2}\.\d{1,9}: [A-Za-z]+ ").unwrap());
static VERSION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"Falco version: (\S+)").unwrap());
static TEXT_KV: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:^|[\s(])(k8s\.ns\.name|k8s\.ns|k8s_ns|k8s\.pod\.name|k8s\.pod|k8s_pod_name)=([^\s)]+)").unwrap()
});

pub fn parse_line(ctx: &LineContext, line: &str) -> Parsed {
    let line = line.trim();
    if line.starts_with('{') {
        return serde_json::from_str::<Raw>(line)
            .ok()
            .and_then(|raw| from_json(ctx, raw))
            .map_or(Parsed::Other, |e| Parsed::Event(Box::new(e)));
    }
    if let Some(caps) = TEXT.captures(line) {
        if let (Some(priority), Some(time)) = (FalcoPriority::parse(&caps[1]), ctx.kubelet_ms) {
            return Parsed::Event(Box::new(from_text(ctx, priority, &caps[2], time)));
        }
    }
    match VERSION.captures(line) {
        Some(caps) => Parsed::Version(caps[1].to_string()),
        None => Parsed::Other,
    }
}

fn from_json(ctx: &LineContext, raw: Raw) -> Option<FalcoEvent> {
    let priority = FalcoPriority::parse(&raw.priority)?;
    let output = raw.output.unwrap_or_default();
    let message = match raw.message.filter(|m| !m.trim().is_empty()) {
        Some(m) => m,
        None if !output.is_empty() => PREFIX.replace(&output, "").into_owned(),
        None => return None,
    };
    let time = raw
        .time
        .as_deref()
        .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
        .map(|t| t.timestamp_millis())
        .or(ctx.kubelet_ms)?;
    let fields = stringify(raw.output_fields);
    let host_event = fields.get("container.id").map(String::as_str) == Some("host");
    let get = |k: &str| if host_event { None } else { fields.get(k).cloned() };
    let image = get("container.image.repository").map(|repo| match fields.get("container.image.tag") {
        Some(tag) if !tag.is_empty() => format!("{repo}:{tag}"),
        _ => repo,
    });
    let hostname = raw.hostname.filter(|h| !h.is_empty()).or(ctx.node.map(str::to_string));
    let rule = raw.rule.filter(|r| !r.trim().is_empty());
    let time_key = raw.time.clone().unwrap_or_else(|| time.to_string());
    Some(FalcoEvent {
        id: event_id(raw.uuid.as_deref(), &time_key, hostname.as_deref(), rule.as_deref(), &output_or(&output, &message)),
        cluster_id: ctx.cluster_id.to_string(),
        time,
        priority,
        rule,
        source: raw.source.unwrap_or_default(),
        hostname,
        namespace: get("k8s.ns.name"),
        pod: get("k8s.pod.name"),
        container: get("container.name"),
        image,
        command: fields.get("proc.cmdline").map(|c| cap(c, MAX_COMMAND)),
        user: fields.get("user.name").cloned(),
        message: cap(&message, MAX_MESSAGE),
        tags: raw.tags.into_iter().take(MAX_TAGS).collect(),
        fields,
    })
}

fn output_or(output: &str, message: &str) -> String {
    if output.is_empty() { message.to_string() } else { output.to_string() }
}

fn from_text(ctx: &LineContext, priority: FalcoPriority, message: &str, time: i64) -> FalcoEvent {
    let mut namespace = None;
    let mut pod = None;
    for caps in TEXT_KV.captures_iter(message) {
        let value = Some(caps[2].to_string()).filter(|v| v != NA);
        if caps[1].contains("ns") { namespace = namespace.or(value) } else { pod = pod.or(value) }
    }
    let hostname = ctx.node.map(str::to_string);
    FalcoEvent {
        id: event_id(None, &time.to_string(), hostname.as_deref(), None, message),
        cluster_id: ctx.cluster_id.to_string(),
        time,
        priority,
        rule: None,
        source: String::new(),
        hostname,
        namespace,
        pod,
        container: None,
        image: None,
        command: None,
        user: None,
        message: cap(message, MAX_MESSAGE),
        tags: Vec::new(),
        fields: BTreeMap::new(),
    }
}

fn stringify(raw: BTreeMap<String, Value>) -> BTreeMap<String, String> {
    raw.into_iter()
        .filter_map(|(k, v)| {
            let s = match v {
                Value::Null => return None,
                Value::String(s) => s,
                other => other.to_string(),
            };
            (s != NA).then(|| (k, cap(&s, MAX_VALUE)))
        })
        .take(MAX_FIELDS)
        .collect()
}

/// `uuid` when Falco sends one, else a stable FNV-1a 64 hash (spec D5).
pub fn event_id(uuid: Option<&str>, time_key: &str, hostname: Option<&str>, rule: Option<&str>, output: &str) -> String {
    if let Some(u) = uuid.map(str::trim).filter(|u| !u.is_empty()) {
        return u.to_string();
    }
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for (i, part) in [time_key, hostname.unwrap_or(""), rule.unwrap_or(""), output].iter().enumerate() {
        if i > 0 {
            h = (h ^ u64::from(b'|')).wrapping_mul(0x0100_0000_01b3);
        }
        for b in part.bytes() {
            h = (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3);
        }
    }
    format!("h:{h:016x}")
}

fn cap(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let end = s.char_indices().map(|(i, c)| i + c.len_utf8()).take_while(|&i| i <= max).last().unwrap_or(0);
    s[..end].to_string()
}
```

Run: `cargo test -p kubepit-core falco::parse` → PASS.

- [ ] **Step 4: Guard tests, then implementation**

```rust
// crates/kubepit-core/src/falco/guard.rs (tests)
// Helpers: `const DAY_MS: i64 = 86_400_000;`, `const NOW: i64 = 1_790_689_445_478;` and
// `fn sample_event() -> FalcoEvent` (cluster "c1", rule "Terminal shell in container",
// namespace "shop", priority Warning, time NOW).
#[test]
fn bucket_limits_bursts_and_refills() {
    let mut b = Bucket::new(50.0, 500.0, 0);
    assert_eq!((0..1000).filter(|_| b.take(0)).count(), 500);
    assert_eq!(b.dropped(), 500);
    assert_eq!((0..100).filter(|_| b.take(1_000)).count(), 50, "one second refills 50");
}

#[test]
fn backfill_window() {
    let now = 10 * DAY_MS;
    assert_eq!(backfill_since_secs(now, None, 7), 3600);
    assert_eq!(backfill_since_secs(now, Some(now - 5_000), 7), 60, "at least a minute");
    assert_eq!(backfill_since_secs(now, Some(now - 600_000), 7), 630, "+30 s overlap");
    assert_eq!(backfill_since_secs(now, Some(0), 7), 7 * 86_400, "at most the retention");
}

#[test]
fn mutes_and_alert_gate() {
    let mut e = sample_event(); // rule "Terminal shell in container", ns "shop", priority Warning, time = NOW
    let mut s = FalcoSettings::default();
    assert!(should_alert(&e, &s, NOW));
    e.priority = FalcoPriority::Notice;
    assert!(!should_alert(&e, &s, NOW), "below the threshold");
    e.priority = FalcoPriority::Critical;
    assert!(!should_alert(&e, &s, NOW + 11 * 60_000), "older than 10 minutes");
    s.mutes.push(FalcoMute { cluster_id: Some("c1".into()), rule: e.rule.clone().unwrap(), namespace: Some("shop".into()) });
    assert!(is_muted(&e, &s.mutes) && !should_alert(&e, &s, NOW));
    s.mutes[0].namespace = Some("other".into());
    assert!(!is_muted(&e, &s.mutes));
    s.mutes[0] = FalcoMute { cluster_id: None, rule: e.rule.clone().unwrap(), namespace: None };
    assert!(is_muted(&e, &s.mutes), "a global mute");
}
```

Implement `Bucket` (tokens as `f64`, refilled `rate × elapsed_s` up to `burst`, `dropped: u64`), `backfill_since_secs` (`None` → 3600; else `((now − last) / 1000 + 30).clamp(60, retention_days × 86 400)`), `is_muted` (rule equal, `cluster_id` none or equal, `namespace` none or equal to the event's), and `should_alert` (`priority ≥ alert_priority && !is_muted && now − time ≤ 600_000`). A text event (`rule: None`) can only be muted by nothing and alerts under the rule label `(text output)`.

Run: `cargo test -p kubepit-core falco::guard` → PASS; `cargo clippy --workspace --all-targets -- -D warnings` → clean.

- [ ] **Step 5: Commit**

```bash
git add crates/kubepit-core/src/falco
git commit -m "feat(core): parse Falco output lines and guard the ingest rate"
```

---

### Task 3: Local store in history.db

**Files:**
- Create: `crates/kubepit-core/src/history/falco.rs`
- Modify: `crates/kubepit-core/src/history/{db.rs,writer.rs,types.rs}`, `crates/kubepit-core/src/history.rs`, `crates/kubepit-core/src/falco/mod.rs`
- Test: unit tests in `history/falco.rs` (in-memory or temp-file database via `db::open`)

**Interfaces:**
- Consumes: `FalcoEvent`, `FalcoQuery`, `FalcoSummaryQuery`, `FalcoMute` (Task 1).
- Produces: `pub(crate) const MIGRATION: &str` (spec §7 SQL); `insert_events(tx: &Transaction, events: &[FalcoEvent]) -> Result<u64>` (`INSERT OR IGNORE`); `query_events(conn, cluster_id, q, mutes, now) -> Result<FalcoEventPage>`; `summary(conn, cluster_id, q, mutes) -> Result<FalcoSummary>`; `recent_ids(conn, cluster_id, since) -> Result<HashSet<String>>` (at most 50 000); `last_time(conn, cluster_id) -> Result<Option<i64>>`; `prune(conn, before, max_per_cluster) -> Result<u64>`; `WriteOp::Falco(Vec<FalcoEvent>)`; `PrunePolicy { falco_before, falco_max_per_cluster, .. }`; `Kubepit::falco_events` / `falco_summary` now read the store.

- [ ] **Step 1: Write the store tests**

Cover, each as its own `#[test]` on a fresh database opened with `db::open(tempdir/history.db)`:

1. `insert_is_idempotent_and_round_trips`: insert two events, insert one again → 2 rows; `query_events` returns them newest first with every field equal (tags and fields through JSON).
2. `pages_with_a_keyset_cursor`: 450 events with distinct times and 3 events sharing one time; `limit: 200` pages visit all 453 exactly once in order; `next` is `None` on the last page.
3. `filters`: `min_priority`, `namespaces` (host events excluded when a namespace filter is set), `pod`, `pod_prefix` (`web-` matches `web-7d9f-x`, `LIKE` wildcards in the prefix are escaped), `hostname`, `rules`, `text` (matches message, command, rule and pod; `%` and `_` in the text are literal), `since`/`until`.
4. `mutes_apply_at_query_time`: a mute for `(rule, namespace)` hides matching events unless `include_muted`; a mute without namespace hides every namespace; removing the mute shows them again.
5. `summary_buckets_totals_and_tops`: 24 h range → `bucket_ms = 3_600_000` and 24 buckets (empty ones included); a 7 d range → 6 h buckets; `totals` groups alert/emergency into `critical` and debug into `info`; `top_rules` sorted by count then `last_at`, with `muted` set; `top_pods` excludes host events; at most 10 of each.
6. `prune_by_age_and_cap`: events older than `before` are deleted; with `max_per_cluster = 100`, the newest 100 per cluster survive and other clusters are untouched.
7. `clear_falco_for_one_cluster_or_all`: `db::clear(conn, HistoryKind::Falco, Some("c1"))` removes only c1's rows; `HistoryKind::All` removes the table's rows too.

- [ ] **Step 2: Run to see them fail**

Run: `cargo test -p kubepit-core history::falco`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

- `history/falco.rs`: the SQL from spec §7 as `MIGRATION`. Queries build their `WHERE` from bound parameters only (`rusqlite::params_from_iter`), with a `Vec<Box<dyn ToSql>>`:
  - base: `cluster_id = ?`, optional `time >= ?`, `time < ?`, `priority >= ?`;
  - namespaces: `namespace IN (?, …)`;
  - `pod = ?`; `pod LIKE ? ESCAPE '\'` with `escape_like(prefix) + "%"`; `hostname = ?`; `rule IN (…)`;
  - text: `(message LIKE ?1 ESCAPE '\' OR command LIKE ?1 ESCAPE '\' OR rule LIKE ?1 ESCAPE '\' OR pod LIKE ?1 ESCAPE '\')` with `%escaped%`;
  - mutes (unless `include_muted`, only mutes whose `cluster_id` is `None` or equal): `NOT (rule = ? AND (? IS NULL OR namespace = ?))` each;
  - cursor: `(time < ? OR (time = ? AND id < ?))`; order `time DESC, id DESC`; `LIMIT limit + 1` to compute `next`.
- Summary: one `GROUP BY (time / ?) * ?, priority` query for buckets and totals, one for the top rules (`GROUP BY rule` with `COUNT(*)`, `MAX(priority)`, `MAX(time)`), one for the top pods (`WHERE pod IS NOT NULL GROUP BY namespace, pod`). `bucket_ms = 3_600_000` when `until − since ≤ 48 h`, else `21_600_000`; buckets are aligned to `since` rounded down to the bucket size and filled with zeros.
- `prune`: `DELETE FROM falco_events WHERE time < ?`, then for each cluster with more than the cap: `DELETE FROM falco_events WHERE cluster_id = ? AND (time, id) < (SELECT time, id FROM falco_events WHERE cluster_id = ? ORDER BY time DESC, id DESC LIMIT 1 OFFSET ?)` (row-value comparison, SQLite ≥ 3.15, bundled).
- `db.rs`: append `(N, falco::MIGRATION)` to `MIGRATIONS` (next free N); `PrunePolicy` gains `falco_before: i64` and `falco_max_per_cluster: u32`; `prune` calls `falco::prune` after events/changes and deletes Falco rows in the size-cap tier together with events and changes (oldest first, 10 % at a time, like events); `clear` maps `HistoryKind::Falco` → `["falco_events"]` and includes it in `All`; the status table listing includes `falco_events`.
- `writer.rs`: `WriteOp::Falco(Vec<FalcoEvent>)` → `falco::insert_events(&tx, &rows)`; `is_data` includes it.
- `history.rs` `policy()`: `falco_before = now − retention_days × DAY_MS` and `falco_max_per_cluster = max_events` from `Settings.falco` (clamped like `normalized`). `Retention` carries the Falco settings.
- `falco/mod.rs`: `falco_events` / `falco_summary` read through the history reader connection (the same accessor the change/event history queries use), normalising `limit` (0 → 200, ≤ 1000), and pass `settings().falco.mutes`. Without a history database (recording off), they return empty results.

Run: `cargo test -p kubepit-core history` → PASS (including the existing migration and prune tests, updated for the new policy fields).

- [ ] **Step 4: Commit**

```bash
git add crates/kubepit-core/src/history crates/kubepit-core/src/history.rs crates/kubepit-core/src/falco
git commit -m "feat(core): store Falco events in history.db with retention and a per-cluster cap"
```

---

### Task 4: Detection and status

**Files:**
- Create: `crates/kubepit-core/src/falco/detect.rs`, `crates/kubepit-core/tests/falco.rs`
- Modify: `crates/kubepit-core/src/falco/mod.rs`
- Test: `crates/kubepit-core/tests/falco.rs` (fake API server), unit tests for the pure pieces

**Interfaces:**
- Produces: `pub(crate) struct FalcoTarget { namespace, selector, container, pods: Vec<FalcoPod { name, node: Option<String>, ready: bool }>, nodes: u32, buffered: Option<bool>, image_tag: Option<String> }`; `pub(crate) async fn detect(client: &Client, config: &FalcoConfig, fallback: &[String]) -> Detection` with `enum Detection { Off, NotFound, Forbidden(String), Found(FalcoTarget), Error(String) }`; `fn status_of(cluster_id, &Detection, watching, now) -> FalcoStatus`; `Kubepit::falco_status(cluster_id, refresh)` returns the watcher's last status when one runs, otherwise detects once with `pool.connected_client` (disconnected → `state: error, error: "not connected"`).

- [ ] **Step 1: Integration tests**

In `tests/falco.rs` (`mod support;`), a router serving:
- `GET /api/v1/pods?labelSelector=app.kubernetes.io%2Fname%3Dfalco&limit=50` → two pods in `falco` with `spec.nodeName`, owner reference to DaemonSet `falco`, container `falco` with `tty: true` on one variant and missing on the other, image `falcosecurity/falco:0.41.3`, ready conditions.
- `GET /apis/apps/v1/namespaces/falco/daemonsets/falco` → `status.desiredNumberScheduled: 3`.
- A variant where the cluster-wide list is 403 and `GET /api/v1/namespaces/falco/pods?labelSelector=…` answers.
- A variant with pods mode (`namespace: sec`, `selector: app=runtime`, `container: engine`).

Tests: `detects_the_chart_install` (namespace `falco`, 2 pods, `nodes: 3`, `buffered: Some(false)` for tty true, version `0.41.3` from the image tag), `detection_falls_back_on_403` (finds `falco` through the fallback list; a 403 everywhere → `Forbidden`), `pods_mode_reads_only_its_namespace` (asserts no cluster-wide request), `nothing_found` (`NotFound`), `off_config_never_calls_the_server` (empty request log), and `status_without_connection_does_not_connect` (`falco_status` on a disconnected cluster returns an error status and the log has no `/version`).

- [ ] **Step 2: Run to see them fail**

Run: `cargo test -p kubepit-core --test falco`
Expected: FAIL.

- [ ] **Step 3: Implement `detect.rs`**

- Auto: `Api::<Pod>::all(client).list(&ListParams::default().labels(AUTO_SELECTOR).limit(50))`. On 403, list per namespace in `["falco", "falco-system", "kube-system", "security"]` plus the cluster's `accessible_namespaces` (deduplicated, stop at the first with pods). All 403 → `Forbidden(message)`. Namespace = the one with the most pods.
- Pods mode: only `Api::namespaced(client, ns).list(labels(selector))`.
- Container: the configured one (auto: `falco`), else the first container. `buffered = Some(!container.tty.unwrap_or(false))`. `image_tag` from the container image after the last `:` (ignoring digests).
- `nodes`: the owning DaemonSet's `status.desired_number_scheduled` (`get` may fail → pod count).
- `ready`: `Ready` condition `True`.
- `status_of` fills `FalcoStatus` (`pods`, `ready_pods`, `nodes`, `namespace`, `selector`, `container`, `version`, `buffered`, `state`, `checked_at`).

Run: `cargo test -p kubepit-core --test falco` → PASS.

- [ ] **Step 4: Commit**

```bash
git add crates/kubepit-core/src/falco crates/kubepit-core/tests/falco.rs
git commit -m "feat(core): detect Falco pods and report their status"
```

---

### Task 5: The watcher and RuntimeThreat alerts

**Files:**
- Create: `crates/kubepit-core/src/falco/watcher.rs`
- Modify: `crates/kubepit-core/src/falco/mod.rs`, `crates/kubepit-core/src/workload_logs.rs` (`pub(crate) async fn run_workload_logs`), `crates/kubepit-core/src/alerts/{detect.rs,book.rs}`
- Test: `crates/kubepit-core/tests/falco.rs`, unit tests in `alerts/book.rs`

**Interfaces:**
- Consumes: `parse_line`, `Bucket`, `backfill_since_secs`, `should_alert` (Task 2); `WriteOp::Falco`, `recent_ids`, `last_time` (Task 3); `detect`, `status_of` (Task 4); `run_workload_logs(stream_id, api, selector, options, sink)`, `split_timestamp`.
- Produces: `FalcoWatchers { app: Mutex<Option<Weak<Kubepit>>>, active: AtomicBool, tasks: TaskRegistry, statuses: Mutex<HashMap<String, FalcoStatus>> }` as `Kubepit.falco`; `Kubepit::set_falco_watching(self: &Arc<Self>, on: bool)`; `pub(crate) fn start_falco_watcher(&self, cluster_id)`, `stop_falco_watcher(&self, cluster_id)`, `sync_falco_watchers(&self)`; `Finding::runtime_threat(rule: &str, container: Option<&str>, message: &str, critical: bool) -> Finding` and `Finding.severity: Option<AlertSeverity>` (book: `finding.severity.unwrap_or_else(|| finding.reason.severity())`).

- [ ] **Step 1: Alert severity override (test first)**

In `alerts/book.rs` tests: `runtime_threat_findings_carry_their_severity` records `Finding::runtime_threat("Drop and execute new binary in container", Some("app"), "…", true)` and asserts `severity == Critical`, and a `false` one → `Warning`; two records of the same pod + rule within the cooldown merge (`count == 2`). Implement: `Finding` gets `pub(crate) severity: Option<AlertSeverity>` (`None` in the existing constructors), the book uses it, `runtime_threat` sets `reason: RuntimeThreat`, `condition: Some(rule)`, `container`, `message`.

- [ ] **Step 2: Watcher integration tests**

Extend the `tests/falco.rs` router with pod watches (`watch=true` → empty stream after the list) and logs for `falco-a` (node-a) and `falco-b` (node-b): `GET /api/v1/namespaces/falco/pods/falco-a/log` returns kubelet-timestamped lines — two JSON events (one `Critical` fresh, one `Warning` 20 minutes old), a banner line and a text `Notice` line; assert `container=falco`, `follow=true`, `timestamps=true` and record `sinceSeconds`. Enable history recording and alert monitoring for the app under test the way `tests/history.rs` and `tests/alerts.rs` do, opt the cluster in via `set_settings` (`falco.watch_clusters = [id]`), then `app.set_falco_watching(true)` and connect.

Tests:
1. `streams_parses_and_stores`: within 5 s, `falco_events` returns 3 events (2 JSON + 1 text) sorted newest first; `falco_status` has `state: found`, `watching: true`, `streaming: 2`, `format: json`, `version` from the banner; the recorder sink saw a `falco_events` batch.
2. `alerts_only_fresh_events_above_threshold`: `alerts_list` holds one `RuntimeThreat` alert (the fresh Critical, severity `critical`, condition = rule, object = the Pod); the 20-minute-old Warning and the Notice raise nothing.
3. `backfill_restores_without_duplicates_or_alerts`: disconnect, connect again → the second log request carries `sinceSeconds` ≥ 60 (derived from the last stored event), the store still has 3 events, no new alert.
4. `storm_is_bounded_and_reported`: a log response with 2 000 JSON lines stores ≤ 550 events and `falco_status.dropped ≥ 1 450`; the recorder saw batches of ≤ 200 events with `truncated: true` on the full ones.
5. `never_connects_and_stops_on_disconnect`: with the process flag on but the cluster not opted in, connecting makes no Falco request; opted in, `cluster_disconnect` stops the stream (no further log requests after the disconnect) and `falco_status` reports `watching: true` with `state: error` "not connected" until the next connect.
6. `not_found_redetects`: an empty pod list → `state: not-found`; after the router starts returning pods, the watcher finds them within its re-detect interval (make the interval a `pub(crate)` constant and use `tokio::time::pause`/`advance` or a short test override).
7. `mutes_suppress_alerts_not_storage`: mute the Critical rule for the namespace → it is stored, `include_muted: false` hides it, and no alert is raised.

- [ ] **Step 3: Run to see them fail**

Run: `cargo test -p kubepit-core --test falco`
Expected: FAIL.

- [ ] **Step 4: Implement the watcher**

```rust
// crates/kubepit-core/src/falco/watcher.rs (outline; the loop is the contract)
pub(crate) async fn run(app: Weak<Kubepit>, cluster_id: String) {
    let mut backoff = Duration::from_secs(5);
    loop {
        let Some(app) = app.upgrade() else { return };
        let Some(client) = app.pool.connected_client(&cluster_id) else {
            app.falco_set_status(&cluster_id, |s| { s.state = FalcoState::Error; s.error = Some("not connected".into()); });
            return;
        };
        let config = app.cluster_def(&cluster_id).map(|c| c.falco).unwrap_or_default();
        let detection = detect::detect(&client, &config, &app.fallback_namespaces(&cluster_id)).await;
        app.falco_publish_detection(&cluster_id, &detection);
        let Detection::Found(target) = detection else {
            drop(app);
            tokio::time::sleep(REDETECT_INTERVAL).await; // 60 s
            continue;
        };
        let outcome = stream(&app, &cluster_id, client, target).await; // returns when the log stream ends
        drop(app);
        match outcome {
            Ok(()) => backoff = Duration::from_secs(5),
            Err(_) => backoff = (backoff * 2).min(Duration::from_secs(60)),
        }
        tokio::time::sleep(backoff).await;
    }
}
```

`stream`:
- `since = backfill_since_secs(now, last_time(cluster), retention_days)`; `seen = recent_ids(cluster, now − since × 1000)` (an `LruSet` of at most 50 000 ids, oldest evicted); `status.backfill_since = now − since × 1000`.
- Build `WorkloadLogOptions { containers: vec![target.container], tail_lines: None, since_seconds: Some(since), timestamps: true, ..Default::default() }` and call `run_workload_logs(stream_id, Api::namespaced(client, &target.namespace), target.selector, options, sink)` inside the watcher task (not through `log_streams`), where `sink` sends each `WorkloadLogBatch` into a bounded `mpsc::channel(64)` (`try_send`; a full channel counts the batch's lines into `dropped`) and returns `true` while the receiver lives.
- The consumer loop, per `WorkloadLogEvent`:
  - `lines` → for each line: `split_timestamp` → `parse_line(&LineContext { cluster_id, kubelet_ms, node: pod_node(event.pod) })`. `Parsed::Version(v)` updates `status.version`; `Parsed::Event(e)` → skip if `seen` has the id; `bucket.take(now)` or count dropped; set `status.format` (JSON when `rule.is_some()` or the line started with `{`, else Text); push to `pending_store` and `pending_push`; if `should_alert(&e, &settings.falco, now)` → `app.alerts.raise(&*app.sink, cluster_id, object_of(&e), Finding::runtime_threat(rule_or_text_label, e.container.as_deref(), &e.message, e.priority >= FalcoPriority::Critical))`, where `object_of` is the Pod (`group: "", version: "v1", kind: "Pod"`) or, for host events, the Node named by `hostname`.
  - `source-added` / `source-removed` / `source-skipped` / `source-ended` → adjust `streaming` / `skipped`; `warning` → `status.error` (kept until the next successful line).
  - Every 500 ms (tokio `interval`) and on channel close: submit `WriteOp::Falco(pending_store.drain(..))` to the history writer (if present), push `FalcoEventBatch { cluster_id, events: first 200 of pending_push, truncated: len > 200 }` through `app.sink.falco_events`, clear `pending_push`, update `last_event_at`, and publish the status if it changed (`falco_set_status` compares with the stored copy and calls `sink.falco_status` only on change, with `checked_at` excluded from the comparison).
- `settings` are re-read from `app.settings()` at every flush so threshold and mute changes apply without a restart.

Lifecycle in `falco/mod.rs` (mirror `recommendations/schedule.rs:99-121` for the `Weak`):
- `set_falco_watching(self: &Arc<Self>, on)`: store `Arc::downgrade(self)`, set `active`, then `sync_falco_watchers()`; off → `tasks.stop_all()` and every status gets `watching: false`.
- `falco_wanted(id)`: active && `settings().falco.watches(id)` && `cluster_def(id).falco != Off` && `pool.connected_client(id).is_some()`.
- `start_falco_watcher(id)`: if wanted and no task `falco:{id}` runs, spawn `watcher::run(weak, id)` in `self.falco.tasks` tagged with the cluster.
- `stop_falco_watcher(id)`: stop the task; keep the last status with `watching` recomputed.
- `sync_falco_watchers()`: for every cluster, start when wanted and not running, stop when running and not wanted.

Run: `cargo test -p kubepit-core --test falco` → PASS; `cargo test --workspace` → PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/kubepit-core
git commit -m "feat(core): watch Falco pod logs in the background and raise runtime-threat alerts"
```

---

### Task 6: Wiring, commands and cleanup

**Files:**
- Modify: `crates/kubepit-core/src/{connection.rs,app.rs,cluster.rs}`, `crates/kubepit-core/src/falco/mod.rs`, `apps/desktop/src-tauri/src/setup.rs`
- Test: `crates/kubepit-core/tests/falco.rs`

**Interfaces:**
- Consumes: everything from Tasks 2–5.
- Produces: the watcher starts after connect (`connection.rs`, after `start_recommendation_scans(id)`), stops in `stop_cluster_work` (`self.stop_falco_watcher(id)`), `app.rs` `set_settings` calls `sync_falco_watchers()` after the other syncs, `Kubepit::shutdown` stops all Falco tasks, `cluster_update` restarts the cluster's watcher when `falco` changed, `cluster_remove` also clears `HistoryKind::Falco` for the cluster; `setup.rs` calls `core.set_falco_watching(true)` next to `set_recommendation_scans(true)`.

- [ ] **Step 1: Tests**

Add to `tests/falco.rs`: `settings_change_starts_and_stops_the_watcher` (opt in while connected → a log request appears; opt out → the task stops and no further requests arrive), `config_change_restarts_with_the_new_target` (switch to pods mode → the next pod list goes to the new namespace), `removal_clears_stored_events` (remove the cluster → `falco_events` for a re-added id is empty and the table has no rows for the old id).

- [ ] **Step 2: Run to see them fail, implement the hooks, run again**

Run: `cargo test -p kubepit-core --test falco` → FAIL, then implement the bullet list above, then PASS. Run the full `cargo test --workspace` and clippy.

- [ ] **Step 3: Commit**

```bash
git add crates/kubepit-core apps/desktop/src-tauri
git commit -m "feat(core): start Falco watchers with the cluster and clean them up"
```

---

### Task 7: Generic operator installer (Trivy moved onto it)

**Files:**
- Create: `apps/desktop/src/lib/kube/operators/{install.ts,specs.ts,index.ts,install.test.ts}`, `apps/desktop/src/components/workbench/security/{operatorInstall.ts,operatorInstall.test.ts,OperatorInstallCard.tsx}`
- Modify: `apps/desktop/src/lib/kube/trivy/install.ts` (+ test), `apps/desktop/src/components/workbench/security/{trivyInstall.ts,trivyInstall.test.ts,TrivyMissing.tsx}`

**Interfaces:**
- Produces:
  - `type OperatorId = 'trivy' | 'falco'`
  - `interface OperatorSpec { id; repoUrl; repoNames: readonly string[]; chart; release; namespace; valuesYaml: string; timeoutSecs; description; access: readonly AccessCheck[]; privilegedNamespace: boolean }`
  - `repoPlan(spec, repos): { name: string; add: boolean }` and `installRequest(spec, repoName): HelmInstallRequest` (pure)
  - `TRIVY_OPERATOR` in `specs.ts` (exactly today's values: repo names `aqua`/`aquasecurity`, then `aqua-N`; `values_yaml: ''`; timeout 600)
  - `type InstallStep = 'prepare' | 'repo' | 'install' | 'verify'`; `useOperatorInstallStore` keyed `${id}|${clusterId}`; `installOperator(spec, clusterId, verify: (clusterId) => Promise<void>)`; `operatorInstallState(id, clusterId)` selector hook
  - `OperatorInstallCard` props: `{ clusterId, spec, verify, title, description, footnote, guideUrl, manualCommands, stepLabels: Record<InstallStep, string>, confirmMessage }`
  - `trivyInstall.ts` keeps `installTrivy(clusterId)`, `trivyOperatorKey`, and `useTrivyInstallState(clusterId)` as wrappers.

- [ ] **Step 1: Move the pure tests and add the generic ones**

`lib/kube/operators/install.test.ts`: the existing `trivyRepoPlan` / `trivyInstallRequest` cases rewritten against `repoPlan(TRIVY_OPERATOR, …)` / `installRequest(TRIVY_OPERATOR, …)` with identical expectations, plus a spec with `repoNames: ['x']` falling back to `x-2`, `x-3`. Keep `lib/kube/trivy/install.test.ts` passing through the wrappers (`trivyRepoPlan = (repos) => repoPlan(TRIVY_OPERATOR, repos)`).

`security/operatorInstall.test.ts`: port every case of `trivyInstall.test.ts` to `installOperator(TRIVY_OPERATOR, 'c1', verifyTrivy)` (same mocks), plus:
- a spec with `privilegedNamespace: true` runs `prepare` first (Task 8 fills it; here a spec-provided `prepare` callback is called once, and a failure there stops before `helm repo list`);
- a failed `verify` retries only `verify`;
- two operators on the same cluster have independent states.

- [ ] **Step 2: Run to see them fail**

Run: `pnpm test:ui -- operators operatorInstall`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `operators/install.ts`: generalise `lib/kube/trivy/install.ts` (same `sameUrl`, the free-name loop over `spec.repoNames` then `${repoNames[0]}-N`; `installRequest` = today's Trivy request with `spec` values and `values_yaml: spec.valuesYaml`).
- `operatorInstall.ts`: today's `trivyInstall.ts` flow with the step list `['prepare'?, 'repo', 'install', 'verify']`, the store keyed by `${spec.id}|${clusterId}`, `prepare` taken from an optional `options.prepare(clusterId)`, and `verify` passed in. Retry: a failed `verify` resumes at `verify`; anything else starts over at the first step. Success toast text comes from the caller (`options.successMessage`).
- `trivyInstall.ts`: `verifyTrivy` = today's `discover` + `publishDiscovery` (or the shared `rediscover` helper if it exists); `installTrivy(clusterId)` = `installOperator(TRIVY_OPERATOR, clusterId, { verify: verifyTrivy, successMessage: … })`.
- `OperatorInstallCard.tsx`: the body of `TrivyMissing.tsx` (icon, title, description, primary install/retry button, guide button, helm-missing buttons, hint line, `Steps`, failure box, manual commands) parameterised by the props above. The production confirm keeps the typed release name and the "This is a production cluster." suffix.
- `TrivyMissing.tsx` renders `OperatorInstallCard` with today's Trivy texts (both variants, `crdsServed` included). No visible change.

Run: `pnpm typecheck && pnpm test:ui && pnpm i18n:check` → PASS. In `pnpm dev:ui`, repeat the Trivy install on `kind-kubepit` and the production confirm (mark it production via the store as in the Trivy session) → identical behaviour.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src
git commit -m "refactor(ui): generic operator installer, with Trivy on it"
```

---

### Task 8: One-click Falco install

**Files:**
- Modify: `apps/desktop/src/lib/kube/operators/specs.ts` (+ test), `apps/desktop/src/components/workbench/security/runtime/FalcoMissing.tsx`, `apps/desktop/src/lib/ipc/mock/{helmCharts.ts,fixtures/charts.ts}`, i18n catalogs
- Test: `apps/desktop/src/lib/kube/operators/install.test.ts`, `apps/desktop/src/components/workbench/security/operatorInstall.test.ts`

**Interfaces:**
- Consumes: `OperatorInstallCard`, `installOperator` (Task 7); `ipc.resourceGet`, `ipc.resourceApplyYaml`, `ipc.falcoStatus`, `ipc.settingsGet/settingsSet`.
- Produces: `FALCO_OPERATOR` (`repoUrl: 'https://falcosecurity.github.io/charts'`, `repoNames: ['falcosecurity']`, chart `falco`, release `falco`, namespace `falco`, `timeoutSecs: 900`, `privilegedNamespace: true`, access checks `create namespaces`, `create daemonsets.apps` in `falco`, `create serviceaccounts` in `falco`), `FALCO_VALUES_YAML`, `falcoNamespaceYaml()`, `prepareFalcoNamespace(clusterId)`, `verifyFalco(clusterId)`, `installFalco(clusterId)`; the real `FalcoMissing`.

- [ ] **Step 1: Tests**

- `install.test.ts`: `FALCO_VALUES_YAML` parses (with the `yaml` package) to `{ tty: true, driver: { kind: 'auto' }, falco: { json_output: true, json_include_output_property: true, json_include_message_property: true, json_include_tags_property: true, json_include_output_fields_property: true } }`; `installRequest(FALCO_OPERATOR, 'falcosecurity')` has `chart_ref: 'falcosecurity/falco'`, `wait`, `atomic`, `create_namespace: true`, `timeout_secs: 900`; `falcoNamespaceYaml()` is a `Namespace` named `falco` with label `pod-security.kubernetes.io/enforce: privileged`.
- `operatorInstall.test.ts` (Falco):
  - namespace missing (`resourceGet` rejects with a NotFound message) → `resourceApplyYaml(clusterId, falcoNamespaceYaml(), 'apply', null)` then repo and install;
  - namespace present without enforce label or with `privileged` → no apply;
  - present with `enforce: baseline` → fails at `prepare` with an error naming the namespace and level, no helm call;
  - `verify` polls `falcoStatus(clusterId, true)` until `state === 'found'` (at most 10 × 3 s, fake timers), then adds the cluster to `settings.falco.watch_clusters` through `settingsSet` (keeping every other setting);
  - `verify` on a disconnected cluster finishes without polling.

- [ ] **Step 2: Run to see them fail, then implement**

Values (keep this literal; check the key names against `helm show values falcosecurity/falco` for the current chart major before merging and note the chart version in a comment):

```ts
/** Falco chart values for the one-click install (chart 9.x; spec D13). */
export const FALCO_VALUES_YAML = `# Written by Kubepit's one-click install.
tty: true
driver:
  kind: auto
falco:
  json_output: true
  json_include_output_property: true
  json_include_message_property: true
  json_include_tags_property: true
  json_include_output_fields_property: true
`;
```

`FalcoMissing.tsx` renders `OperatorInstallCard` with:
- title "Falco is not running on this cluster";
- description: what Falco detects (shells in containers, sensitive file reads, dropped binaries, container escapes) and that Kubepit reads its events from the pod logs;
- footnote: "Installs falcosecurity/falco into falco as a privileged DaemonSet on every node (eBPF driver) and creates the namespace with the privileged Pod Security level.";
- step labels: Prepare the falco namespace · Prepare the falcosecurity Helm repository · Install the falco chart into falco · Wait for Falco on the nodes;
- confirm message: "Install the falco chart as "falco" into falco on {cluster}? It runs a privileged DaemonSet on every node.";
- guide URL `https://falco.org/docs/setup/kubernetes/`;
- manual commands: the three commands of the chart README plus the four `--set` flags.

Mock: add `{ name: 'falcosecurity', url: 'https://falcosecurity.github.io/charts', org: 'The Falco Authors' }` to `KNOWN_REPOS` and a `chart({ repo: 'falcosecurity', chart: 'falco', title: 'Falco', description: 'Falco', latest: '9.2.0', app: '0.41.3', keywords: ['falco', 'security', 'runtime', 'ebpf'], home: 'https://falco.org', source: 'https://github.com/falcosecurity/charts', image: 'falcosecurity/falco', port: 8765, workload: 'DaemonSet' })`. `installOperators` gains a Falco branch that calls `installMockFalco(db)` from Task 14 (a no-op stub until then).

Run: `pnpm typecheck && pnpm test:ui && pnpm i18n:check` → PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src
git commit -m "feat(ui): one-click Falco install from the Security view"
```

---

### Task 9: Falco helpers (pure TS)

**Files:**
- Create: `apps/desktop/src/lib/kube/falco/{priority.ts,model.ts,index.ts,priority.test.ts,model.test.ts}`

**Interfaces:**
- Produces:
  - `FALCO_PRIORITIES` (lowest first), `priorityRank(p)`, `atLeast(p, min)`, `priorityGroup(p): keyof FalcoCounts`, `priorityName(p)` (translated, `@/i18n/core`), `PRIORITY_TONE: Record<keyof FalcoCounts, { text: string; fill: string }>` (critical → `text-status-error`/`bg-status-error`, error → `text-tone-critical-fg`/`bg-tone-critical`, warning → `text-tone-warning-fg`/`bg-tone-warning`, notice → `text-tone-info-fg`/`bg-tone-info`, info → `text-fg-dim`/`bg-fg/30`)
  - `RANGES = { '1h': 3_600_000, '24h': 86_400_000, '7d': 604_800_000 } as const`, `type RuntimeRange = keyof typeof RANGES`
  - `interface RuntimeFilters { range; minPriority: FalcoPriority | null; showMuted: boolean; text: string; namespace: string | null; pod: string | null; hostname: string | null; rule: string | null }`
  - `queryFor(filters, namespaces: string[], now, before?): FalcoQuery`, `summaryQueryFor(filters, namespaces, now): FalcoSummaryQuery`
  - `matchesFilters(event, filters, namespaces, mutes, clusterId, now): boolean` (the live-merge twin of the SQL filters)
  - `mergeLive(page: FalcoEvent[], live: FalcoEvent[], limit): FalcoEvent[]` (dedupe by id, newest first)
  - `isMuted(event, mutes, clusterId)`, `withMute(mutes, mute)`, `withoutMute(mutes, mute)`
  - `eventTarget(event): { kind: 'Pod' | 'Node'; namespace: string | null; name: string } | null`
  - `histogramBars(summary, width, height): Array<{ x; w; segments: Array<{ group; y; h }> }>`
  - `mitreTechniques(tags): string[]` (tags matching `^T\d{4}(\.\d{3})?$`)

- [ ] **Step 1: Tests**

`priority.test.ts`: order and `atLeast`; `priorityGroup('alert') === 'critical'`, `priorityGroup('debug') === 'info'`; `priorityName` returns a non-empty string for every priority.

`model.test.ts`:
- `queryFor` for 24 h: `since = now − 86_400_000`, `min_priority`, `namespaces` from the selector, `text` trimmed (empty → null), `include_muted`, `limit: 200`, the `before` cursor passed through.
- `matchesFilters` agrees with the query semantics on a table of events (priority, namespace scoping with host events visible only for all namespaces, pod, hostname, rule, text over message/command/rule/pod case-insensitively, mutes, range).
- `mergeLive` keeps the page order, prepends new live events, drops duplicates, caps at `limit`.
- `withMute`/`withoutMute` are idempotent; `isMuted` handles global, cluster and namespace mutes.
- `eventTarget`: pod event → Pod; host event with hostname → Node; neither → null.
- `histogramBars`: 24 buckets over width 480 → 24 bars of equal width with a 1 px gap; segment heights proportional to the tallest bucket; an all-zero summary yields zero-height segments; stacking order critical at the top.
- `mitreTechniques(['mitre_execution', 'T1059', 'T1552.001', 'x'])` → `['T1059', 'T1552.001']`.

- [ ] **Step 2: Run to see them fail, implement, run again**

Run: `pnpm test:ui -- lib/kube/falco` → FAIL, implement, → PASS. `pnpm i18n:check -- --fix` and Turkish for the priority names (`Kritik`, `Hata`, `Uyarı`, `Bildirim`, `Bilgi`, `Hata ayıklama`, `Alarm`, `Acil durum`).

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/lib/kube/falco apps/desktop/src/i18n
git commit -m "feat(ui): Falco priority and filter helpers"
```

---

### Task 10: Live store and data hooks

**Files:**
- Create: `apps/desktop/src/store/useFalcoStore.ts` (+ `.test.ts`), `apps/desktop/src/components/workbench/security/runtime/{useFalco.ts,falcoSettings.ts}`

**Interfaces:**
- Produces:
  - `useFalcoStore`: `{ statuses: Record<ClusterId, FalcoStatus>; live: Record<ClusterId, FalcoEvent[]> (newest first, ≤ 500); refetch: Record<ClusterId, number> (bumped on `truncated`); ingest(batch); setStatus(status) }` and `ensureFalcoSubscription()` (subscribes `events.onFalcoEvents` / `events.onFalcoStatus` once per window; idempotent)
  - `useFalcoStatus(clusterId, enabled)`: `usePolled('${clusterId}|falco-status', () => ipc.falcoStatus(clusterId), 30_000, enabled)` merged with the pushed status (newest `checked_at` wins)
  - `useFalcoSummary(clusterId, query, enabled)`: `usePolled` keyed by the JSON of the query rounded to the minute, 60 s interval, refreshed when `refetch[clusterId]` changes or a live batch arrives (throttled to one refresh per 5 s)
  - `useFalcoEvents(clusterId, query, enabled)`: first page via `ipc.falcoEvents`, `loadMore()` with the cursor, live events merged with `mergeLive` + `matchesFilters`, `refetch` resets to the first page
  - `falcoSettings.ts`: `saveFalcoSettings(change: (s: FalcoSettings) => FalcoSettings)` (like `updateAlertSettings`: read current, `settingsSet`, `setSettings`, error toast), `setWatching(clusterId, on)`, `muteRule(mute)`, `unmuteRule(mute)`

- [ ] **Step 1: Tests** (`useFalcoStore.test.ts`, mocking `@/lib/ipc`)

`ingest` caps at 500 and dedupes by id; `truncated` bumps `refetch`; `setStatus` ignores an older `checked_at`; `ensureFalcoSubscription` subscribes exactly once; `saveFalcoSettings` preserves every other settings field and toasts on failure.

- [ ] **Step 2: Run to see them fail, implement, run again, commit**

Run: `pnpm test:ui -- useFalcoStore` → FAIL → implement → PASS.

```bash
git add apps/desktop/src/store apps/desktop/src/components/workbench/security/runtime
git commit -m "feat(ui): live Falco event store and data hooks"
```

---

### Task 11: The Runtime threats tab

**Files:**
- Create: `apps/desktop/src/components/workbench/security/runtime/{FalcoWatchCard,RuntimeOverview,RuntimeHistogram,RuntimeTopLists,RuntimeEventList,RuntimeEventDrawer,RuntimeSettingsDialog,priority}.tsx`
- Modify: `apps/desktop/src/components/workbench/security/runtime/RuntimeTab.tsx`, `apps/desktop/src/components/workbench/security/SecurityPage.tsx` (footer text for `runtime`), i18n catalogs

**Interfaces:**
- Consumes: Tasks 8–10 and `securityTabs.ts`.
- Produces: `RuntimeTab({ clusterId, namespaces, isActive, query })`.

- [ ] **Step 1: `RuntimeTab` state machine**

`ensureFalcoSubscription()` on mount. `status = useFalcoStatus(clusterId, isActive)`. Render:
- no status yet → the spinner row used by `SecurityPage` ("Looking for Falco…");
- `not-found` → `<FalcoMissing clusterId />`;
- `forbidden` → a card: "Kubepit can't list pods to find Falco" + the status error + *Open cluster settings* (`useAppStore.getState().openClusterEditor(...)` — use whatever `WorkbenchHeader`'s edit button calls);
- `off` → one muted line + the same link;
- `error` and not watching → the error with *Retry* (`ipc.falcoStatus(clusterId, true)`);
- `found` and not watching → `<FalcoWatchCard status />`;
- watching (any state) → `<RuntimeOverview status … />` (it shows `error` as a notice).

- [ ] **Step 2: `FalcoWatchCard`**

Same shell as `OperatorInstallCard` (icon, title, text, primary button). Text: `i18n.plural('Falco runs on {count} node in {namespace}.', 'Falco runs on {count} nodes in {namespace}.', status.nodes, …)` + "Kubepit can read its events from the pod logs while this cluster is connected, and keep {days} days of them on this machine. Nothing is changed in the cluster." Button *Watch Falco events* → `setWatching(clusterId, true)`. Read-only clusters may watch (it is read-only).

- [ ] **Step 3: `RuntimeOverview`**

- Filters live in component state initialised from `useSecurityTabs.focus[clusterId]` (then `setRuntimeFocus(clusterId, undefined)`), the `query` prop feeds `text` (debounced 250 ms), `namespaces` scope everything.
- Toolbar (a row like the Trivy tab's second strip): range radiogroup (1 h · 24 h · 7 d, same button style as the Security tabs), a `Select` for the minimum priority (All · Notice+ · Warning+ · Error+ · Critical+), a *Show muted* `Switch`, active focus chips (pod/rule/host with ×), and an `IconButton` (Settings2) opening `RuntimeSettingsDialog`.
- Notices strip (tone-warning like the Trivy error banner), each only when true: `buffered` → "Falco's output is buffered (tty: false), so events can arrive minutes late. Set tty: true in its Helm values."; `format === 'text'` → "Falco prints plain text, so rule names are missing. Set falco.json_output: true for full details."; `skipped > 0` → `i18n.t('Streaming {streaming} of {total} Falco pods (Kubepit follows at most 64).', …)`; `dropped > 0` → `i18n.plural('{count} event was not stored during a burst.', '{count} events were not stored during a burst.', …)`; `error` → the error. A dim line shows `i18n.t('Events since {time}', { time })` from `backfill_since` when the range starts before it.
- `SeverityTiles`-style tiles for `FalcoCounts` (reuse the tile markup of `TrivyOverview` `SeverityTiles`; clicking a tile sets `minPriority` to that group's lowest priority).
- `RuntimeHistogram`: `<svg viewBox="0 0 {w} {h}" role="img" aria-label=…>` from `histogramBars`, measured with a `ResizeObserver` on the container; `fill` classes from `PRIORITY_TONE`; a hover tooltip (`GlobalTooltip` pattern) with the bucket time and counts; x-axis labels at 4–6 ticks (`formatTime` helpers already used by metrics charts).
- `RuntimeTopLists`: two cards (grid `@2xl:grid-cols-2`) using `ListHeader`-style headers. Rules: rule (or "(text output)"), count, highest priority chip, last seen (relative), mute/unmute icon button (`muteRule({ cluster_id: clusterId, rule, namespace: null })`), click → `rule` filter. Pods: `namespace/pod`, count, chip, last seen; click → `pod` filter; an icon opens the pod (`openObject(clusterId, 'Pod', namespace, pod)`).
- `RuntimeEventList`: rows with time (HH:mm:ss, date on day change), a priority chip (`priority.tsx`: dot + translated name), rule, `namespace/pod · container` or the node for host events, command (monospace, truncated), node; muted rows at 50 % opacity when *Show muted* is on; newly arrived rows fade in with `animate-breathe` once; *Load more* at the bottom when `next`; an empty state per filter ("No runtime threats in this range." / "Nothing matches these filters."). Keyboard: ↑/↓ moves the selection, Enter opens the drawer.
- `RuntimeEventDrawer` (`Drawer`, right): header (priority chip, rule, time), message (pre-wrap), a definition list (node, namespace, pod, container, image, command, user, source), tags (MITRE technique tags link to `https://attack.mitre.org/techniques/{T…}/` with `.` → `/`), all output fields in a two-column monospace table, actions: open pod / node (via `eventTarget`), *Mute this rule* (cluster) and *Mute in {namespace}*, *Copy as JSON* (`copyText(JSON.stringify(event, null, 2))`).
- Footer text in `SecurityPage` for `runtime`: `i18n.plural('{count} event', '{count} events', totals)` + `· ` + `i18n.plural('{count} node', '{count} nodes', status.nodes)`; the live dot reflects `status.watching && status.state === 'found'`.

- [ ] **Step 4: `RuntimeSettingsDialog`**

`Dialog` with a draft of `Settings.falco` and explicit Save (the `useSettingsDraft` pattern): alert threshold `Select` (Notice · Warning · Error · Critical), retention days (1–90), event cap (1 000–500 000), the mute list with unmute buttons (showing cluster name or "All clusters" and the namespace), *Stop watching this cluster* (secondary), *Clear stored events of this cluster* (danger; `ConfirmDialog` then `ipc.historyClear('falco', clusterId)` and a refetch). Validation mirrors `FalcoSettings::normalized`.

- [ ] **Step 5: Verify**

`pnpm typecheck && pnpm test:ui && pnpm i18n:check` → PASS (with Turkish). In `pnpm dev:ui` (after Task 14 the demo has data; before it, check the empty and not-found states): every state renders, filters change the list and the summary, the drawer opens from mouse and keyboard, muting hides the rule and unmuting restores it, the settings dialog saves, English and Turkish, narrow and wide containers.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src
git commit -m "feat(ui): Security runtime threats tab"
```

---

### Task 12: Runtime threats in object details

**Files:**
- Create: `apps/desktop/src/components/workbench/security/ObjectRuntime.tsx`
- Modify: `apps/desktop/src/components/workbench/details/DetailsOverview.tsx`
- Test: `apps/desktop/src/components/workbench/security/objectRuntime.test.ts` (pure target mapping)

**Interfaces:**
- Produces: `runtimeTargetOf(obj): { pod?: string; podPrefix?: string; hostname?: string; namespace: string | null; approximate: boolean } | null` (pure: Pod → exact pod; Deployment/StatefulSet/DaemonSet/ReplicaSet/Job → `podPrefix: name + '-'`, `approximate: true`; CronJob → prefix of its name; Node → hostname; everything else → null) and `ObjectRuntime(props: SectionProps)`.

- [ ] **Step 1: Test the mapping, then implement**

`objectRuntime.test.ts` covers each kind above. `ObjectRuntime` renders only when `useFalcoStore.statuses[ctx.clusterId]?.watching` (poll `useFalcoStatus` with `isActive`), queries the last 24 h with `limit: 5` and `min_priority: null`, and shows a `<Section title={i18n.t('Runtime threats')}>` with up to five compact rows (priority chip, rule, time, container) — or "No runtime threats in the last 24 hours." — plus *Open in Security* (`setSecurityTab(clusterId, 'runtime')`, `setRuntimeFocus(clusterId, { pod | hostname, namespace, rule: null })`, `setActiveKind(clusterId, VIEW.security)`). Approximate targets show "Matched by pod name prefix." in dim text. In `DetailsOverview.tsx`, render it after `ObjectSecurity` inside its own `DeferredSection` when `runtimeTargetOf(obj)` is non-null.

- [ ] **Step 2: Verify and commit**

`pnpm typecheck && pnpm test:ui && pnpm i18n:check` → PASS.

```bash
git add apps/desktop/src
git commit -m "feat(ui): runtime threats in pod, workload and node details"
```

---

### Task 13: Alerts click-through, notification settings and the cluster editor

**Files:**
- Create: `apps/desktop/src/components/cluster-editor/FalcoFields.tsx`
- Modify: `apps/desktop/src/lib/alerts/actions.ts`, `apps/desktop/src/components/settings/NotificationsCategory.tsx` (only if the reason list needs a hint), `apps/desktop/src/components/cluster-editor/ClusterEditor.tsx`, i18n catalogs
- Test: `apps/desktop/src/lib/alerts/actions.test.ts` (create or extend), `apps/desktop/src/components/cluster-editor/falcoFields.test.ts` (pure draft ↔ config)

**Interfaces:**
- Produces: `openAlert` for `RuntimeThreat` → `setSecurityTab(cluster, 'runtime')`, `setRuntimeFocus(cluster, { namespace, pod: kind === 'Pod' ? name : null, hostname: kind === 'Node' ? name : null, rule: alert.condition })`, `setActiveKind(cluster, VIEW_KEYS.security)`, `openAndConnect(cluster)`; `falcoDraft(config)` / `falcoConfig(draft)` (pure, like `lokiDraft` / `lokiConfig`).

- [ ] **Step 1: Tests**

`actions.test.ts`: a `RuntimeThreat` alert on a Pod sets the tab, the focus (pod + rule) and the active view, and marks it read; other reasons still call `openObject`. `falcoFields.test.ts`: round trips for the three modes; pods mode requires a namespace and a selector; an empty container becomes `falco`.

- [ ] **Step 2: Implement**

`FalcoFields` follows `LokiFields.tsx`: a three-way `Choice` (Auto · Pods in a namespace · Off), with namespace, label selector and container inputs for pods mode, and a hint for auto ("Finds pods labelled app.kubernetes.io/name=falco in any namespace."). Wire it into `ClusterEditor.tsx` next to the Loki fields (state, validation, `saveCluster({ …, falco })`). In the Notifications settings, the new reason appears automatically from `ALERT_REASONS`; add a one-line hint under it pointing to the Runtime tab's settings for the priority threshold if the reason list supports per-reason hints.

Run: `pnpm typecheck && pnpm test:ui && pnpm i18n:check` → PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src
git commit -m "feat(ui): open runtime-threat alerts in Security and configure Falco per cluster"
```

---

### Task 14: Demo backend

**Files:**
- Create: `apps/desktop/src/lib/ipc/mock/fixtures/falco.ts`
- Modify: `apps/desktop/src/lib/ipc/mock/{falco.ts,helmCharts.ts,alerts.ts,history.ts,app.ts}`, `apps/desktop/src/lib/ipc/mock/fixtures/build.ts`
- Test: `apps/desktop/src/lib/ipc/mock/falco.test.ts`

**Interfaces:**
- Produces: `FALCO_CLUSTERS = new Set(['c-prod-eu', 'c-staging'])`, `hasFalco(db)`, `buildFalco(db)` (a `falco` namespace, a DaemonSet `falco` and one pod per node labelled `app.kubernetes.io/name=falco` with container `falco`, `tty: true`), `installMockFalco(db)` (adds the cluster, builds the objects, starts generating), a deterministic event generator from the demo pods, an in-memory store per cluster seeded with 7 days of history, and real handlers for `falco_status`, `falco_events`, `falco_summary`.

- [ ] **Step 1: Tests** (`mock/falco.test.ts`)

The seed is deterministic (same cluster → same first 20 events); every seeded event refers to an existing demo pod or node; `falco_events` honours every `FalcoQuery` field and pages with the cursor; `falco_summary` totals equal the number of matching events; mutes from settings hide events unless `include_muted`; a cluster without Falco reports `not-found`; after `installMockFalco`, the status is `found` and `watching` follows `settings.falco.watch_clusters`.

- [ ] **Step 2: Implement**

- Rule catalog: the 25 stable rules of `falcosecurity/rules` (name, priority, tags, message template), e.g. `Terminal shell in container` (notice), `Read sensitive file untrusted` (warning), `Drop and execute new binary in container` (critical), `Contact K8S API Server From Container` (notice), `Detect release_agent File Container Escapes` (critical), `Search Private Keys or Passwords` (warning), `Clear Log Activities` (warning), `Fileless execution via memfd_create` (critical). Output fields: `container.id`, `container.name`, `container.image.repository`, `container.image.tag`, `k8s.ns.name`, `k8s.pod.name`, `proc.cmdline`, `proc.name`, `proc.pname`, `user.name`, `fd.name` when relevant.
- Seed: about 40 events per day per cluster over 7 days with two bursts (one noisy `Terminal shell in container` hour and a critical incident on one `payments` pod), times from a seeded PRNG (`hashString` in `fixtures/util`).
- Live: when the cluster is connected and watched, a timer every 6–20 s appends 1–3 events, emits `falco://events` through `mockEmitAllWindows`, and records a `RuntimeThreat` alert through `mock/alerts.ts` `record` for events at or above the threshold that are not muted (with the book-like cooldown the mock already applies).
- Status: `state: 'found'`, namespace `falco`, `pods = nodes = ` demo node count, `streaming = pods`, `format: 'json'`, `version: '0.41.3'`, `buffered: false`, `backfill_since` = connect time − 1 h.
- `mock/history.ts`: `history_clear` with `falco` empties the store (one cluster or all).
- `helmCharts.ts` `installOperators`: the Falco branch calls `installMockFalco(db)` (skip scale presets like Trivy).
- `fixtures/build.ts`: call `buildFalco(db)` after `buildSecurityDemo(db)`.
- `mock/app.ts`: default `settings.falco.watch_clusters = ['c-prod-eu']` so the demo opens with data on one cluster and the watch card on the other.

Run: `pnpm test:ui -- mock/falco` → PASS; `pnpm dev:ui`: prod-eu shows live events, staging shows the watch card, kind shows the install card and installing Falco there leads to live events.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/lib/ipc/mock
git commit -m "feat(mock): Falco demo data, live events and install"
```

---

### Task 15: Docs, verification and manual smoke

**Files:**
- Modify: `docs/ARCHITECTURE.md` (a "Runtime threats (Falco)" subsection in the Security section, the `falco_events` row in the persistence table, the demo paragraph), `README.md` (feature bullet), `docs/superpowers/plans/README.md` (mark done when finished)

- [ ] **Step 1: Write the docs** (decisions D1–D15 condensed; data flow diagram from spec §5; limits; what is stored where and how to clear it).

- [ ] **Step 2: Full checks**

Run: `pnpm typecheck && pnpm i18n:check && pnpm test:ui && cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace && pnpm --filter @kubepit/desktop build`
Expected: all pass.

- [ ] **Step 3: Manual smoke in `pnpm dev:ui` (English, then Turkish)**

1. `kind-kubepit` → Security ▸ Runtime threats → *Install Falco* → steps run → live events appear → a critical event raises an OS/toast notification → clicking it opens the tab focused on the pod and rule.
2. Mark a cluster production (store) → the install asks for `falco`; mark it read-only → the button is blocked with the reason.
3. prod-eu: filters, histogram hover, top lists, drawer (keyboard too), mute → hidden and no alert, *Show muted* → visible, unmute.
4. Pod, Deployment and Node details show the section; *Open in Security* focuses the tab.
5. Cluster editor: pods mode and off; off hides the tab content with the link.
6. Runtime settings: threshold, retention, clear stored events for one cluster.
7. Narrow window: toolbar wraps, lists stack, no horizontal scroll.

- [ ] **Step 4: Commit**

```bash
git add docs README.md
git commit -m "docs: Falco runtime threats"
```

---

### Task 16 (phase 2, optional): Search older events in Loki

**Files:** `crates/kubepit-core/src/falco/loki.rs` (create), `falco/mod.rs`, `apps/desktop/src-tauri/src/ipc/falco.rs`, `audit_coverage.rs`, `types/index.ts`, `lib/ipc.ts`, `mock/falco.ts`, `runtime/RuntimeEventList.tsx`.

- Command `falco_loki_search(cluster_id, query: FalcoQuery) -> FalcoEventPage` (read-only): when `loki_status` is available and the range starts before `backfill_since` or the oldest stored event, run `{namespace="<falco ns>", container="<falco container>"}` (plus `|= "<text>"` when set) through `loki_query_range` with `direction: backward`, parse each line with `parse_line` (Loki's timestamp as `kubelet_ms`), apply the same filters in Rust, and return events not already in the store. Nothing is stored.
- UI: at the end of the list, when the range reaches before the stored history and Loki is available, a *Search older events in Loki* row appends the results, marked "from Loki".
- Tests: fake API server with a Loki service proxy answer (reuse the Loki test fixtures), filters, dedupe against stored ids; mock handler; Vitest for the merge.

### Task 17 (phase 2, optional): Falcosidekick PolicyReports

**Files:** `crates/kubepit-core/src/falco/policy_reports.rs` (create), `falco/watcher.rs`, tests.

- When discovery serves `policyreports.wgpolicyk8s.io` and reports labelled `app.kubernetes.io/managed-by=falcosidekick` exist (`falco-policy-report` per namespace, `falco-cluster-policy-report`), the watcher also watches them and ingests results as events: `rule` = result `rule`, `priority` from `severity` (`critical` → critical, `high` → error, `medium` → warning, `low` → notice, `info` → informational), `message` = `description`, `fields` = `properties`, `time` = `timestamp`, `namespace` = report namespace, `pod` = `properties["k8s.pod.name"]`, id = `parse::event_id(None, timestamp, hostname, rule, description)` so log- and report-sourced copies dedupe when both exist.
- Useful for clusters beyond the 64-source cap. Kubepit never installs the CRDs (spec D3).
- Tests: fake API server with the CRD in discovery and one namespaced and one cluster report; dedupe with the same event from logs; the status shows the extra source.
