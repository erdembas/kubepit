# AI Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An opt-in, local-first AI assistant that explains failing workloads, suggests fixes through the existing dry-run review, translates natural language to kubectl/PromQL/LogQL, helps write schema-valid YAML and chats with read-only tool access — without any byte leaving the machine unpreviewed or unredacted.

**Architecture:** A new `ai` module in `crates/kubepit-core` owns keys (OS keychain via `SecretStore`), redaction, budgeting, prompt rendering, three providers behind one `Provider` trait (Anthropic Messages API, OpenAI-compatible, Ollama), the read-only tool loop and the audit log (`history.db` migration 2). The React UI gathers context from existing libraries (`lib/logs`, health store, change timeline, alerts, `lib/kube/schema`), shows the backend-rendered preview, streams answers over a typed `Channel<AiEvent>` and hands suggestions to existing flows (create editor review, PromQL tab, Loki tab, clipboard).

**Tech Stack:** Rust 1.89 (tokio, reqwest 0.13 rustls, serde_json, regex, rusqlite, keyring through `SecretStore`), Tauri 2 IPC, React 18 + Zustand + Tailwind v4, Vitest (new dev dependency) for pure TS.

**Spec:** `docs/superpowers/specs/2026-09-28-ai-assistant-design.md`

## Completion record — 2026-09-29

Implementation resumed from the interrupted assistant session and completed across the Rust
session engine, Tauri IPC, assistant panel, provider/privacy settings, request history,
workload/query/editor entry points, and English/Turkish catalogs. The original task steps
below remain as the design and implementation recipe, rather than a historical test-run log.

Validation covers the full Rust workspace and frontend suites, strict Clippy, formatting,
typechecking, catalog checks, production frontend and macOS app builds, the complete native
main window and Assistant settings, and demo flows for preview, tool consent, streamed
answers, YAML handoff and switching language during a response. The live-provider evaluator
is implemented but was intentionally not run; automated tests use synthetic data and local
fake providers and do not connect to real clusters.

## Global Constraints

- IPC contract: every new command or shape changes `apps/desktop/src/types/index.ts`, `apps/desktop/src/lib/ipc.ts`, the serde types in `crates/kubepit-core` and `apps/desktop/src-tauri/src/ipc/ai.rs` in the same commit. Serde fields are snake_case, JS arguments camelCase, errors cross as `Err(String)` through `ipc_err`, and streams use a `tauri::ipc::Channel<AiEvent>` parameter named `on_event`.
- RunHQ design: use the tokens in `src/styles/theme.css` and the primitives in `src/components/ui/`, with 11–13 px UI text, uppercase tracked labels, `bg-fg/N` hover pads and the accent strip for the active rail item. Do not add chart or UI libraries; the budget bar is SVG with tokens.
- i18n: every user-visible string ships in EN and TR in the same commit.
  - Components use `import * as i18n from '@/i18n'` and call `i18n.useLocale()`; pure helpers use `@/i18n/core`.
  - Use `i18n.t`, `i18n.rich` and `i18n.plural`. Never concatenate translated fragments; lists of complete phrases join with `Intl.ListFormat(i18n.getFormatLocale())`.
  - Catalogs by path: `components/assistant/**`, `components/settings/**`, `lib/ai/**` and `lib/ipc/mock/ai.ts` → shell; `components/workbench/**` → workbench; `components/workbench/dock/**` → dock.
  - Run `pnpm i18n:check -- --fix`, then add Turkish by hand.
  - Never translate Kubernetes data, kinds, section labels, YAML, logs, commands, model output or user content.
- Safety: never connect to real clusters from tests or scripts.
  - Tests use fixtures, the fake API server in `crates/kubepit-core/tests/support/`, explicit temp `Paths` (never `~/.kube`) and `MemorySecretStore`.
  - **No network calls to model providers in tests:** providers are exercised only against the fake provider HTTP server on 127.0.0.1 (Task 4).
  - Remote egress stays off in every test process (`set_ai_remote_providers` is never called by tests).
  - The live eval is `#[ignore]` and env-gated.
- `read_only`: no AI command mutates a cluster. Tools only issue GETs. Fixes reach a cluster only through the create editor → `resource_apply_yaml`, which already honours `ClusterDef.read_only` (dry runs stay allowed).
- Background work is opt-in per process: only `apps/desktop/src-tauri/src/setup.rs` calls `core.set_ai_remote_providers(true)`. The AI module schedules no background tasks (previews and sessions expire lazily).
- Layouts use container queries (`@container`, `@[…px]:` variants) so the panel, preview and settings work from a 320 px width.
- The six checks pass at the end of every task that touches their area: `pnpm typecheck`, `pnpm i18n:check`, `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`, and `pnpm dev:ui` still works against the demo backend. From Task 10 on, `pnpm test` (Vitest) passes too.
- Anthropic API (per the claude-api skill):
  - default model `claude-opus-5`, raw HTTP to `POST /v1/messages` with `x-api-key` and `anthropic-version: 2023-06-01`;
  - `thinking: {type: "adaptive"}` and `output_config.effort` only when the Models API reports support;
  - `fallbacks: "default"` + `anthropic-beta: server-side-fallback-2026-07-01`;
  - no `budget_tokens`, no assistant prefill, no `count_tokens` before consent, no hardcoded prices.
- Dependencies: `reqwest = { version = "0.13", default-features = false, features = ["rustls", "json", "stream"] }` in kubepit-core (already in `Cargo.lock`; adjust the feature names to what 0.13 exposes) and `vitest` as a dev dependency of `apps/desktop`. Nothing else.
- Limits (spec §10):
  - timeouts: connect 10 s, first event 60 s, idle 90 s, total 600 s;
  - retries: ≤ 3, base 1 s, cap 30 s, `retry-after` cap 60 s;
  - 30 provider requests/min; ≤ 8 tool rounds × 16 calls;
  - previews 10 min / 32; sessions 2 h idle / 20;
  - tool results ≤ 32 KiB; log tail 500 → ≤ 200 lines;
  - `ai_log` request ≤ 256 KiB, response ≤ 64 KiB.
- Test helpers named in test steps are local to their test file. This covers fixture builders (`sample_request`, `explain_request`, `oomPod`, …) and waiters (`send_and_collect`, `wait_for`, `waitFor`). The comment next to each use says what it builds; fixture data uses the demo names (`shop`, `web-1`, `hunter2` / `aHVudGVyMg==` as the secret).

## Review Focus

- Suggested YAML that contains `__SECRET__` / `__TOKEN__`, or `__IP_n__` / `__HOST_n__` placeholders: a secret marker must never reach the apply review; the action is disabled with the reason, and IP/host placeholders are restored before the editor opens (test in Task 12).
- Oversized context — multi-MB logs, a huge CRD status, thousands of events, non-ASCII text: the preview stays within the budget and renders in under 2 s in a debug build (test in Task 3).
- A provider stream cut mid-answer or mid-tool-input, or malformed SSE JSON: the partial text is kept, the error is retryable, and no tool runs (test in Task 4).
- A cluster disconnected or removed, or the panel/window closed, while a run streams or waits for tool consent: the run ends as cancelled, the pending decision resolves as deny, and no further provider request is sent (test in Task 8).
- A locked or unavailable keychain, or a missing key: `ai_key_set` fails with the store's message, the status shows `has_key: false` with `key_error`, sending fails before any network call, and no key is written under the data folder (test in Task 1).

---

## File Structure

**Rust core — create** (`crates/kubepit-core/src/`)

| File | Responsibility |
| ---- | -------------- |
| `ai.rs` | Module root, `AiState`, `impl Kubepit` entry points (status, keys, clusters, models, preview, send, decisions, cancel, sessions) |
| `ai/types.rs` | Serde contract types (settings, status, request, preview, events, usage, models) |
| `ai/settings.rs` | Defaults, `normalized()`, `is_loopback` |
| `ai/keys.rs` | `ai/<provider-id>` keychain entries |
| `ai/redact.rs` | Text and manifest redaction, pseudonyms, counts |
| `ai/budget.rs` | Token estimate, section fitting |
| `ai/prompts.rs` | Frozen system prompt, locale line, intent instructions, default effort |
| `ai/context.rs` | `AiRequest` → rendered, redacted, budgeted context |
| `ai/provider.rs` | `Provider` trait, chat types, errors, retries, timeouts, egress guard |
| `ai/sse.rs` | SSE parser |
| `ai/anthropic.rs`, `ai/openai.rs`, `ai/ollama.rs` | Providers and model listing |
| `ai/tools.rs` | Tool catalog, input parsing, `ReadOnlyCluster` |
| `ai/logs.rs` | Plain-text log condensation for tool results |
| `ai/pricing.rs` | Cost from usage and user prices |
| `ai/session.rs` | Run loop, approvals, limits, rate limiter, cancellation, audit hand-off |

**Rust core — modify:** `lib.rs` (module), `types.rs` (`Settings.ai`), `app.rs` (state, settings save), `cluster.rs` and `connection.rs` (cleanup), `logs.rs` (`pod_logs_tail`), `history.rs` + `history/{db,types,writer}.rs` (AI log), `Cargo.toml` (reqwest).

**Rust tests** (`crates/kubepit-core/tests/`)

- Modify `support/mod.rs`: request headers, `Reply::Sse`, `Reply::Raw`, `Reply::Hang`, `setup_with_secrets`.
- Create `support/llm.rs`: fake provider reply builders.
- Test files: `ai_settings.rs`, `ai_anthropic.rs`, `ai_openai_ollama.rs`, `ai_tools.rs`, `ai_log.rs`, `ai_session.rs`, `ai_eval.rs`, `ai_live_eval.rs`.
- Fixtures: `fixtures/ai/*.json` and `*.golden.txt`.

**Tauri:** create `src-tauri/src/ipc/ai.rs`; modify `ipc/mod.rs`, `lib.rs` (handlers), `setup.rs` (egress opt-in).

**Frontend** (`apps/desktop/src/`)

- Create `lib/ai/`:
  - `context/logs.ts`, `context/explain.ts`, `context/gather.ts`, `context/schema.ts`;
  - `answer.ts`, `placeholders.ts`, `actions.ts`, `reducer.ts`, `scope.ts`, `format.ts`, `settingsIssues.ts`, `intents.ts`, `validateGenerated.ts`;
  - a `*.test.ts` next to each pure module.
- Create `store/useAssistantStore.ts`.
- Create `components/assistant/`:
  - `AssistantPanel.tsx`, `MessageList.tsx`, `AssistantMessage.tsx`, `Composer.tsx`, `NotReady.tsx`;
  - `ContextPreview.tsx`, `BudgetBar.tsx`, `ToolCallCard.tsx`, `UsageLine.tsx`, `SuggestionActions.tsx`, `enableCluster.ts`.
- Create `components/settings/AssistantCategory.tsx` and `components/settings/assistant/{ProvidersSection,PrivacySection,PricesSection,ClustersSection,RequestLogSection}.tsx`.
- Create entry points: `components/workbench/actions/aiActions.ts`, `components/palette/assistantItems.ts`, `components/workbench/dock/editor/AssistantYamlBar.tsx`.
- Create the demo backend: `lib/ipc/mock/ai.ts`, `lib/ipc/mock/fixtures/ai.ts`.
- Modify:
  - `types/index.ts`, `lib/ipc.ts`, `lib/ipc/mock/{index,app,history}.ts`;
  - `store/types.ts`, `store/useDockStore.ts`;
  - `components/{RightSidePanel,RightActivityBar}.tsx`, `components/workbench/common/Markdown.tsx`, `components/settings/SettingsView.tsx`;
  - `components/workbench/actions/resourceActions.tsx`, `components/palette/paletteItems.tsx`;
  - `components/workbench/dock/{promql/PromqlView,loki/LokiView,editor/CreateEditor}.tsx`;
  - `i18n/{en,tr}/{shell,workbench,dock}.json`.
- Tooling: create `apps/desktop/vitest.config.ts`; modify `apps/desktop/package.json` and the root `package.json` (`test` scripts).

**Docs:** `docs/ARCHITECTURE.md` and `README.md`.

---

### Task 1: AI settings, keychain keys and cluster enablement

**Files:**
- Create: `crates/kubepit-core/src/ai.rs`, `crates/kubepit-core/src/ai/types.rs`, `crates/kubepit-core/src/ai/settings.rs`, `crates/kubepit-core/src/ai/keys.rs`
- Modify:
  - `crates/kubepit-core/src/lib.rs`: module table row "`ai` | assistant: providers, redaction, tools, sessions" and `pub mod ai;`
  - `crates/kubepit-core/src/types.rs:1038-1088`: `pub ai: crate::ai::AiSettings` in `Settings` and its `Default`
  - `crates/kubepit-core/src/app.rs:37-70`: field `pub(crate) ai: crate::ai::AiState`
  - `crates/kubepit-core/src/app.rs:83-121`: init
  - `crates/kubepit-core/src/app.rs:159-190`: `set_settings` keeps the stored `ai.clusters` and normalizes `ai`
  - `crates/kubepit-core/src/cluster.rs:250-268`: call `self.ai_forget_cluster(id)`
  - `crates/kubepit-core/tests/support/mod.rs`: add `setup_with_secrets`
  - `apps/desktop/src/types/index.ts`: `AiSettings`, `AiProviderConfig`, `AiProviderKind`, `AiRedactionSettings`, `AiToolPolicy`, `AiEffort`, `AiPrice`, `Settings.ai` (the contract rule: `Settings` crosses `settings_get` / `settings_set`)
  - `apps/desktop/src/lib/ipc/mock/app.ts`: demo default settings get `ai` equal to the Rust defaults
- Test: `crates/kubepit-core/tests/ai_settings.rs`

**Interfaces:**
- Consumes: `secrets::{SecretStore, MemorySecretStore, write_value, read_value, delete_value}`, `history::redact::secret_like`, `types::ClusterEnvironment`.
- Produces:
  - `ai::types`:
    - `AiSettings { enabled, local_only, active_provider: Option<String>, providers: Vec<AiProviderConfig>, clusters: Vec<String>, redaction: AiRedactionSettings, tool_policy: AiToolPolicy, log_requests, max_context_tokens: u32, effort: Option<AiEffort>, prices: Vec<AiPrice> }`
    - `AiProviderConfig { id, kind: AiProviderKind, name, base_url, model, context_window: Option<u32>, max_output_tokens: u32 }`
    - `AiProviderKind::{Anthropic, OpenaiCompatible, Ollama}`, serialized as `anthropic` | `openai-compatible` | `ollama` (kebab-case on `OpenaiCompatible`; `OpenAiCompatible` would serialize as `open-ai-compatible`)
    - `AiRedactionSettings { tokens, ips, hostnames }`
    - `AiToolPolicy` (lowercase `off` | `ask` | `session`); `AiEffort` (lowercase `low` … `max`)
    - `AiPrice { model, input_per_mtok: f64, output_per_mtok: f64, cache_write_per_mtok: Option<f64>, cache_read_per_mtok: Option<f64> }`
    - `AiUsage { input_tokens, output_tokens, cache_read_tokens, cache_write_tokens: u64 }` with `add(&mut self, &AiUsage)`
    - `AiStatus { enabled, local_only, remote_allowed, keychain: String, providers: Vec<AiProviderStatus> }`
    - `AiProviderStatus { id, kind, local, has_key, key_error: Option<String>, allowed }`
  - `AiSettings::{default() (values from spec §7.1), normalized(self) -> Self, provider(&self, id: &str) -> Option<&AiProviderConfig>, active(&self) -> Option<&AiProviderConfig>}`
  - `ai::settings::is_loopback(base_url: &str) -> bool`
  - `ai::keys::{key_name(provider_id: &str) -> String /* "ai/<id>" */, read_key(store: &dyn SecretStore, provider_id: &str) -> Result<Option<String>>, write_key(store, provider_id, key: &str) -> Result<()>, delete_key(store, provider_id) -> Result<()>}`
  - `Kubepit::{ai_status(&self) -> AiStatus, ai_key_set(&self, provider_id: &str, key: &str) -> Result<AiStatus>, ai_key_delete(&self, provider_id: &str) -> Result<AiStatus>, ai_cluster_set(&self, cluster_id: &str, enabled: bool, acknowledge_production: bool) -> Result<Settings>, set_ai_remote_providers(&self, on: bool), ai_remote_allowed(&self) -> bool, pub(crate) ai_forget_cluster(&self, cluster_id: &str)}`
  - `support::setup_with_secrets(server: &str, read_only: bool, secrets: Arc<MemorySecretStore>) -> (tempfile::TempDir, Arc<Kubepit>, Arc<Recorder>, String)`

- [ ] **Step 1: Write the failing tests**

```rust
// tests/ai_settings.rs
mod support;
use std::sync::Arc;
use kubepit_core::ai::{AiToolPolicy, AiSettings};
use kubepit_core::secrets::MemorySecretStore;
use kubepit_core::types::{ClusterEnvironment, ClusterInput, Settings};

const KEY: &str = "sk-ant-test-0123456789abcdefghij";

#[test]
fn assistant_is_off_by_default_and_keys_live_only_in_the_keychain() {
    let secrets = Arc::new(MemorySecretStore::default());
    let (dir, app, _r, _id) = support::setup_with_secrets("http://127.0.0.1:9", false, secrets.clone());
    let ai = app.settings().ai;
    assert!(!ai.enabled && !ai.local_only);
    assert_eq!(ai.active_provider.as_deref(), Some("anthropic"));
    assert_eq!(ai.provider("anthropic").unwrap().model, "claude-opus-5");
    assert_eq!(ai.provider("anthropic").unwrap().base_url, "https://api.anthropic.com");
    assert_eq!(ai.provider("ollama").unwrap().base_url, "http://127.0.0.1:11434");
    assert_eq!(ai.tool_policy, AiToolPolicy::Ask);
    assert!(ai.redaction.tokens && !ai.redaction.ips && !ai.redaction.hostnames);
    assert!(ai.log_requests && ai.max_context_tokens == 60_000 && ai.prices.is_empty());
    let status = app.ai_key_set("anthropic", KEY).unwrap();
    assert!(status.providers.iter().any(|p| p.id == "anthropic" && p.has_key));
    assert_eq!(secrets.keys(), vec!["ai/anthropic".to_string()]);
    assert!(!support::home_contains(dir.path(), KEY));
    app.ai_key_delete("anthropic").unwrap();
    assert!(secrets.keys().is_empty());
}

#[test]
fn locked_keychain_fails_without_plaintext_fallback() {
    let secrets = Arc::new(MemorySecretStore::default());
    let (dir, app, _r, _id) = support::setup_with_secrets("http://127.0.0.1:9", false, secrets.clone());
    secrets.set_available(false);
    let err = app.ai_key_set("anthropic", KEY).unwrap_err().to_string();
    assert!(err.contains("locked"), "{err}");
    let p = app.ai_status().providers.into_iter().find(|p| p.id == "anthropic").unwrap();
    assert!(!p.has_key && p.key_error.is_some());
    assert!(!support::home_contains(dir.path(), KEY));
}

#[test]
fn production_clusters_need_an_acknowledgement() {
    let (_d, app, _r, _id) = support::setup_with_secrets("http://127.0.0.1:9", false, Default::default());
    let prod = app.cluster_add(vec![ClusterInput {
        name: "prod".into(), context: "fake".into(),
        kubeconfig_text: Some(support::kubeconfig_for("http://127.0.0.1:9")),
        environment: Some(ClusterEnvironment::Production), ..Default::default()
    }]).unwrap().remove(0);
    let err = app.ai_cluster_set(&prod.id, true, false).unwrap_err().to_string();
    assert!(err.contains("production"), "{err}");
    let saved = app.ai_cluster_set(&prod.id, true, true).unwrap();
    assert_eq!(saved.ai.clusters, vec![prod.id.clone()]);
}

#[test]
fn settings_set_cannot_change_enabled_clusters() {
    let (_d, app, _r, id) = support::setup_with_secrets("http://127.0.0.1:9", false, Default::default());
    let mut s = app.settings();
    s.ai.clusters = vec![id.clone()];
    assert!(app.set_settings(s).unwrap().ai.clusters.is_empty());
}

#[tokio::test]
async fn removing_a_cluster_forgets_its_enablement() {
    let (_d, app, _r, id) = support::setup_with_secrets("http://127.0.0.1:9", false, Default::default());
    app.ai_cluster_set(&id, true, false).unwrap();
    app.cluster_remove(&id).await.unwrap();
    assert!(app.settings().ai.clusters.is_empty());
}

#[test]
fn remote_egress_is_off_until_the_process_enables_it() {
    let (_d, app, _r, _id) = support::setup_with_secrets("http://127.0.0.1:9", false, Default::default());
    let allowed = |app: &kubepit_core::Kubepit, id: &str| app.ai_status().providers.iter().find(|p| p.id == id).unwrap().allowed;
    assert!(!app.ai_remote_allowed() && !app.ai_status().remote_allowed);
    assert!(!allowed(&app, "anthropic") && allowed(&app, "ollama"));
    app.set_ai_remote_providers(true);
    assert!(allowed(&app, "anthropic"));
    let mut s = app.settings();
    s.ai.local_only = true;
    app.set_settings(s).unwrap();
    assert!(!allowed(&app, "anthropic") && allowed(&app, "ollama"));
}

#[test]
fn normalize_clamps_and_restores_defaults() {
    let mut ai = AiSettings::default();
    ai.max_context_tokens = 10;
    ai.providers.retain(|p| p.id != "ollama");
    ai.providers[0].base_url = "  ".into();
    let n = ai.normalized();
    assert_eq!(n.max_context_tokens, 2_000);
    assert!(n.provider("ollama").is_some());
    assert_eq!(n.provider("anthropic").unwrap().base_url, "https://api.anthropic.com");
    let mut big = AiSettings::default();
    big.max_context_tokens = 5_000_000;
    assert_eq!(big.normalized().max_context_tokens, 900_000);
}
```

Add `support::home_contains(root: &Path, needle: &str) -> bool`, which walks every file under `root` and checks its bytes.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kubepit-core --test ai_settings`
Expected: FAIL to compile. `kubepit_core::ai` and `setup_with_secrets` are not defined.

- [ ] **Step 3: Implement the module, settings, keys and entry points**

- `AiState` holds the `remote_allowed: AtomicBool` for now; later tasks add fields.
- `ai_status` reads each provider's key with `read_key` and maps errors to `key_error` (`format!("{e:#}")`).
- `allowed = is_loopback(base_url) || (remote_allowed && !local_only)`.
- `ai_cluster_set` errors with `"<name> is a production cluster: confirm to enable the assistant"` when `environment == Some(Production)` and no acknowledgement is given. It writes through `store.set_settings`, deduped and sorted.
- `ai_forget_cluster` removes the id from `ai.clusters`.
- `is_loopback` parses the URL host and accepts `127.0.0.0/8`, `::1` and `localhost`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p kubepit-core --test ai_settings && cargo test -p kubepit-core --lib && pnpm typecheck`
Expected: PASS. The existing tests still pass, because `settings.json` files without `ai` load through `#[serde(default)]`.

- [ ] **Step 5: Commit**

```bash
git add crates/kubepit-core/src/ai.rs crates/kubepit-core/src/ai crates/kubepit-core/src/lib.rs crates/kubepit-core/src/types.rs crates/kubepit-core/src/app.rs crates/kubepit-core/src/cluster.rs crates/kubepit-core/tests/support/mod.rs crates/kubepit-core/tests/ai_settings.rs apps/desktop/src/types/index.ts apps/desktop/src/lib/ipc/mock/app.ts
git commit -m "feat(core): assistant settings, keychain keys and per-cluster enablement"
```

---

### Task 2: Redaction

**Files:**
- Create: `crates/kubepit-core/src/ai/redact.rs` (unit tests inline)
- Modify: `crates/kubepit-core/src/ai.rs` (`pub mod redact;`)

**Interfaces:**
- Consumes: `history::redact::secret_like`, `AiRedactionSettings`.
- Produces:
  - `pub const SECRET_MARKER: &str = "__SECRET__"; pub const TOKEN_MARKER: &str = "__TOKEN__";`
  - `RedactOptions { tokens, ips, hostnames }`, `impl From<&AiRedactionSettings> for RedactOptions`
  - `RedactionCounts { secrets, tokens, ips, hostnames: u32 }` (serde, `Default`, `add(&mut self, &Self)`)
  - `Pseudonyms` (`Default`): `placeholder(&mut self, kind: PseudoKind, original: &str) -> String`, `restore_map(&self) -> BTreeMap<String, String>`; `enum PseudoKind { Ip, Host }` → `__IP_<n>__` / `__HOST_<n>__`, numbered from 1 per kind in first-seen order
  - `redact_text(text: &str, opts: &RedactOptions, pseudo: &mut Pseudonyms) -> (String, RedactionCounts)`
  - `redact_value(value: &serde_json::Value, opts: &RedactOptions, pseudo: &mut Pseudonyms) -> (serde_json::Value, RedactionCounts)`
  - `redact_manifest_text(text: &str, opts: &RedactOptions, pseudo: &mut Pseudonyms) -> (String, RedactionCounts)`: multi-document YAML/JSON in, YAML out; unparsable text falls back to `redact_text`

- [ ] **Step 1: Write the failing tests** (in `ai/redact.rs`, `#[cfg(test)]`)

```rust
const LEAKS: &[&str] = &["aHVudGVyMg==", "hunter2", "s3cr3t", "AKIAIOSFODNN7EXAMPLE",
    "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.c2lnbmF0dXJlLXZhbHVl",
    "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC"];
fn clean(s: &str) { for l in LEAKS { assert!(!s.contains(l), "{l} leaked in {s}"); } }
const NONE: RedactOptions = RedactOptions { tokens: false, ips: false, hostnames: false };
const ALL: RedactOptions = RedactOptions { tokens: true, ips: true, hostnames: true };

#[test]
fn secret_values_never_survive_even_with_every_option_off() {
    let yaml = r#"
apiVersion: v1
kind: Secret
metadata:
  name: db
  annotations:
    kubectl.kubernetes.io/last-applied-configuration: '{"data":{"PASSWORD":"aHVudGVyMg=="}}'
  managedFields: [{manager: kubectl}]
data: {PASSWORD: aHVudGVyMg==}
stringData: {TOKEN: s3cr3t}
---
apiVersion: v1
kind: Pod
metadata: {name: web}
spec:
  containers:
  - name: app
    env:
    - {name: DB_PASSWORD, value: hunter2}
    - {name: LOG_LEVEL, value: debug}
"#;
    let (out, counts) = redact_manifest_text(yaml, &NONE, &mut Pseudonyms::default());
    clean(&out);
    assert!(out.contains("PASSWORD: __SECRET__") && out.contains("LOG_LEVEL") && out.contains("debug"));
    assert!(!out.contains("managedFields") && !out.contains("last-applied-configuration"));
    assert_eq!(counts.secrets, 3);
}

#[test]
fn pem_private_keys_are_always_masked() {
    let text = "key:\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n";
    let (out, c) = redact_text(text, &NONE, &mut Pseudonyms::default());
    clean(&out); assert!(out.contains(SECRET_MARKER)); assert_eq!(c.secrets, 1);
}

#[test]
fn tokens_are_masked_only_when_enabled() {
    let text = "auth Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.c2lnbmF0dXJlLXZhbHVl aws AKIAIOSFODNN7EXAMPLE gh ghp_0123456789abcdefghijklmnopqrstuvwxyzAB url postgres://app:hunter2@db:5432 password=s3cr3t";
    let (masked, c) = redact_text(text, &RedactOptions { tokens: true, ..NONE }, &mut Pseudonyms::default());
    clean(&masked); assert!(c.tokens >= 5); assert!(masked.contains("postgres://__TOKEN__@db:5432"));
    let (kept, _) = redact_text(text, &NONE, &mut Pseudonyms::default());
    assert!(kept.contains("AKIAIOSFODNN7EXAMPLE"));
}

#[test]
fn ips_and_hostnames_get_consistent_restorable_placeholders() {
    let mut p = Pseudonyms::default();
    let (out, c) = redact_text("10.0.3.7 -> db.acme.internal, again 10.0.3.7; listen 127.0.0.1 0.0.0.0; app.py main.go registry.k8s.io/pause app.kubernetes.io/name ghcr.io/org/api", &ALL, &mut p);
    assert_eq!(out, "__IP_1__ -> __HOST_1__, again __IP_1__; listen 127.0.0.1 0.0.0.0; app.py main.go registry.k8s.io/pause app.kubernetes.io/name ghcr.io/org/api");
    assert_eq!((c.ips, c.hostnames), (2, 1));
    assert_eq!(p.restore_map().get("__HOST_1__").map(String::as_str), Some("db.acme.internal"));
}

#[test]
fn unparsable_manifests_fall_back_to_text_redaction() {
    let (out, _) = redact_manifest_text("kind: [\npassword=s3cr3t", &RedactOptions { tokens: true, ..NONE }, &mut Pseudonyms::default());
    clean(&out);
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kubepit-core --lib ai::redact`
Expected: FAIL to compile. `redact_manifest_text` is not defined.

- [ ] **Step 3: Implement redaction in `ai/redact.rs`**

Compile every regex once with `std::sync::LazyLock`. Text passes run in this order: PEM → tokens → URL userinfo → IPs → hostnames.

- **Always:** PEM `-----BEGIN [A-Z ]*PRIVATE KEY-----` … `END` blocks.
- **Always, in objects:**
  - for `secret_like(kind)`: the leaves of `data`, `stringData`, `encryptedData` and `spec`;
  - `env[].value` where the name matches `(?i)(pass(word|wd)?|secret|token|api[_-]?key|credential|private[_-]?key|auth)`;
  - removal of `metadata.managedFields` and `metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"]`.
- **`tokens`:**
  - JWT `eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}`
  - `Bearer\s+[\w.~+/-]{16,}=*`
  - `(AKIA|ASIA)[0-9A-Z]{16}`
  - `gh[pousr]_[A-Za-z0-9]{36,}`
  - `xox[baprs]-[\w-]{10,}`
  - `AIza[\w-]{35}`
  - `sk-(ant-)?[\w-]{20,}`
  - URL userinfo `://[^/\s:@]+:[^/\s@]+@` → `://__TOKEN__@`
  - key/value `(?i)(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)(["']?\s*[:=]\s*["']?)[^\s"',;]{4,}`, keeping the key
- **`ips`:** valid IPv4 dotted quads and IPv6 with `::`, except `127.0.0.0/8`, `0.0.0.0` and `::1`.
- **`hostnames`:** `([a-z0-9-]+\.)+[a-z]{2,24}` (case-insensitive), except:
  - the allowlist `kubernetes.io`, `k8s.io`, `x-k8s.io`, `cluster.local`, `docker.io`, `ghcr.io`, `gcr.io`, `quay.io`, `registry.k8s.io` and their subdomains;
  - names whose last label is a file extension: `py go js ts java yaml yml json log txt sh conf xml html md rb rs jar class so lock tmp pid sock crt key pem`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p kubepit-core --lib ai::redact`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add crates/kubepit-core/src/ai.rs crates/kubepit-core/src/ai/redact.rs
git commit -m "feat(core): assistant redaction (secrets always, tokens/IPs/hostnames optional)"
```

---

### Task 3: Context rendering, prompts and budgeting

**Files:**
- Create: `crates/kubepit-core/src/ai/budget.rs`, `crates/kubepit-core/src/ai/prompts.rs`, `crates/kubepit-core/src/ai/context.rs` (unit tests inline)
- Modify: `crates/kubepit-core/src/ai/types.rs`
- Modify: `crates/kubepit-core/src/ai.rs`

**Interfaces:**
- Consumes: Task 2 `redact_text`, `redact_manifest_text`, `Pseudonyms`, `RedactionCounts`.
- Produces (types):
  - `AiIntent` (kebab-case: `explain`, `fix`, `chat`, `kubectl`, `promql`, `logql`, `explain-query`, `yaml`); `AiLocale` (`en` | `tr`)
  - `AiSectionKind` (lowercase, spec §7.2); `AiSectionFormat` (`yaml` | `json` | `text` | `log`)
  - `AiContextSection { id, kind, label, priority: u8, format, content }`
  - `AiObjectRef { api_version, kind, namespace: Option<String>, name }`; `AiScope { cluster_id: Option<String>, namespace: Option<String>, object: Option<AiObjectRef> }`
  - `AiRequest { session_id: Option<String>, intent, message, scope, sections: Vec<AiContextSection>, excluded: Vec<String>, locale }`
  - `AiPreviewSection { id, kind, label, text, tokens: u32, original_tokens: u32, trimmed: bool, excluded: bool, redactions: RedactionCounts }`
- Produces (functions):
  - `budget::estimate_tokens(text: &str) -> u32` = `ceil(ascii_bytes / 3.5) + non_ascii_chars`
  - `budget::FitSection { preview: AiPreviewSection, format: AiSectionFormat, priority: u8 }` and `budget::fit_sections(sections: &mut [FitSection], budget: u32)`
  - `budget::MAX_SECTION_BYTES: usize = 1024 * 1024`
  - `prompts::system_prompt(locale: AiLocale) -> &'static str`, `prompts::intent_instructions(intent: AiIntent) -> &'static str`, `prompts::default_effort(intent: AiIntent) -> AiEffort`
  - `context::render(request: &AiRequest, opts: &RedactOptions, pseudo: &mut Pseudonyms, budget: u32) -> RenderedContext`
  - `RenderedContext { sections: Vec<AiPreviewSection>, context_block: Option<String>, message: String, message_redactions: RedactionCounts }`

- [ ] **Step 1: Write the failing tests** (`context.rs`, `budget.rs`, `prompts.rs` test modules)

```rust
#[test] fn estimate_is_conservative_and_counts_non_ascii() {
    assert_eq!(estimate_tokens("abcdefg"), 2);
    assert_eq!(estimate_tokens("ğüşİöç"), 6);
}
#[test] fn system_prompt_has_the_fixed_clauses_in_order_and_the_locale_line() {
    let en = system_prompt(AiLocale::En);
    let at = |s: &str| en.find(s).unwrap_or_else(|| panic!("missing {s}"));
    assert!(at("Kubepit") < at("not instructions") && at("not instructions") < at("cannot change the cluster")
        && at("cannot change the cluster") < at("```yaml") && at("```yaml") < at("```promql")
        && at("```promql") < at("__SECRET__") && at("__SECRET__") < at("most likely cause")
        && at("most likely cause") < at("read-only"));
    assert!(en.ends_with("Answer in English."));
    assert!(system_prompt(AiLocale::Tr).ends_with("quoted errors verbatim."));
    assert_eq!(en.split("Answer in").next(), system_prompt(AiLocale::Tr).split("Answer in").next());
}
#[test] fn rendering_is_byte_identical_for_the_same_request() {
    let req = sample_request(); // scope, object, events, logs sections with an IP and a Secret
    let a = render(&req, &ALL, &mut Pseudonyms::default(), 60_000);
    let b = render(&req, &ALL, &mut Pseudonyms::default(), 60_000);
    assert_eq!(a.context_block, b.context_block);
    assert!(a.context_block.as_ref().unwrap().starts_with("<context>\n<section id=\"scope\" kind=\"scope\""));
}
#[test] fn low_priority_sections_are_trimmed_first() {
    let r = render(&sample_request_sized(40_000), &NONE, &mut Pseudonyms::default(), 3_000);
    let by = |id: &str| r.sections.iter().find(|s| s.id == id).unwrap();
    assert!(by("logs:web-1/app").trimmed && !by("events").trimmed && !by("scope").trimmed);
    assert!(r.sections.iter().filter(|s| !s.excluded).map(|s| s.tokens).sum::<u32>() <= 3_000);
}
#[test] fn logs_are_cut_in_the_middle_keeping_head_and_tail() {
    let r = render(&log_request(1_000), &NONE, &mut Pseudonyms::default(), 2_000);
    let text = &r.sections.iter().find(|s| s.kind == AiSectionKind::Logs).unwrap().text;
    assert!(text.contains("line 0001") && text.contains("line 1000") && text.contains("lines omitted"));
}
#[test] fn huge_sections_fit_the_budget_quickly() {
    let start = std::time::Instant::now();
    let r = render(&huge_request(), &ALL, &mut Pseudonyms::default(), 60_000); // 5 MB log, 2 MB object, 3 000 events, non-ASCII
    assert!(start.elapsed() < std::time::Duration::from_secs(2));
    assert!(r.sections.iter().filter(|s| !s.excluded).map(|s| s.tokens).sum::<u32>() <= 60_000);
}
#[test] fn excluded_sections_are_listed_but_not_rendered() {
    let mut req = sample_request(); req.excluded = vec!["events".into()];
    let r = render(&req, &NONE, &mut Pseudonyms::default(), 60_000);
    assert!(r.sections.iter().any(|s| s.id == "events" && s.excluded));
    assert!(!r.context_block.unwrap().contains("id=\"events\""));
}
#[test] fn no_sections_means_no_context_block_and_the_message_is_redacted() {
    let mut req = sample_request(); req.sections.clear(); req.message = "why does 10.1.2.3 fail?".into();
    let r = render(&req, &ALL, &mut Pseudonyms::default(), 60_000);
    assert!(r.context_block.is_none()); assert_eq!(r.message, "why does __IP_1__ fail?");
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kubepit-core --lib ai::`
Expected: FAIL to compile. `render`, `system_prompt` and `estimate_tokens` are not defined.

- [ ] **Step 3: Implement `prompts.rs`**

- The system prompt holds the seven clauses of spec §8, word for word in meaning, in that order. The locale line is appended as exact copy.
- Intent instructions, one short paragraph each:
  - `explain`: diagnose the scoped object;
  - `fix`: propose minimal partial manifests;
  - `chat`;
  - `kubectl`: one command in a `sh` fence, flags explained, no execution;
  - `promql` / `logql`: one query in its fence;
  - `explain-query`: explain the query in the context, clause by clause;
  - `yaml`: complete manifests valid against the schema section, one `yaml` fence.
- `default_effort`: `explain`, `fix` and `yaml` → High; `chat` → Medium; the others → Low.

- [ ] **Step 4: Implement `budget.rs` and `context.rs`**

`render`:
1. Pre-cap each section at `MAX_SECTION_BYTES`. Logs keep 20 % head and 80 % tail lines.
2. Redact: `yaml` / `json` sections through `redact_manifest_text`, others through `redact_text`. Redact labels and the message with `redact_text`.
3. Stable-sort by priority.
4. `fit_sections`: while the included total exceeds the budget, trim the included section with the highest priority number (ties: the later one):
   - `log`: middle cut, marker `… {n} lines omitted …`;
   - others: tail cut, marker `… truncated (≈{n} tokens) …`;
   - a section under 64 tokens becomes its marker, flagged `trimmed`.
5. Build `<context>\n<section id="…" kind="…" label="…">\n{text}\n</section>\n…</context>`. Escape `&`, `"` and `<` in attributes; omit excluded sections; return `None` when nothing is included.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p kubepit-core --lib ai::`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add crates/kubepit-core/src/ai.rs crates/kubepit-core/src/ai/{types,budget,prompts,context}.rs
git commit -m "feat(core): assistant prompts, context rendering and token budgeting"
```

---

### Task 4: Provider trait, fake provider server and the Anthropic provider

**Files:**
- Modify: `crates/kubepit-core/Cargo.toml` (`reqwest`)
- Create: `crates/kubepit-core/src/ai/provider.rs`, `crates/kubepit-core/src/ai/sse.rs`, `crates/kubepit-core/src/ai/anthropic.rs`
- Modify: `crates/kubepit-core/src/ai/types.rs` (`AiModelInfo`)
- Modify: `crates/kubepit-core/tests/support/mod.rs`:
  - `Request.headers: Vec<(String, String)>` with lowercased names, parsed in `handle`;
  - `Reply::Sse { events: Vec<SseEvent>, gap_ms: u64, cut_after: Option<usize> }`, `pub struct SseEvent { pub event: Option<String>, pub data: String }`;
  - `Reply::Raw { code: u16, headers: Vec<(String, String)>, body: String }`;
  - `Reply::Hang` (headers, then silence for 30 s);
  - `pub mod llm;`
- Create: `crates/kubepit-core/tests/support/llm.rs`
- Test: `crates/kubepit-core/tests/ai_anthropic.rs`

**Interfaces:**
- Consumes: `AiUsage`, `AiEffort`, `AiProviderKind` (Task 1); `prompts::system_prompt` (Task 3).
- Produces (`ai::provider`):
  - `ChatRequest { model: String, system: String, messages: Vec<ChatMessage>, tools: Vec<ToolSpec>, max_tokens: u32, effort: Option<AiEffort> }`
  - `enum ChatMessage { User(Vec<UserBlock>), Assistant(AssistantTurn) }`
  - `enum UserBlock { Text { text: String, cache: bool }, ToolResult { call_id: String, content: String, is_error: bool } }`
  - `ToolSpec { name: &'static str, description: &'static str, schema: serde_json::Value }`
  - `ToolCallReq { id: String, name: String, input: Result<serde_json::Value, String> }` (`Err` = raw text that failed the strict parse)
  - `AssistantTurn { raw: serde_json::Value, text: String, tool_calls: Vec<ToolCallReq>, stop: StopReason, usage: AiUsage, model: String }`
  - `enum StopReason { EndTurn, ToolUse, MaxTokens, Refusal { category: Option<String> } }`
  - `enum StreamEvent { Text(String), Thinking, Usage(AiUsage), Fallback { from: String, to: String }, Retrying { attempt: u32, delay_ms: u64, reason: String } }`
  - `ProviderError { kind: ProviderErrorKind, message: String, retry_after: Option<Duration>, partial: Option<AssistantTurn> }` with `retryable(&self) -> bool`
  - `enum ProviderErrorKind { Auth, BadRequest, NotFound, RateLimited, Overloaded, Server, Timeout, Network, Protocol, Cancelled, EgressRefused }`
  - `AiTimeouts { connect, first_event, idle, total: Duration }` (Default 10/60/90/600 s)
  - `RetryPolicy { max_retries: u32, base: Duration, cap: Duration, retry_after_cap: Duration }` (Default 3 / 1 s / 30 s / 60 s)
  - `type EventSink<'a> = &'a (dyn Fn(StreamEvent) + Send + Sync);`
  - `trait Provider: Send + Sync { fn kind(&self) -> AiProviderKind; fn is_local(&self) -> bool; fn list_models(&self) -> BoxFuture<'_, Result<Vec<AiModelInfo>, ProviderError>>; fn chat<'a>(&'a self, req: &'a ChatRequest, on_event: EventSink<'a>, cancel: &'a tokio_util::sync::CancellationToken) -> BoxFuture<'a, Result<AssistantTurn, ProviderError>>; }`
  - `async fn with_retries<F, Fut>(policy: &RetryPolicy, on_event: EventSink<'_>, attempt: F) -> Result<AssistantTurn, ProviderError> where F: FnMut() -> Fut, Fut: Future<Output = Result<AssistantTurn, ProviderError>>`
  - `fn http_client(t: &AiTimeouts) -> reqwest::Client`
  - `fn check_egress(base_url: &str, remote_allowed: bool, local_only: bool) -> Result<(), ProviderError>`
- Produces (`ai::sse`): `struct SseParser` with `push(&mut self, bytes: &[u8]) -> Vec<(Option<String>, String)>`.
- Produces (`ai::anthropic`):
  - `AnthropicProvider::new(client: reqwest::Client, base_url: String, api_key: String, timeouts: AiTimeouts, retry: RetryPolicy, model_info: Option<AiModelInfo>) -> Self`
  - `AnthropicProvider::request_body(&self, req: &ChatRequest) -> serde_json::Value`
  - `AnthropicProvider::model_info(&self, id: &str) -> BoxFuture<'_, Result<AiModelInfo, ProviderError>>`
  - `AiModelInfo { id, display_name: Option<String>, context_window: Option<u32>, max_output_tokens: Option<u32>, adaptive_thinking: Option<bool>, effort: Option<bool> }`
- Produces (`support::llm`): `anthropic_text(text: &str, usage: Value) -> Reply`, `anthropic_tool_use(text: &str, id: &str, name: &str, chunks: &[&str]) -> Reply`, `anthropic_refusal(category: &str) -> Reply`, `anthropic_error(code: u16, kind: &str, message: &str, retry_after: Option<u32>) -> Reply`

- [ ] **Step 1: Write the failing tests** (`tests/ai_anthropic.rs`)

Each test starts `support::start(router)` and builds `AnthropicProvider` against `server.url` with `RetryPolicy { base: Duration::from_millis(10), ..Default::default() }`.

```rust
#[tokio::test] async fn sends_documented_headers_and_a_cacheable_body() {
    // request: one user message with [Text{context, cache:true}, Text{question, cache:false}], two tools
    let req = &log.lock()[0];
    assert_eq!(header(req, "x-api-key"), KEY);
    assert_eq!(header(req, "anthropic-version"), "2023-06-01");
    assert_eq!(header(req, "anthropic-beta"), "server-side-fallback-2026-07-01");
    let body: Value = serde_json::from_str(&req.body).unwrap();
    assert_eq!(body["model"], "claude-opus-5"); assert_eq!(body["stream"], true);
    assert_eq!(body["system"][0]["cache_control"]["type"], "ephemeral");
    assert_eq!(body["messages"][0]["content"][0]["cache_control"]["type"], "ephemeral");
    assert!(body["messages"][0]["content"][1].get("cache_control").is_none());
    assert_eq!(body["cache_control"]["type"], "ephemeral");
    assert_eq!(body["fallbacks"], "default");
    let names: Vec<_> = body["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert!(names.windows(2).all(|w| w[0] < w[1]));
    assert!(body.get("thinking").is_none(), "no capability info → no thinking param");
}
#[test] fn thinking_and_effort_follow_model_capabilities() {
    let info = AiModelInfo { adaptive_thinking: Some(true), effort: Some(true), ..model("claude-opus-5") };
    let body = provider_with(info).request_body(&req_with_effort(AiEffort::High));
    assert_eq!(body["thinking"]["type"], "adaptive"); assert_eq!(body["output_config"]["effort"], "high");
    assert!(body.get("budget_tokens").is_none() && body["thinking"].get("budget_tokens").is_none());
}
#[tokio::test] async fn streams_text_and_maps_usage_with_cache_tokens() {
    // anthropic_text("Hello", {input_tokens:1200, cache_creation_input_tokens:800, cache_read_input_tokens:0}), output 5
    assert_eq!(texts, vec!["Hel", "lo"]); assert_eq!(turn.text, "Hello");
    assert_eq!(turn.usage, AiUsage { input_tokens: 1200, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 800 });
    assert!(matches!(turn.stop, StopReason::EndTurn));
}
#[tokio::test] async fn tool_input_is_parsed_strictly() {
    // chunks ["{\"namespace\":\"sh", "op\",\"pod\":\"web-1\"}"] → Ok(json); ["{\"pod\": \"web"] → Err(raw)
}
#[tokio::test] async fn thinking_blocks_are_kept_verbatim_in_raw() { /* thinking + signature deltas → turn.raw[0] == {"type":"thinking","thinking":"","signature":"sig"} ; StreamEvent::Thinking emitted */ }
#[tokio::test] async fn a_stream_cut_mid_tool_input_is_retryable_and_runs_nothing() {
    // text "Checking" then tool_use start + one input chunk, cut_after
    let err = result.unwrap_err();
    assert!(err.retryable()); let partial = err.partial.unwrap();
    assert_eq!(partial.text, "Checking"); assert!(partial.tool_calls.is_empty());
}
#[tokio::test] async fn malformed_sse_json_is_a_protocol_error() { /* data: {not json */ }
#[tokio::test] async fn refusal_stops_without_tool_calls() {
    // stop_reason "refusal", stop_details {category:"cyber"}, a started tool_use block
    assert!(matches!(turn.stop, StopReason::Refusal { category: Some(ref c) } if c == "cyber"));
    assert!(turn.tool_calls.is_empty());
}
#[tokio::test] async fn fallback_blocks_emit_a_fallback_event() { /* content_block_start {type:"fallback", from:{model:"claude-opus-5"}, to:{model:"claude-opus-4-8"}} */ }
#[tokio::test] async fn retries_without_fallbacks_when_the_parameter_is_rejected() {
    // 1st: 400 invalid_request_error "fallbacks: not supported for this model"; 2nd: text
    assert_eq!(log.lock().len(), 2);
    let second: Value = serde_json::from_str(&log.lock()[1].body).unwrap();
    assert!(second.get("fallbacks").is_none()); assert_eq!(header_opt(&log.lock()[1], "anthropic-beta"), None);
}
#[tokio::test] async fn honours_retry_after_and_gives_up_after_three_retries() {
    // always 429 rate_limit_error with retry-after: 0
    assert_eq!(log.lock().len(), 4); assert_eq!(err.kind, ProviderErrorKind::RateLimited);
    assert_eq!(retry_events, vec![1, 2, 3]);
}
#[tokio::test] async fn authentication_errors_are_not_retried_and_never_echo_the_key() {
    assert_eq!(log.lock().len(), 1); assert_eq!(err.kind, ProviderErrorKind::Auth); assert!(!err.message.contains(KEY));
}
#[tokio::test] async fn idle_streams_time_out() { /* Reply::Hang, AiTimeouts{idle:200ms, first_event:200ms,..} → Timeout */ }
#[tokio::test] async fn cancellation_stops_the_stream() { /* gap_ms 300, cancel after first Text → Cancelled within 1 s */ }
#[tokio::test] async fn lists_models_with_capabilities_across_pages() {
    // /v1/models page 1 has_more:true last_id:"m1" → after_id=m1 page 2
    assert_eq!(models[0].context_window, Some(1_000_000)); assert_eq!(models[0].adaptive_thinking, Some(true));
}
#[test] fn egress_guard_allows_only_loopback_without_the_opt_in() {
    assert_eq!(check_egress("https://api.anthropic.com", false, false).unwrap_err().kind, ProviderErrorKind::EgressRefused);
    assert!(check_egress("http://127.0.0.1:4000", false, false).is_ok());
    assert!(check_egress("https://api.anthropic.com", true, true).is_err());
    assert!(check_egress("https://api.anthropic.com", true, false).is_ok());
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kubepit-core --test ai_anthropic`
Expected: FAIL to compile. `ai::anthropic` is not defined.

- [ ] **Step 3: Implement `provider.rs`, `sse.rs` and the harness additions**

- `with_retries`:
  - retries `RateLimited`, `Overloaded`, `Server`, `Network` and connect `Timeout` only when `partial` is `None`, or has empty text and no tool calls;
  - delay = `retry_after.min(retry_after_cap)` if set, else `min(base · 2^(n-1), cap)` ± 20 % jitter;
  - emits `StreamEvent::Retrying` before each wait.
- Status mapping: 401/403 → Auth; 400/413 → BadRequest; 404 → NotFound; 429 → RateLimited; 529 → Overloaded; other 5xx → Server.
- Parse `retry-after` in seconds.

- [ ] **Step 4: Implement `anthropic.rs`**

- **Body** (D11/D12):
  - `system: [{type:"text", text, cache_control:{type:"ephemeral"}}]`;
  - user `Text { cache: true }` blocks carry `cache_control`;
  - all `ToolResult` blocks of a user message go in one message: `tool_result` with `tool_use_id`, `content`, `is_error`;
  - assistant turns send `raw` unchanged;
  - `tools`: `{name, description, input_schema}`, sorted by name, plus `eager_input_streaming: true` only when `base_url == "https://api.anthropic.com"`;
  - top-level `cache_control: {type:"ephemeral"}`;
  - `thinking` / `output_config.effort` only when `model_info` says `Some(true)`;
  - `fallbacks: "default"` while the `AtomicBool` is set.
- **Stream loop:**
  - handle `message_start`, `content_block_start` (`text`, `thinking`, `redacted_thinking`, `tool_use`, `fallback`), `content_block_delta` (`text_delta`, `thinking_delta`, `signature_delta`, `input_json_delta`), `content_block_stop`, `message_delta`, `message_stop`, `ping` and `error`;
  - rebuild `raw` blocks as they are received;
  - `serde_json::from_str` strictly on each tool input at block stop;
  - `max_tokens` or `refusal` → clear `tool_calls`.
- **Timeouts:** `tokio::time::timeout` per chunk (first event / idle) and overall.
- **Cancellation:** `tokio::select!` on `cancel.cancelled()`.
- **Fallback retry:** on 400 whose message contains `fallbacks`, clear the flag and retry once.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p kubepit-core --test ai_anthropic && cargo test -p kubepit-core --test fake_apiserver`
Expected: PASS. The fake API server tests are unaffected by the harness changes.

- [ ] **Step 6: Commit**

```bash
git add crates/kubepit-core/Cargo.toml Cargo.lock crates/kubepit-core/src/ai crates/kubepit-core/tests/support crates/kubepit-core/tests/ai_anthropic.rs
git commit -m "feat(core): provider trait, fake provider server and the Anthropic Messages API provider"
```

---

### Task 5: OpenAI-compatible and Ollama providers

**Files:**
- Create: `crates/kubepit-core/src/ai/openai.rs`, `crates/kubepit-core/src/ai/ollama.rs`
- Modify: `crates/kubepit-core/tests/support/llm.rs`
- Test: `crates/kubepit-core/tests/ai_openai_ollama.rs`

**Interfaces:**
- Consumes: the Task 4 `Provider`, `ChatRequest`, `with_retries`, `SseParser`, `check_egress`, `Reply::Sse`.
- Produces:
  - `support::llm::openai_stream(chunks: &[Value]) -> Reply`: unnamed SSE `data:` events, then `data: [DONE]`
  - `support::llm::ollama_stream(lines: &[Value]) -> Reply`: NDJSON through the existing `Reply::Stream`
  - `OpenAiCompatProvider::new(client, base_url: String, api_key: Option<String>, timeouts: AiTimeouts, retry: RetryPolicy) -> Self`, `request_body(&self, &ChatRequest) -> Value`
  - `OllamaProvider::new(client, base_url: String, context_window: u32, timeouts: AiTimeouts, retry: RetryPolicy) -> Self`, `request_body(&self, &ChatRequest) -> Value`

- [ ] **Step 1: Write the failing tests**

```rust
#[tokio::test] async fn openai_streams_text_tool_calls_and_usage() {
    // deltas: content "Look", tool_calls[{index:0,id:"c1",function:{name:"get_events",arguments:"{\"names"}}],
    // tool_calls[{index:0,function:{arguments:"pace\":\"shop\"}"}}], finish_reason "tool_calls",
    // usage chunk {prompt_tokens:900, completion_tokens:40, prompt_tokens_details:{cached_tokens:512}}, [DONE]
    assert!(matches!(turn.stop, StopReason::ToolUse));
    assert_eq!(turn.tool_calls[0].input.as_ref().unwrap()["namespace"], "shop");
    assert_eq!(turn.usage, AiUsage { input_tokens: 900, output_tokens: 40, cache_read_tokens: 512, cache_write_tokens: 0 });
}
#[tokio::test] async fn openai_sends_bearer_only_with_a_key_and_asks_for_usage() {
    assert_eq!(header(&req, "authorization"), "Bearer k"); assert_eq!(body["stream_options"]["include_usage"], true);
    // second provider without key: no authorization header
}
#[test] fn openai_folds_context_into_the_first_user_message_and_tool_results_into_tool_messages() {
    assert_eq!(body["messages"][0]["role"], "system");
    assert!(body["messages"][1]["content"].as_str().unwrap().starts_with("<context>"));
    assert_eq!(body["messages"][3]["role"], "tool"); assert_eq!(body["messages"][3]["tool_call_id"], "c1");
}
#[test] fn openai_finish_reasons_map_to_stop_reasons() { /* length → MaxTokens, content_filter → Refusal{None} */ }
#[tokio::test] async fn ollama_streams_ndjson_sets_num_ctx_and_synthesizes_call_ids() {
    assert_eq!(body["options"]["num_ctx"], 8192); assert_eq!(body["stream"], true);
    assert_eq!(turn.tool_calls[0].id, "call_1"); assert_eq!(turn.usage.input_tokens, 321);
}
#[tokio::test] async fn ollama_lists_local_models_and_is_local_on_loopback() {
    assert_eq!(models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), vec!["llama3.1:8b", "qwen2.5-coder:7b"]);
    assert!(provider.is_local());
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kubepit-core --test ai_openai_ollama`
Expected: FAIL to compile. The providers are not defined.

- [ ] **Step 3: Implement both providers**

- **OpenAI-compatible:**
  - request: `POST {base}/chat/completions` with `{model, stream:true, stream_options:{include_usage:true}, max_tokens, messages, tools?}`;
  - the context block and the text of the first user message are joined with `"\n\n"`;
  - assistant turns go back as `{role:"assistant", content, tool_calls}`;
  - tool results go back as `{role:"tool", tool_call_id, content}`, with `is_error` results prefixed `"ERROR: "`;
  - tool deltas accumulate by `index`;
  - `list_models`: `GET {base}/models`.
- **Ollama:**
  - request: `POST {base}/api/chat` with `{model, stream:true, messages, tools?, options:{num_ctx, num_predict: max_tokens}}`;
  - parse NDJSON lines until `done:true`: `done_reason` `length` → MaxTokens; `prompt_eval_count` / `eval_count` → usage;
  - tool calls get `call_<n>` ids;
  - `list_models`: `GET {base}/api/tags` → `models[].name`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p kubepit-core --test ai_openai_ollama`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add crates/kubepit-core/src/ai/{openai,ollama}.rs crates/kubepit-core/src/ai.rs crates/kubepit-core/tests/support/llm.rs crates/kubepit-core/tests/ai_openai_ollama.rs
git commit -m "feat(core): OpenAI-compatible and Ollama assistant providers"
```

---

### Task 6: Read-only tools

**Files:**
- Create: `crates/kubepit-core/src/ai/tools.rs`, `crates/kubepit-core/src/ai/logs.rs`
- Modify: `crates/kubepit-core/src/logs.rs` (after `pod_logs_stop`): `pod_logs_tail`
- Test: `crates/kubepit-core/tests/ai_tools.rs`

**Interfaces:**
- Consumes: `Kubepit::{resource_list, resource_get, resource_events, metrics_pods, metrics_nodes, api_resources, prometheus_status, prometheus_query_range}`, `logs::log_params`, `ToolSpec` (Task 4).
- Produces:
  - `Kubepit::pod_logs_tail(&self, cluster_id: &str, namespace: &str, pod: &str, container: Option<&str>, tail_lines: i64, previous: bool) -> Result<String>`: `follow: false`, `timestamps: true`, `limit_bytes: 1 MiB`
  - `ai::logs::condense_log_text(text: &str, max_lines: usize) -> String`
  - `ai::tools`:
    - `tool_specs(prometheus: bool) -> Vec<ToolSpec>`, sorted: `get_events`, `get_metrics`, `get_pod_logs`, `get_resource`, `list_resources`, `query_prometheus` (the last only when `true`)
    - `enum ToolInput { Events { namespace: Option<String>, kind: Option<String>, name: Option<String> }, Metrics { namespace: Option<String>, pod: Option<String> }, PodLogs { namespace: String, pod: String, container: Option<String>, previous: bool, tail_lines: u32 }, Get { kind: String, namespace: Option<String>, name: String }, List { kind: String, namespace: Option<String>, label_selector: Option<String>, field_selector: Option<String> }, Prometheus { query: String, range: PromToolRange } }`
    - `enum PromToolRange { M15, H1, H6 }` (serde `"15m"`, `"1h"`, `"6h"`), mapped to the existing `PrometheusRange`; `previous` defaults to `false` and `tail_lines` to 200
    - `parse_input(name: &str, input: &serde_json::Value) -> Result<ToolInput, String>`
    - `struct ReadOnlyCluster { app: Arc<Kubepit>, cluster_id: String }` with `new(app, cluster_id)` and `async fn execute(&self, input: &ToolInput) -> ToolOutput`
    - `ToolOutput { text: String, is_error: bool }`
    - consts `MAX_TOOL_RESULT_BYTES = 32 * 1024`, `MAX_LIST_ROWS = 200`, `MAX_EVENTS = 100`, `MAX_TAIL_LINES = 500`, `MAX_LOG_OUTPUT_LINES = 200`, `MAX_PROM_SERIES = 20`

- [ ] **Step 1: Write the failing tests** (`tests/ai_tools.rs`, router modelled on `fake_apiserver.rs::cluster_router` with pods, events, Secrets, ConfigMaps and logs)

```rust
#[tokio::test] async fn tools_only_issue_get_requests() {
    for input in every_tool_input() { let _ = tools.execute(&input).await; }
    assert!(log.lock().iter().all(|r| r.method == "GET"), "{:?}", log.lock());
}
#[tokio::test] async fn secret_values_never_appear_in_tool_results() {
    let get = tools.execute(&ToolInput::Get { kind: "Secret".into(), namespace: Some("shop".into()), name: "db".into() }).await;
    let list = tools.execute(&ToolInput::List { kind: "Secret".into(), namespace: Some("shop".into()), label_selector: None, field_selector: None }).await;
    for out in [&get.text, &list.text] { assert!(!out.contains("aHVudGVyMg==") && !out.contains("hunter2")); }
    assert!(get.text.contains("PASSWORD"), "key names stay");
}
#[tokio::test] async fn forbidden_reads_become_tool_errors() {
    let out = tools.execute(&ToolInput::List { kind: "Pod".into(), namespace: None, label_selector: None, field_selector: None }).await;
    assert!(out.is_error && out.text.contains("forbidden"));
}
#[tokio::test] async fn pod_logs_are_tailed_and_condensed() {
    let out = tools.execute(&ToolInput::PodLogs { namespace: "shop".into(), pod: "web-1".into(), container: None, previous: true, tail_lines: 500 }).await;
    let q = &log.lock().iter().find(|r| r.path.contains("/log")).unwrap().path;
    assert!(q.contains("tailLines=500") && q.contains("timestamps=true") && q.contains("previous=true"));
    assert!(out.text.lines().count() <= 200 && out.text.contains("(×"));
}
#[tokio::test] async fn results_are_capped() {
    let out = tools.execute(&list_configmaps()).await; // 1 000 items
    assert!(out.text.len() <= MAX_TOOL_RESULT_BYTES && out.text.contains("800 more"));
}
#[test] fn inputs_are_validated_strictly() {
    assert!(parse_input("get_pod_logs", &json!({"namespace":"a","pod":"b","tail_lines":501})).is_err());
    assert!(parse_input("get_resource", &json!({"kind":"Pod","name":"x","extra":1})).is_err());
    assert!(parse_input("get_pod_logs", &json!({"namespace":"a"})).is_err());
    assert!(parse_input("delete_pod", &json!({})).is_err());
}
#[test] fn tool_specs_are_sorted_and_closed() {
    let specs = tool_specs(true);
    assert!(specs.windows(2).all(|w| w[0].name < w[1].name));
    assert!(specs.iter().all(|s| s.schema["additionalProperties"] == json!(false)));
    assert!(!tool_specs(false).iter().any(|s| s.name == "query_prometheus"));
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kubepit-core --test ai_tools`
Expected: FAIL to compile. `ai::tools` is not defined.

- [ ] **Step 3: Implement `pod_logs_tail`, `condense_log_text` and the tools**

- **Kind resolution:** `api_resources(cluster_id)`. Match the kind or plural case-insensitively, core group first.
- **List rows:** `name  namespace  status  age`. The status is the pod phase with ready count, or the `.status.conditions` Ready type.
- **Get:** YAML without `managedFields`. Secret-like kinds reduce to `metadata` (labels, annotations without last-applied), `type` and `data_keys`.
- **Events:** table rows `last-seen type reason object count message`, Warnings first, ≤ 100.
- **Condenser** (the Rust counterpart of Task 11):
  - replace digits, hex (≥ 8 chars) and UUIDs with `#` to build a line key;
  - collapse consecutive equal keys as `(×N)`;
  - keep lines whose level token is error, fatal or panic, or that contain `Exception` / `Traceback`;
  - fill the rest from the tail, up to `max_lines`.
- **Cap:** truncate at `MAX_TOOL_RESULT_BYTES` with `… truncated`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p kubepit-core --test ai_tools`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add crates/kubepit-core/src/ai/{tools,logs}.rs crates/kubepit-core/src/ai.rs crates/kubepit-core/src/logs.rs crates/kubepit-core/tests/ai_tools.rs
git commit -m "feat(core): read-only assistant tools (list, get, events, logs, metrics, PromQL)"
```

---

### Task 7: AI request log in `history.db`

**Files:**
- Modify: `crates/kubepit-core/src/history/db.rs`:
  - `:32-105`: append migration `(2, "CREATE TABLE ai_log …")` exactly as in spec §7.4;
  - add `insert_ai`, `list_ai`, `get_ai`, `export_ai`;
  - `:458-479`: `clear` handles `Ai`, and `All` includes `ai_log`;
  - `:531-568`: `prune` deletes `ai_log` rows older than `audit_before` and, under the size cap, after events and changes but before `audit`; `PruneReport.ai`.
- Modify: `crates/kubepit-core/src/history/types.rs:399-407`: `HistoryKind::Ai`, the AI log types, `HistoryStatus.ai`
- Modify: `crates/kubepit-core/src/history/writer.rs:30-47`: `WriteOp::Ai(Box<AiLogRecord>)`, counted in `is_data`
- Modify: `crates/kubepit-core/src/history.rs`: `ai_log_record`, `ai_log_list`, `ai_log_get`, `ai_log_export`; `history_status` fills `ai`
- Modify: `apps/desktop/src/types/index.ts` (`HistoryKind` adds `'ai'`, `HistoryStatus.ai`) and `apps/desktop/src/lib/ipc/mock/history.ts` (the status carries `ai`)
- Test: `crates/kubepit-core/tests/ai_log.rs`, plus unit tests in `history/db.rs`

**Interfaces:**
- Consumes: `AiIntent` (Task 3), `AiUsage` (Task 1), writer queue and read connection (existing).
- Produces:
  - `AiLogOutcome` (lowercase `ok`, `error`, `cancelled`, `refused`)
  - `AiLogRecord { ts: i64, cluster_id: Option<String>, cluster_name: Option<String>, provider_id: String, model: String, intent: AiIntent, outcome: AiLogOutcome, error: Option<String>, duration_ms: i64, usage: AiUsage, cost: Option<f64>, tool_calls: u32, request: String, response: String, tools: serde_json::Value }`
  - `AiLogEntry` (the record without `request` / `response` / `tools`, plus `id`); `AiLogDetail { entry: AiLogEntry, request, response, tools }`
  - `AiLogFilter { cluster_ids: Vec<String>, text: Option<String>, since: Option<i64>, cursor: Option<String>, limit: u32 }` (`Default`: empty filters, `limit: 100`; `limit` is clamped to `MAX_PAGE`)
  - `AiLogPage { entries: Vec<AiLogEntry>, next_cursor: Option<String>, total: u64, usage: AiUsage, cost: Option<f64> }`
  - `pub const MAX_AI_REQUEST_BYTES: usize = 256 * 1024; pub const MAX_AI_RESPONSE_BYTES: usize = 64 * 1024;`
  - `Kubepit::{ai_log_record(&self, record: AiLogRecord) -> bool, ai_log_list(&self, filter: &AiLogFilter) -> Result<AiLogPage>, ai_log_get(&self, id: i64) -> Result<AiLogDetail>, ai_log_export(&self, filter: &AiLogFilter) -> Result<String>}`
  - `ai_log_record` writes only when `history.is_active()` and `settings().ai.log_requests`, capping bodies with the suffix `\n[truncated: N bytes]`.

- [ ] **Step 1: Write the failing tests**

```rust
// history/db.rs tests
#[test] fn ai_log_pages_newest_first_with_usage_totals() { /* 3 rows → entries ts desc; page.usage.input_tokens == sum; cost sum; cursor paging */ }
#[test] fn clear_ai_only_touches_the_ai_log() { /* audit row + ai row → clear(Ai) leaves audit */ }
#[test] fn prune_uses_the_audit_cutoff_and_drops_ai_rows_before_audit_under_the_size_cap() { }
// tests/ai_log.rs
#[tokio::test] async fn records_only_when_history_records_and_logging_is_on() {
    assert!(!app.ai_log_record(record(1)));             // recording off in tests by default
    app.set_history_recording(true);
    assert!(app.ai_log_record(record(2)) && app.history_flush());
    let mut s = app.settings(); s.ai.log_requests = false; app.set_settings(s).unwrap();
    assert!(!app.ai_log_record(record(3)) && app.history_flush());
    assert_eq!(app.ai_log_list(&AiLogFilter::default()).unwrap().total, 1);
}
#[tokio::test] async fn oversized_bodies_are_capped_and_export_is_json_lines() {
    let d = app.ai_log_get(id).unwrap();
    assert!(d.request.len() <= MAX_AI_REQUEST_BYTES + 64 && d.request.contains("[truncated:"));
    let export = app.ai_log_export(&AiLogFilter::default()).unwrap();
    assert!(export.lines().all(|l| serde_json::from_str::<Value>(l).is_ok()));
}
#[tokio::test] async fn history_clear_ai_and_status_counts() {
    assert_eq!(app.history_status().ai.rows, 1);
    app.history_clear(HistoryKind::Ai, None).unwrap();
    assert_eq!(app.history_status().ai.rows, 0);
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kubepit-core --test ai_log && cargo test -p kubepit-core --lib history::db`
Expected: FAIL to compile. `AiLogRecord` and `HistoryKind::Ai` are not defined.

- [ ] **Step 3: Implement the migration, the writer op, the queries and the entry points**

- Build `search` from cluster name, model, intent and the first 2 KiB of the response.
- Store `tools` as JSON text.
- Export includes the bodies; it is the audit trail of what left the machine.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p kubepit-core --test ai_log --test history && cargo test -p kubepit-core --lib history && pnpm typecheck`
Expected: PASS. The existing migration test still counts `MIGRATIONS.len()`.

- [ ] **Step 5: Commit**

```bash
git add crates/kubepit-core/src/history.rs crates/kubepit-core/src/history apps/desktop/src/types/index.ts apps/desktop/src/lib/ipc/mock/history.ts crates/kubepit-core/tests/ai_log.rs
git commit -m "feat(core): assistant request log in history.db (migration 2)"
```

---

### Task 8: Session engine — preview, send, tool consent, limits, cancellation, cost

**Files:**
- Create: `crates/kubepit-core/src/ai/session.rs`, `crates/kubepit-core/src/ai/pricing.rs`
- Modify: `crates/kubepit-core/src/ai.rs`:
  - `AiState` gains previews, sessions, `runs: TaskRegistry`, pending decisions, model-info cache, rate limiter, timeouts and retry policy;
  - new entry points below.
- Modify: `crates/kubepit-core/src/ai/types.rs`: `AiPreview`, `AiEvent`, `AiToolCall`, `AiToolStatus`, `AiToolDecision`, `AiStop`
- Modify: `crates/kubepit-core/src/connection.rs:382-390`: `stop_cluster_work` calls `self.ai_stop_cluster(id)`
- Modify: `crates/kubepit-core/src/cluster.rs`: `ai_forget_cluster` also ends the cluster's sessions
- Test: `crates/kubepit-core/tests/ai_session.rs`

**Interfaces:**
- Consumes:
  - Tasks 1–7: `AiSettings`, `keys::read_key`, `context::render`, `prompts::*`, `redact::*`;
  - the providers (`AnthropicProvider`, `OpenAiCompatProvider`, `OllamaProvider`);
  - `with_retries`, `check_egress`, `tools::{tool_specs, parse_input, ReadOnlyCluster}`;
  - `ai_log_record`.
- Produces (types):
  - `AiPreview { preview_id, session_id, provider_id, provider_kind, model, local, production, cluster_name: Option<String>, message, sections: Vec<AiPreviewSection>, earlier_messages: u32, system_tokens: u32, tools: Vec<String>, estimated_input_tokens: u32, context_window: u32, budget: u32, estimated_cost: Option<f64>, placeholders: BTreeMap<String, String>, expires_at: i64 }`
  - `#[serde(tag = "type", rename_all = "kebab-case")] enum AiEvent { Started { run_id, model }, Text { delta }, Thinking, ToolCall { call: AiToolCall }, ToolResult { call_id, status: AiToolStatus, tokens: u32, redactions: RedactionCounts }, Retrying { attempt, delay_ms, reason }, Fallback { from_model, to_model }, Usage { usage: AiUsage }, Done { stop: AiStop, usage: AiUsage, cost: Option<f64>, placeholders: BTreeMap<String, String> }, Error { message, retryable: bool } }`
  - `AiToolCall { id, name, input: Value, status: AiToolStatus, result_preview: Option<String> }`
  - `AiToolStatus` (`running`, `pending-approval`, `done`, `denied`, `error`); `AiToolDecision` (`send`, `send-session`, `deny`); `AiStop` (`end`, `max-tokens`, `refusal`, `cancelled`, `tool-limit`, `error`)
- Produces (functions):
  - `Kubepit::ai_models(&self, provider_id: &str) -> Result<Vec<AiModelInfo>>` (async)
  - `Kubepit::ai_preview(&self, request: AiRequest) -> Result<AiPreview>`
  - `Kubepit::ai_send<F>(self: &Arc<Self>, preview_id: &str, on_event: F) -> Result<String> where F: Fn(AiEvent) -> bool + Send + Sync + 'static`
  - `Kubepit::ai_tool_decision(&self, run_id: &str, call_id: &str, decision: AiToolDecision) -> Result<()>`
  - `Kubepit::ai_cancel(&self, run_id: &str) -> bool`, `Kubepit::ai_session_end(&self, session_id: &str)`
  - `Kubepit::set_ai_timeouts(&self, timeouts: AiTimeouts, retry: RetryPolicy)`
  - `pub(crate) Kubepit::ai_stop_cluster(&self, cluster_id: &str)`
  - `pricing::cost(usage: &AiUsage, price: Option<&AiPrice>) -> Option<f64>`: `(in · p_in + out · p_out + cw · (p_cw or p_in) + cr · (p_cr or p_in)) / 1e6`
  - `pricing::price_for<'a>(prices: &'a [AiPrice], model: &str) -> Option<&'a AiPrice>`
  - `session::RateLimiter::new(max: u32, window: Duration)` with `acquire(&self, now: Instant) -> Option<Duration>` (the wait)
  - consts `PREVIEW_TTL = 600 s`, `MAX_PREVIEWS = 32`, `MAX_SESSIONS = 20`, `SESSION_IDLE = 7200 s`, `MAX_TOOL_ROUNDS = 8`, `MAX_TOOL_CALLS_PER_ROUND = 16`, `REQUESTS_PER_MINUTE = 30`

- [ ] **Step 1: Write the failing tests** (`tests/ai_session.rs`: fake API server and fake provider on two ports; provider `anthropic` pointed at the fake provider via settings; `set_ai_timeouts` with a fast retry policy; `ai.enabled = true`; the cluster enabled)

```rust
#[tokio::test] async fn the_preview_is_exactly_what_is_sent() {
    let preview = app.ai_preview(explain_request(&cluster)).unwrap();
    let events = send_and_collect(&app, &preview.preview_id).await;
    let body: Value = serde_json::from_str(&provider_log.lock()[0].body).unwrap();
    let context = body["messages"][0]["content"][0]["text"].as_str().unwrap();
    for s in preview.sections.iter().filter(|s| !s.excluded) { assert!(context.contains(&s.text)); }
    assert!(body["messages"][0]["content"][1]["text"].as_str().unwrap().ends_with(&preview.message));
    assert!(matches!(events.last(), Some(AiEvent::Done { stop: AiStop::End, .. })));
}
#[tokio::test] async fn a_preview_is_single_use() { /* second ai_send(preview_id) → Err "preview expired" */ }
#[tokio::test] async fn refusals_happen_before_any_network_call() {
    // ai.enabled=false → Err; cluster not enabled → Err containing "not enabled"; local_only + anthropic → Err containing "local-only"
    assert!(provider_log.lock().is_empty());
}
#[tokio::test] async fn a_missing_key_fails_fast() { /* no key → ai_send Err containing "API key"; provider log empty */ }
#[tokio::test] async fn tool_results_wait_for_consent_and_denials_are_reported() {
    // reply 1: tool_use get_events {namespace:"shop"}; reply 2: text
    let pending = wait_for(&rx, |e| matches!(e, AiEvent::ToolCall { call } if call.status == AiToolStatus::PendingApproval)).await;
    assert_eq!(provider_log.lock().len(), 1);
    app.ai_tool_decision(&run_id, &call_id, AiToolDecision::Deny).unwrap();
    wait_done(&rx).await;
    let body: Value = serde_json::from_str(&provider_log.lock()[1].body).unwrap();
    let last = body["messages"].as_array().unwrap().last().unwrap();
    assert_eq!(last["content"][0]["is_error"], true);
    assert!(last["content"][0]["content"].as_str().unwrap().contains("declined"));
}
#[tokio::test] async fn send_for_session_stops_asking() { }
#[tokio::test] async fn all_tool_results_of_a_turn_go_back_in_one_user_message() { /* two tool_use blocks → one user msg, two tool_result */ }
#[tokio::test] async fn invalid_tool_json_is_returned_as_an_error_result_without_running() { /* Err(raw) → tool_result is_error content {"INVALID_JSON": raw}; fake API server log has no request */ }
#[tokio::test] async fn thinking_blocks_are_echoed_back_unchanged() { }
#[tokio::test] async fn tool_rounds_are_capped() {
    // provider always answers tool_use, policy session
    assert_eq!(provider_log.lock().len(), 9);
    assert!(matches!(done, AiEvent::Done { stop: AiStop::ToolLimit, .. }));
}
#[tokio::test] async fn the_prompt_prefix_is_stable_across_turns() {
    // turn 1 explain, turn 2 typed follow-up (preview has no sections, earlier_messages == 2)
    assert_eq!(b1["system"], b2["system"]); assert_eq!(b1["messages"][0], b2["messages"][0]); assert_eq!(b1["tools"], b2["tools"]);
}
#[tokio::test] async fn usage_and_cost_follow_the_price_table() {
    // price {input 5.0, output 25.0}; usage 1_000_000 in / 100_000 out → cost Some(7.5); no price → None
}
#[tokio::test] async fn closing_the_channel_or_cancelling_stops_the_run() {
    // on_event returns false after the first Text → no second provider request; ai_cancel on another run → true and Done{Cancelled}
}
#[tokio::test] async fn disconnect_during_tool_consent_cancels_the_run() {
    // pending approval, then app.cluster_disconnect(&cluster)
    assert!(matches!(wait_done(&rx).await, AiEvent::Done { stop: AiStop::Cancelled, .. }));
    assert_eq!(provider_log.lock().len(), 1);
    assert!(app.ai_tool_decision(&run_id, &call_id, AiToolDecision::Send).is_err());
}
#[tokio::test] async fn runs_are_logged_with_the_redacted_payload() { /* set_history_recording(true) → ai_log_get(id).request contains "__SECRET__", not "hunter2" */ }
#[test] fn rate_limiter_spaces_requests() {
    let l = RateLimiter::new(30, Duration::from_secs(60)); let t = Instant::now();
    for _ in 0..30 { assert!(l.acquire(t).is_none()); }
    assert!(l.acquire(t).unwrap() > Duration::ZERO);
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kubepit-core --test ai_session`
Expected: FAIL to compile. `ai_preview` and `ai_send` are not defined.

- [ ] **Step 3: Implement `pricing.rs` and `ai_preview`**

`ai_preview` performs these steps in order:
1. Check enabled, provider allowed (`check_egress`) and cluster enabled (with the production acknowledgement recorded in `clusters`).
2. Get or create the session. The session is keyed by `session_id` and fixes the cluster, provider, model, tools and locale.
3. Resolve the model info: from the cache, else `AnthropicProvider::model_info` (no cluster data).
4. Budget = `min(max_context_tokens, window − max_output) − system_tokens − history_tokens`.
5. `context::render` with the session's `Pseudonyms`.
6. Store the preview.
7. Return it with `estimated_cost` from `pricing` on the input estimate.

- [ ] **Step 4: Implement `session.rs` (the run loop) and the other entry points**

Spawn under `runs` with id `ai:<uuid>` tagged with the cluster. Then loop:
1. Rate-limit (sleep for the returned wait).
2. `with_retries(provider.chat)`, forwarding each `StreamEvent` as `AiEvent`. Stop when `on_event` returns `false`, which cancels the token.
3. Push `ChatMessage::Assistant(turn)`.
4. Map `turn.stop`:
   - `ToolUse` → a tool round;
   - `EndTurn` → `End`;
   - `MaxTokens` → `MaxTokens`;
   - `Refusal` → `Refusal`.
5. Tool round, for each call (≤ 16):
   - emit `Running`;
   - `parse_input` (an error becomes an `is_error` result with `serde_json::json!({"INVALID_JSON": raw})`);
   - `ReadOnlyCluster::execute`, then `redact_text` with the session pseudonyms;
   - under `ask` and not session-approved: emit `PendingApproval` with `result_preview` and await a `oneshot` stored under `(run_id, call_id)`;
   - `Deny` → `is_error` "The user declined to share this result.";
   - `SendSession` → set the session flag.
6. Push one `ChatMessage::User` holding every `ToolResult`, then loop. The 9th response that still asks for tools ends with `ToolLimit`.

On every exit — cancellation included, via a drop guard:
- emit `Done` (if the channel is open) with the summed usage, the cost and `restore_map`;
- call `ai_log_record` with the serialized request bodies (as sent) and the response text.

Other entry points:
- `ai_stop_cluster`: stop the runs of the cluster (`TaskRegistry::stop_cluster`) and drop its pending decisions.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p kubepit-core --test ai_session && cargo test -p kubepit-core`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add crates/kubepit-core/src/ai.rs crates/kubepit-core/src/ai crates/kubepit-core/src/connection.rs crates/kubepit-core/src/cluster.rs crates/kubepit-core/tests/ai_session.rs
git commit -m "feat(core): assistant sessions with previews, tool consent, limits and cost"
```

---

### Task 9: IPC surface and the TS contract

**Files:**
- Create: `apps/desktop/src-tauri/src/ipc/ai.rs`
- Modify:
  - `apps/desktop/src-tauri/src/ipc/mod.rs`: `mod ai; pub use ai::*;`
  - `apps/desktop/src-tauri/src/lib.rs:51-216`: register `ai_status`, `ai_key_set`, `ai_key_delete`, `ai_models`, `ai_cluster_set`, `ai_preview`, `ai_send`, `ai_tool_decision`, `ai_cancel`, `ai_session_end`, `ai_log_list`, `ai_log_get`, `ai_log_export`
  - `apps/desktop/src-tauri/src/setup.rs:25-31`: `core.set_ai_remote_providers(true);` with the comment `// ... and may reach remote model providers the user configured (see ai.rs).`
  - `apps/desktop/src/types/index.ts`: the remaining AI types from Tasks 1, 3, 7 and 8 (`AiStatus`, `AiProviderStatus`, `AiUsage`, `AiModelInfo`, the request, preview, event and log types)
  - `apps/desktop/src/lib/ipc.ts`: `// -- Assistant` block

**Interfaces:**
- Consumes: the Task 1/7/8 `Kubepit` methods.
- Produces (`ipc.ts`):
  - `aiStatus(): Promise<AiStatus>`, `aiKeySet(providerId: string, key: string): Promise<AiStatus>`, `aiKeyDelete(providerId: string): Promise<AiStatus>`
  - `aiModels(providerId: string): Promise<AiModelInfo[]>`
  - `aiClusterSet(clusterId: ClusterId, enabled: boolean, acknowledgeProduction: boolean): Promise<Settings>`
  - `aiPreview(request: AiRequest): Promise<AiPreview>`
  - `aiSend(previewId: string, onEvent: (e: AiEvent) => void): Promise<string>` via `callWithChannel(..., 'onEvent', ...)`
  - `aiToolDecision(runId: string, callId: string, decision: AiToolDecision): Promise<void>`
  - `aiCancel(runId: string): Promise<boolean>`, `aiSessionEnd(sessionId: string): Promise<void>`
  - `aiLogList(filter: AiLogFilter): Promise<AiLogPage>`, `aiLogGet(id: number): Promise<AiLogDetail>`, `aiLogExport(filter: AiLogFilter): Promise<string>`
- Rust adapters follow `ipc/fleet.rs`: `ai_send(preview_id: String, on_event: Channel<AiEvent>, state) -> IpcResult<String>` calls `state.core.ai_send(&preview_id, move |e| on_event.send(e).is_ok())`. Keychain calls run through `blocking(...)`.

- [ ] **Step 1: Add the `ipc.ts` entries first** (they reference `AiStatus`, `AiRequest`, … not yet in `types/index.ts`)

- [ ] **Step 2: Run the typecheck to verify it fails**

Run: `pnpm typecheck`
Expected: FAIL with `Module '"@/types"' has no exported member 'AiStatus'` (and the others).

- [ ] **Step 3: Add the TS types (mirroring the serde names exactly), the Rust adapters, the handler registration and the setup opt-in**

- [ ] **Step 4: Verify both sides**

Run: `pnpm typecheck && cargo clippy --workspace --all-targets -- -D warnings && cargo fmt --all -- --check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/ipc/ai.rs apps/desktop/src-tauri/src/ipc/mod.rs apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/src/setup.rs apps/desktop/src/types/index.ts apps/desktop/src/lib/ipc.ts
git commit -m "feat(ipc): assistant commands and contract types"
```

---

### Task 10: Vitest and the demo assistant backend

**Files:**
- Create: `apps/desktop/vitest.config.ts` (`mergeConfig` with `vite.config.ts`, `test: { environment: 'node', include: ['src/**/*.test.ts'] }`)
- Modify: `apps/desktop/package.json` (`"test": "vitest run"`, devDependency `vitest`) and the root `package.json` (`"test": "pnpm --filter @kubepit/desktop test"`)
- Create: `apps/desktop/src/lib/ipc/mock/ai.ts`, `apps/desktop/src/lib/ipc/mock/fixtures/ai.ts`
- Modify: `apps/desktop/src/lib/ipc/mock/index.ts` (`import './ai';` before `'./history'`) and `apps/desktop/src/lib/ipc/mock/history.ts` (`history_clear` with `'ai'` clears the demo log)
- Test: `apps/desktop/src/lib/ipc/mock/ai.test.ts`

**Interfaces:**
- Consumes: `handlers`, `register` (`mock/registry.ts`), `sleep` (`mock/bus.ts`), the Task 9 types.
- Produces: demo handlers for every `ai_*` command. The demo mirrors the backend rules:
  - a preview is required and single-use;
  - `clusters` enablement, with production refused without the acknowledgement;
  - simple regex redaction of `hunter2`-style values and IPs;
  - canned answers per intent from `fixtures/ai.ts`, streamed 3–6 words at a time every 40 ms;
  - `explain` on a `CrashLoopBackOff` pod first issues a `get_events` tool call that waits for consent;
  - usage numbers, and a cost when the demo price table has the model;
  - Ollama shows "local".

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { handlers, register } from './registry';
import './ai';

register({
  settings_get: () => demoSettings({ enabled: true, clusters: ['c-dev'] }),
  cluster_list: () => [{ id: 'c-dev', name: 'dev-shared', environment: 'development' }, { id: 'c-prod', name: 'prod-eu-west-1', environment: 'production' }],
});

describe('demo assistant', () => {
  it('streams an answer after a preview and refuses a second send', async () => {
    const preview = await handlers.ai_preview!({ request: explainRequest('c-dev') }) as AiPreview;
    expect(preview.sections.some((s) => s.redactions.secrets > 0)).toBe(true);
    const events: AiEvent[] = [];
    await handlers.ai_send!({ previewId: preview.preview_id, onEvent: (e: AiEvent) => events.push(e) });
    await waitFor(() => events.some((e) => e.type === 'done' || (e.type === 'tool-call' && e.call.status === 'pending-approval')));
    expect(events[0]!.type).toBe('started');
    await expect(Promise.resolve().then(() => handlers.ai_send!({ previewId: preview.preview_id, onEvent: () => {} }))).rejects.toThrow();
  });
  it('refuses production clusters without an acknowledgement', () => {
    expect(() => handlers.ai_cluster_set!({ clusterId: 'c-prod', enabled: true, acknowledgeProduction: false })).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm install && pnpm test -- src/lib/ipc/mock/ai.test.ts`
Expected: FAIL with `Failed to resolve import "./ai"`.

- [ ] **Step 3: Implement `mock/ai.ts` and `fixtures/ai.ts`**

- Vitest runs in the node environment. `@/i18n/core` works there (it guards `window` / `document`). Tests that reach stores or `lib/ipc` mock them with `vi.mock`, and pure `lib/ai/**` modules do not import stores.
- Canned answers: EN and TR per intent, including a `yaml` fix block, a `sh` kubectl block, `promql` and `logql`.
- Demo strings shown by the UI go through `i18n` (the shell catalog). Answers are model output and stay untranslated fixtures, picked by locale.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test && pnpm typecheck && pnpm i18n:check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/vitest.config.ts apps/desktop/package.json package.json pnpm-lock.yaml apps/desktop/src/lib/ipc/mock/ai.ts apps/desktop/src/lib/ipc/mock/fixtures/ai.ts apps/desktop/src/lib/ipc/mock/index.ts apps/desktop/src/lib/ipc/mock/history.ts apps/desktop/src/lib/ipc/mock/ai.test.ts
git commit -m "feat(ui): Vitest and the demo assistant backend"
```

---

### Task 11: Explain-context gathering

**Files:**
- Create: `apps/desktop/src/lib/ai/context/logs.ts`, `apps/desktop/src/lib/ai/context/explain.ts` (pure builders), `apps/desktop/src/lib/ai/context/gather.ts` (I/O: `collectPodLogs`, `gatherExplainContext`)
- Test: `apps/desktop/src/lib/ai/context/logs.test.ts`, `apps/desktop/src/lib/ai/context/explain.test.ts`

**Interfaces:**
- Consumes:
  - `RecordIndex`, `parsedRecord`, `recordText` (`lib/logs/records.ts`); `LevelCounts` (`lib/logs/levels.ts`); `normalizeObject` (`lib/kube/normalize.ts`);
  - `useHealthStore`, `useAlertStore`, `ipc.{resourceList, resourceEvents, podLogsStream, podLogsStop, changesList, metricsPods}`.
- Produces:
  - `condenseLogs(raw: readonly string[], opts?: { maxLines?: number; maxErrors?: number; maxFrames?: number; tail?: number }): { text: string; lines: number; levels: LevelCounts; collapsed: number }`. Defaults: 200 / 60 / 30 / 40.
  - Builders returning `AiContextSection` (or `null` when empty). Ids and priorities follow spec §11. Labels are identifiers only (`pod/web-1`, `web-1/app@previous`).
    - `scopeSection({ cluster, status, namespace, obj })`, `objectSection(obj: KubeObject)`
    - `containersSection(pods: KubeObject[])`, `eventsSection(events: KubeObject[], label: string)`
    - `logsSection(pod: string, container: string, previous: boolean, raw: string[])`
    - `healthSection(findings: Finding[])`, `changesSection(entries: ChangeSummary[])`, `alertsSection(alerts: Alert[])`, `metricsSection(pods: KubeObject[], usage: PodMetric[])`
  - `worstPods(pods: KubeObject[], n?: number): KubeObject[]` (n = 3; by restarts desc, then not-ready)
  - `collectPodLogs(clusterId: ClusterId, namespace: string, pod: string, container: string, previous: boolean, timeoutMs?: number): Promise<string[]>`: `{ follow: false, tail_lines: 500, since_seconds: null, timestamps: true, previous }`; resolves on `done` or after 10 s (then stops the stream)
  - `gatherExplainContext(clusterId: ClusterId, gvk: Gvk, obj: KubeObject): Promise<AiContextSection[]>`

- [ ] **Step 1: Write the failing tests**

```ts
it('keeps every error record with its stack frames and the tail', () => {
  const out = condenseLogs([...infoLines(300), 'ERROR boom', '\tat a.B.c(B.java:1)', 'Caused by: x', ...infoLines(50)]);
  expect(out.text).toContain('ERROR boom'); expect(out.text).toContain('Caused by: x');
  expect(out.text.split('\n').length).toBeLessThanOrEqual(200 + 2);
});
it('collapses repeated messages with a count', () => {
  const out = condenseLogs(Array.from({ length: 50 }, (_, i) => `INFO GET /healthz 200 in ${i}ms`));
  expect(out.text).toMatch(/\(×50\)/); expect(out.collapsed).toBe(49);
});
it('reports level counts in the header', () => { expect(condenseLogs(['ERROR a', 'WARN b']).text.split('\n')[0]).toContain('error=1'); });
it('lists Warning events first and caps at 50 rows', () => { /* 80 events → 50 rows, first row type Warning */ });
it('strips managedFields and last-applied from the object section', () => { /* content has no managedFields */ });
it('ranks the worst pods by restarts, then not-ready', () => { });
it('reports lastState OOMKilled with exit code 137', () => { expect(containersSection([oomPod])!.content).toContain('OOMKilled (137)'); });
it('uses identifier-only labels', () => { expect(logsSection('web-1', 'app', true, ['x']).label).toBe('web-1/app@previous'); });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- src/lib/ai/context`
Expected: FAIL. The modules do not exist.

- [ ] **Step 3: Implement `logs.ts`, `explain.ts` and `gather.ts`**

- The header line reads `levels: error=N warn=N info=N …`.
- Collapse keys replace digits, hex and UUIDs with `#`.
- The condenser returns raw lines, with the ANSI codes and the Kubernetes prefix removed via `lineBody`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- src/lib/ai/context && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/ai/context
git commit -m "feat(ui): gather explain context with the structured log parser"
```

---

### Task 12: Suggestions, placeholders and the review hand-off

**Files:**
- Create: `apps/desktop/src/lib/ai/answer.ts`, `apps/desktop/src/lib/ai/placeholders.ts`, `apps/desktop/src/lib/ai/actions.ts`
- Modify:
  - `apps/desktop/src/store/useDockStore.ts:35-43`: create tab `reviewMode?: ApplyMode`
  - `apps/desktop/src/store/useDockStore.ts:421-433`: `dock.create` opts `{ review?: boolean; reviewMode?: ApplyMode }`; `reviewMode` implies review
  - `apps/desktop/src/components/workbench/dock/editor/CreateEditor.tsx:165-172`: `startDryRun(tab.yaml, tab.reviewMode ?? 'create', …)`, and clear `reviewMode` with `review`
- Test: `apps/desktop/src/lib/ai/answer.test.ts`, `apps/desktop/src/lib/ai/placeholders.test.ts`, `apps/desktop/src/lib/ai/actions.test.ts`

**Interfaces:**
- Consumes: `parseMarkdown` (`lib/markdown.ts`), `YAML.parseAllDocuments` (`yaml`), `dock` (`store/useDockStore.ts`).
- Produces:
  - `type AiSuggestion =
     | { kind: 'manifest'; yaml: string; objects: { apiVersion: string; kind: string; namespace: string | null; name: string }[]; blocked: 'secret' | null; placeholders: string[] }
     | { kind: 'kubectl'; command: string; blocked: 'secret' | null; placeholders: string[] }
     | { kind: 'promql'; query: string }
     | { kind: 'logql'; query: string }`
  - `suggestionForCode(lang: string, text: string): AiSuggestion | null`, `extractSuggestions(markdown: string): AiSuggestion[]`
  - `restorePlaceholders(text: string, map: Record<string, string>): { text: string; missing: string[] }`, `unrestorableMarkers(text: string): string[]`
  - `openSuggestion(clusterId: ClusterId, s: AiSuggestion, placeholders: Record<string, string>): Promise<{ ok: true } | { ok: false; reason: 'secret' | 'missing-placeholder' }>`
    - manifest → `dock.create(clusterId, firstNamespace, restoredYaml, { reviewMode: 'apply' })`
    - promql → `dock.promql(clusterId, query)`
    - logql → `dock.loki(clusterId, { query })`
    - kubectl → `navigator.clipboard.writeText(restored)`

- [ ] **Step 1: Write the failing tests**

```ts
it('extracts manifests, kubectl, PromQL and LogQL fences', () => {
  const s = extractSuggestions(answerWith(['yaml', deploymentPartial], ['sh', 'kubectl -n shop get pods'], ['promql', 'up'], ['logql', '{app="web"}']));
  expect(s.map((x) => x.kind)).toEqual(['manifest', 'kubectl', 'promql', 'logql']);
});
it('treats sh fences as kubectl only when the first command is kubectl', () => { expect(suggestionForCode('sh', 'helm list')).toBeNull(); });
it('ignores yaml fences without apiVersion, kind and name', () => { expect(suggestionForCode('yaml', 'replicas: 3')).toBeNull(); });
it('blocks manifests carrying secret or token markers', () => {
  expect(suggestionForCode('yaml', secretManifest('__SECRET__'))).toMatchObject({ blocked: 'secret' });
  expect(suggestionForCode('sh', 'kubectl create secret generic x --from-literal=p=__TOKEN__')).toMatchObject({ blocked: 'secret' });
});
it('restores IP and host placeholders and reports unknown ones', () => {
  expect(restorePlaceholders('host: __HOST_1__ ip: __IP_2__', { __HOST_1__: 'db.acme.internal' })).toEqual({ text: 'host: db.acme.internal ip: __IP_2__', missing: ['__IP_2__'] });
});
// actions.test.ts: the store pulls in window-bound modules, so mock it (Vitest runs in the node environment)
vi.mock('@/store/useDockStore', () => ({ dock: { create: vi.fn(() => 't1'), promql: vi.fn(), loki: vi.fn() } }));
it('never opens the review for blocked manifests and restores placeholders first', async () => {
  const spy = vi.mocked(dock.create);
  expect(await openSuggestion('c1', suggestionForCode('yaml', secretManifest('__SECRET__'))!, {})).toEqual({ ok: false, reason: 'secret' });
  expect(spy).not.toHaveBeenCalled();
  await openSuggestion('c1', suggestionForCode('yaml', ingressFor('__HOST_1__'))!, { __HOST_1__: 'shop.acme.io' });
  expect(spy.mock.calls[0]![2]).toContain('shop.acme.io');
  expect(spy.mock.calls[0]![3]).toEqual({ reviewMode: 'apply' });
});
it('refuses manifests whose placeholders cannot be restored', async () => { /* reason 'missing-placeholder' */ });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- src/lib/ai`
Expected: FAIL. The modules do not exist.

- [ ] **Step 3: Implement `answer.ts`, `placeholders.ts`, `actions.ts` and the dock/editor `reviewMode`**

- [ ] **Step 4: Run the tests and checks**

Run: `pnpm test -- src/lib/ai && pnpm typecheck`
Expected: PASS. In `pnpm dev:ui`, the Create resource wizard still opens its review in `create` mode (wizards pass no `reviewMode`).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/ai/{answer,placeholders,actions}.ts apps/desktop/src/lib/ai/*.test.ts apps/desktop/src/store/useDockStore.ts apps/desktop/src/components/workbench/dock/editor/CreateEditor.tsx
git commit -m "feat(ui): assistant suggestions hand off to the dry-run review, PromQL and Loki"
```

---

### Task 13: Assistant store and the right panel

**Files:**
- Create: `apps/desktop/src/lib/ai/reducer.ts`, `apps/desktop/src/lib/ai/scope.ts`, `apps/desktop/src/store/useAssistantStore.ts`
- Create: `apps/desktop/src/components/assistant/{AssistantPanel,MessageList,AssistantMessage,Composer,NotReady}.tsx`
- Modify:
  - `apps/desktop/src/store/types.ts:38`: `RightPanel` adds `'assistant'`
  - `apps/desktop/src/components/RightSidePanel.tsx:55-107`: mount-on-first-open like the alerts panel
  - `apps/desktop/src/components/RightActivityBar.tsx:27-49`: item `assistant` (`Sparkles`), rendered only when `settings.ai.enabled`
  - `apps/desktop/src/components/workbench/common/Markdown.tsx:16-35,79-84`: optional `renderCode?: (lang: string, text: string) => ReactNode | null` (fallback `CodeBlock`) and `variant?: 'readme' | 'chat'` (chat headings 12.5–13 px)
  - `apps/desktop/src/i18n/{en,tr}/shell.json`
- Test: `apps/desktop/src/lib/ai/reducer.test.ts`

**Interfaces:**
- Consumes: Task 9 `ipc.ai*`, Task 12 `suggestionForCode`, `i18n.getLocale()`, `useAppStore.selectedClusterId`, `useWorkbenchStore.{namespaces, activeKind, selection}`.
- Produces:
  - `interface AiMessage { id: string; role: 'user' | 'assistant'; intent: AiIntent; text: string; tools: AiToolCall[]; status: 'streaming' | 'done' | 'error' | 'cancelled'; stop: AiStop | null; usage: AiUsage | null; cost: number | null; model: string | null; fallback: { from: string; to: string } | null; retry: { attempt: number; delay_ms: number } | null; error: string | null; retryable: boolean; thinking: boolean; placeholders: Record<string, string> }`
  - `applyAiEvent(message: AiMessage, event: AiEvent): AiMessage`
  - `currentScope(): AiScope`
  - `useAssistantStore`:
    - state: `sessions: Record<string, { id: string; clusterId: ClusterId | null; messages: AiMessage[]; runId: string | null; origin: AiOrigin | null }>`, `activeSessionId: string | null`, `pendingPreview: AiPreview | null`, `pendingIntent: AiIntent | null`
    - actions: `ask(input: { intent: AiIntent; message: string; sections: AiContextSection[]; scope?: AiScope; origin?: AiOrigin }): Promise<void>`, `excludeSection(id: string): Promise<void>`, `send(): Promise<void>`, `cancelPreview(): void`, `stop(): void`, `decide(callId: string, decision: AiToolDecision): Promise<void>`, `newChat(): void`
    - `type AiOrigin = { kind: 'editor'; clusterId: ClusterId; tabId: string }`
    - `ask` opens the panel. A preview with no included sections is sent at once; otherwise it becomes `pendingPreview`.

- [ ] **Step 1: Write the failing test**

```ts
it('appends text deltas and marks thinking', () => {
  let m = empty(); m = applyAiEvent(m, { type: 'thinking' }); expect(m.thinking).toBe(true);
  m = applyAiEvent(m, { type: 'text', delta: 'Hel' }); m = applyAiEvent(m, { type: 'text', delta: 'lo' });
  expect(m.text).toBe('Hello'); expect(m.thinking).toBe(false);
});
it('upserts tool calls by id', () => { /* running → pending-approval → done keeps one entry */ });
it('finishes with usage, cost, stop and placeholders', () => { /* done → status 'done', stop 'end', cost 0.01 */ });
it('maps cancelled and error stops', () => { /* done stop cancelled → status 'cancelled'; error event → status 'error', retryable */ });
it('records fallbacks and retries', () => { });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- src/lib/ai/reducer.test.ts`
Expected: FAIL. `reducer.ts` does not exist.

- [ ] **Step 3: Implement the reducer, scope, store and panel components**

The panel follows spec §6:
- the header has scope chips, the model badge ("Local" for Ollama) and "New chat";
- `NotReady` covers: off, no key, cluster not enabled;
- the message list renders `Markdown variant="chat"` with `renderCode` → `SuggestionActions` (Task 14; render `CodeBlock` until then);
- the composer has an intent chip row (Explain selection, kubectl, PromQL, LogQL) and Send/Stop;
- `@container` layout.

Add the EN keys with `pnpm i18n:check -- --fix`, then the Turkish ones.

- [ ] **Step 4: Run the tests and checks**

Run: `pnpm test && pnpm typecheck && pnpm i18n:check`
Expected: PASS. In `pnpm dev:ui`: enable the assistant in Settings (Task 15; until then set `ai.enabled` in the mock defaults), open the rail item, and on `dev-shared` ask "why is checkout crashing?". The demo answer streams into the panel.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/ai/{reducer,scope}.ts apps/desktop/src/lib/ai/reducer.test.ts apps/desktop/src/store/useAssistantStore.ts apps/desktop/src/store/types.ts apps/desktop/src/components/assistant apps/desktop/src/components/RightSidePanel.tsx apps/desktop/src/components/RightActivityBar.tsx apps/desktop/src/components/workbench/common/Markdown.tsx apps/desktop/src/i18n
git commit -m "feat(ui): assistant side panel and session store"
```

---

### Task 14: Context preview, tool cards, usage line and cluster enablement

**Files:**
- Create: `apps/desktop/src/lib/ai/format.ts`
- Create: `apps/desktop/src/components/assistant/{ContextPreview,BudgetBar,ToolCallCard,UsageLine,SuggestionActions}.tsx` and `apps/desktop/src/components/assistant/enableCluster.ts`
- Modify: `apps/desktop/src/components/assistant/{AssistantPanel,AssistantMessage,NotReady}.tsx` and `apps/desktop/src/i18n/{en,tr}/shell.json`
- Test: `apps/desktop/src/lib/ai/format.test.ts`

**Interfaces:**
- Consumes: the Task 13 store, the Task 12 `openSuggestion`, `useAppStore.requestConfirm` (`typeToConfirm`), `ipc.aiClusterSet`.
- Produces:
  - `sectionKindLabel(kind: AiSectionKind): string` (translated)
  - `redactionSummary(c: RedactionCounts): string | null`: complete phrases via `i18n.plural`, joined with `Intl.ListFormat`
  - `usageSummary(u: AiUsage, cost: number | null, local: boolean): string`, e.g. `'1,234 in · 567 out · 890 cached · $0.012'`
  - `enableAssistantFor(cluster: ClusterDef): Promise<boolean>`: production → `requestConfirm({ …, typeToConfirm: cluster.name })`, then `aiClusterSet(id, true, true)`; others → `aiClusterSet(id, true, false)`
  - `SuggestionActions({ lang, text, message, clusterId })`: shows the translated reason on `blocked` / `missing-placeholder`, and "Use in editor" when the session origin is an editor tab (Task 17)

- [ ] **Step 1: Write the failing test**

```ts
it('summarizes redactions as a translated list', () => {
  i18n.setLocale('en', false);
  expect(redactionSummary({ secrets: 2, tokens: 1, ips: 0, hostnames: 0 })).toBe('2 secrets and 1 token');
  expect(redactionSummary({ secrets: 0, tokens: 0, ips: 0, hostnames: 0 })).toBeNull();
  i18n.setLocale('tr', false);
  expect(redactionSummary({ secrets: 1, tokens: 0, ips: 3, hostnames: 0 })).toBe('1 gizli değer ve 3 IP adresi');
});
it('formats usage with cost, without price and for local models', () => {
  i18n.setLocale('en', false);
  const u = { input_tokens: 1234, output_tokens: 567, cache_read_tokens: 890, cache_write_tokens: 0 };
  expect(usageSummary(u, 0.012, false)).toBe('1,234 in · 567 out · 890 cached · $0.012');
  expect(usageSummary(u, null, false)).toBe('1,234 in · 567 out · 890 cached');
  expect(usageSummary(u, null, true)).toBe('1,234 in · 567 out · local');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- src/lib/ai/format.test.ts`
Expected: FAIL. `format.ts` does not exist.

- [ ] **Step 3: Implement `format.ts` and the components**

- `ContextPreview` follows spec §6:
  - section rows with kind, label, "≈N tokens", a trimmed badge and the redaction summary;
  - expand to the exact monospace text, and exclude via checkbox → `excludeSection`;
  - `BudgetBar` is SVG: the used/budget/window marks use tokens;
  - a production banner, "N earlier messages already sent", provider/model and the estimated cost;
  - Send / Cancel.
- `ToolCallCard` shows the status pill and the result preview (collapsed), with "Send", "Send for this session" and "Don't send" under `pending-approval`.
- `UsageLine` shows `usageSummary` plus notes for `refusal`, `max-tokens`, `tool-limit`, fallback and retry.
- Under a finished `explain` answer, two follow-up chips send typed-only follow-ups without new context:
  - "Suggest a fix" (intent `fix`);
  - "Explain more" (intent `chat`).
- An `error` message with `retryable` offers "Retry", which re-asks the same request.

- [ ] **Step 4: Run the tests and checks**

Run: `pnpm test && pnpm typecheck && pnpm i18n:check`
Expected: PASS. In `pnpm dev:ui`:
- "Explain" on a CrashLoopBackOff pod shows the preview with redaction counts;
- Send streams the answer;
- the `get_events` card waits for "Send";
- the YAML fix shows "Review & apply";
- enabling `prod-eu-west-1` asks for the typed name.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/ai/format.ts apps/desktop/src/lib/ai/format.test.ts apps/desktop/src/components/assistant apps/desktop/src/i18n
git commit -m "feat(ui): context preview, tool consent cards, usage and cluster enablement"
```

---

### Task 15: Settings → Assistant

**Files:**
- Create: `apps/desktop/src/lib/ai/settingsIssues.ts`
- Create: `apps/desktop/src/components/settings/AssistantCategory.tsx` and `apps/desktop/src/components/settings/assistant/{ProvidersSection,PrivacySection,PricesSection,ClustersSection,RequestLogSection}.tsx`
- Modify:
  - `apps/desktop/src/store/types.ts:39`: `SettingsCategory` adds `'assistant'`
  - `apps/desktop/src/components/settings/SettingsView.tsx:38-140`: category entry after `history`
  - `apps/desktop/src/components/settings/SettingsView.tsx:210-222`: render
  - `apps/desktop/src/i18n/{en,tr}/shell.json`
- Test: `apps/desktop/src/lib/ai/settingsIssues.test.ts`

**Interfaces:**
- Consumes: `useSettingsDraft` (`components/settings/categories.tsx`), `ipc.{aiStatus, aiKeySet, aiKeyDelete, aiModels, aiLogList, aiLogGet, aiLogExport, historyClear, saveTextFile}`, Task 14 `enableAssistantFor`.
- Produces: `settingsIssues(ai: AiSettings, status: AiStatus | null): { field: string; message: string }[]`. Rules:
  - base URL not `http(s)://`;
  - OpenAI-compatible or Ollama model empty while active;
  - the active provider not allowed (local-only or remote egress);
  - the active remote provider without a key;
  - negative prices;
  - `max_context_tokens` out of 2 000–900 000.
  Messages are translated.

- [ ] **Step 1: Write the failing test**

```ts
it('flags an empty model for the active OpenAI-compatible provider', () => { expect(fields(settingsIssues(active('openai', { model: '' }), status()))).toContain('providers.openai.model'); });
it('flags a remote active provider under local-only mode', () => { expect(fields(settingsIssues({ ...ai(), local_only: true }, status()))).toContain('active_provider'); });
it('flags a missing key for the active remote provider', () => { });
it('accepts the defaults with a stored key', () => { expect(settingsIssues(ai(), status({ anthropic: true }))).toEqual([]); });
it('rejects non-http base URLs and negative prices', () => { });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- src/lib/ai/settingsIssues.test.ts`
Expected: FAIL. The module does not exist.

- [ ] **Step 3: Implement `settingsIssues.ts` and the category**

Sections per spec §6:
- the key input is `type="password"`, cleared after "Set", and never prefilled;
- "Fetch models" fills a `SearchableSelect`;
- the prices note says prices are not built in;
- clusters toggles call `enableAssistantFor` or `aiClusterSet(id, false, false)`;
- the request log lists entries with totals and expands to the request and response (monospace, `CopyableCodeBlock`), with "Export" (save dialog → `saveTextFile`) and "Clear" (`historyClear('ai', null)` behind `requestConfirm`).

- [ ] **Step 4: Run the tests and checks**

Run: `pnpm test && pnpm typecheck && pnpm i18n:check`
Expected: PASS. In `pnpm dev:ui`, Settings → Assistant toggles on; the rail item appears; the demo log lists the runs made in Task 14.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/ai/settingsIssues.ts apps/desktop/src/lib/ai/settingsIssues.test.ts apps/desktop/src/components/settings apps/desktop/src/store/types.ts apps/desktop/src/i18n
git commit -m "feat(ui): Settings → Assistant (providers, keys, privacy, prices, clusters, log)"
```

---

### Task 16: Entry points — explain actions, palette, PromQL and Loki

**Files:**
- Create: `apps/desktop/src/lib/ai/intents.ts`, `apps/desktop/src/components/workbench/actions/aiActions.ts`, `apps/desktop/src/components/palette/assistantItems.ts`
- Modify:
  - `apps/desktop/src/components/workbench/actions/resourceActions.tsx:168-176`: after `loki-logs`, add `{ id: 'ai-explain', icon: Sparkles, mutating: false }` when `explainable(kind)` and `settings.ai.enabled`
  - `apps/desktop/src/components/palette/paletteItems.tsx`: include `assistantItems()`
  - `apps/desktop/src/components/workbench/dock/promql/PromqlView.tsx:285-295` and `apps/desktop/src/components/workbench/dock/loki/LokiView.tsx:570-590`: "Explain query" (disabled on empty) and "Ask" (NL → query, prefilled into the editor via the suggestion action) beside Run
  - `apps/desktop/src/i18n/{en,tr}/{workbench,dock,shell}.json`
- Test: `apps/desktop/src/lib/ai/intents.test.ts`

**Interfaces:**
- Consumes: Task 11 `gatherExplainContext`, Task 13 `useAssistantStore.ask`, Task 12 suggestions.
- Produces:
  - `explainable(kind: string): boolean`: Pod, Deployment, StatefulSet, DaemonSet, ReplicaSet, Job, CronJob
  - `querySection(language: 'promql' | 'logql', query: string): AiContextSection`: kind `query`, priority 0, format `text`, label `promql` / `logql`
  - `nlRequest(intent: 'kubectl' | 'promql' | 'logql', text: string, scope: AiScope): { intent; message: string; sections: AiContextSection[] }`: a `scope` section with namespace and selection identity only
  - `explainObject(clusterId: ClusterId, gvk: Gvk, obj: KubeObject): Promise<void>` in `aiActions.ts` (`gatherExplainContext` then `ask({ intent: 'explain', … })`), so `intents.ts` stays pure
  - `assistantItems(): PaletteItem[]` (`PaletteItem` from `components/palette/paletteItems.tsx`): "Ask assistant…", "kubectl from description…", "PromQL from description…", "LogQL from description…"; only when enabled and a cluster is selected

- [ ] **Step 1: Write the failing test**

```ts
it('offers explain on pods and workloads only', () => {
  expect(['Pod', 'Deployment', 'CronJob'].every(explainable)).toBe(true);
  expect(explainable('ConfigMap')).toBe(false);
});
it('builds a query section that keeps the query verbatim', () => {
  expect(querySection('logql', '{app="web"} |= "error"')).toMatchObject({ kind: 'query', priority: 0, label: 'logql', content: '{app="web"} |= "error"' });
});
it('sends only scope identity for natural-language requests', () => {
  const r = nlRequest('kubectl', 'restart web', { cluster_id: 'c', namespace: 'shop', object: null });
  expect(r.sections.map((s) => s.kind)).toEqual(['scope']); expect(r.sections[0]!.content).not.toContain('status');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- src/lib/ai/intents.test.ts`
Expected: FAIL. The module does not exist.

- [ ] **Step 3: Implement `intents.ts`, `aiActions.ts`, the palette items and the PromQL/Loki buttons**

- [ ] **Step 4: Run the tests and checks**

Run: `pnpm test && pnpm typecheck && pnpm i18n:check`
Expected: PASS. In `pnpm dev:ui`:
- the pod context menu shows "Explain with assistant";
- "PromQL from description…" returns a `promql` block whose action opens the PromQL tab with the query;
- "Explain query" in the Loki tab explains the current LogQL.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/ai/intents.ts apps/desktop/src/lib/ai/intents.test.ts apps/desktop/src/components/workbench/actions/aiActions.ts apps/desktop/src/components/workbench/actions/resourceActions.tsx apps/desktop/src/components/palette apps/desktop/src/components/workbench/dock/promql/PromqlView.tsx apps/desktop/src/components/workbench/dock/loki/LokiView.tsx apps/desktop/src/i18n
git commit -m "feat(ui): explain actions, palette requests and PromQL/LogQL help"
```

---

### Task 17: YAML help in the create editor

**Files:**
- Create: `apps/desktop/src/lib/ai/context/schema.ts`, `apps/desktop/src/lib/ai/validateGenerated.ts`, `apps/desktop/src/components/workbench/dock/editor/AssistantYamlBar.tsx`
- Modify:
  - `apps/desktop/src/components/workbench/dock/editor/CreateEditor.tsx:216-230`: an "Assistant" toolbar button (when `settings.ai.enabled`) toggling the bar above the editor
  - `apps/desktop/src/components/assistant/SuggestionActions.tsx`: "Use in editor" replaces the origin tab's YAML through `useDockStore.updateTab(clusterId, tabId, { yaml })`, and shows the validation result
  - `apps/desktop/src/i18n/{en,tr}/{dock,shell}.json`
- Test: `apps/desktop/src/lib/ai/context/schema.test.ts`, `apps/desktop/src/lib/ai/validateGenerated.test.ts`

**Interfaces:**
- Consumes: `SchemaSet`, `SchemaNode`, `typeLabel`, `childContainer`, `hasProperties` (`lib/kube/schema/openapi.ts`); `fieldInfo` (`fields.ts`); `resolveKind` (`loader.ts`); `validateManifest` (`validate.ts`); `servedResources`; Task 13 `ask` with `origin`.
- Produces:
  - `schemaOutline(set: SchemaSet, root: SchemaNode, opts?: { maxDepth?: number; maxLines?: number }): string`. Defaults 4 / 400. Lines look like `spec.template.spec.containers[].image: string (required)` and `spec.strategy.type: string {Recreate|RollingUpdate}`; the output ends with `… N more fields` when capped.
  - `validateDocuments(yaml: string, resolve: (apiVersion: string, kind: string) => Promise<KindResolution>): Promise<{ documents: number; issues: { document: number; severity: 'error' | 'warning'; message: string; line: number }[]; unresolved: string[] }>`
  - `validateGenerated(clusterId: ClusterId, yaml: string)`: `validateDocuments` bound to `resolveKind(clusterId, …)`
  - `AssistantYamlBar` behaviour:
    - prompt input, optional kind picker (served kinds), and Generate / Complete buttons;
    - sections: `editor` (current YAML, priority 1) and `schema` (outline of the picked or current kind, priority 2);
    - intent `yaml`, origin `{ kind: 'editor', clusterId, tabId }`;
    - "Ask to fix N issues" sends the issue list as a typed follow-up.

- [ ] **Step 1: Write the failing tests**

```ts
it('outlines fields with types, required markers and enums within the caps', () => {
  const out = schemaOutline(deploymentSet(), deploymentRoot(), { maxDepth: 4, maxLines: 400 });
  expect(out).toContain('spec.template.spec.containers[].image: string (required)');
  expect(out).toContain('spec.strategy.type: string {Recreate|RollingUpdate}');
  expect(schemaOutline(deploymentSet(), deploymentRoot(), { maxLines: 10 }).split('\n').at(-1)).toMatch(/more fields$/);
});
it('reports schema issues per document with line numbers', async () => {
  const r = await validateDocuments(twoDocsWithTypo, fakeResolver);
  expect(r.documents).toBe(2); expect(r.issues[0]).toMatchObject({ document: 1, severity: 'error' });
});
it('lists kinds the cluster does not serve as unresolved', async () => {
  expect((await validateDocuments(unknownKindDoc, fakeResolver)).unresolved).toEqual(['example.io/v1 Widget']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- src/lib/ai/context/schema.test.ts src/lib/ai/validateGenerated.test.ts`
Expected: FAIL. The modules do not exist.

- [ ] **Step 3: Implement `schema.ts`, `validateGenerated.ts`, the bar and the editor hook**

- [ ] **Step 4: Run the tests and checks**

Run: `pnpm test && pnpm typecheck && pnpm i18n:check`
Expected: PASS. In `pnpm dev:ui`, "Create resource" → Assistant → "a CronJob that runs nightly" returns YAML. "Use in editor" replaces the content, and validation shows 0 issues against the demo schema.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/ai/context/schema.ts apps/desktop/src/lib/ai/context/schema.test.ts apps/desktop/src/lib/ai/validateGenerated.ts apps/desktop/src/lib/ai/validateGenerated.test.ts apps/desktop/src/components/workbench/dock/editor apps/desktop/src/components/assistant/SuggestionActions.tsx apps/desktop/src/i18n
git commit -m "feat(ui): schema-grounded YAML generation and completion in the editor"
```

---

### Task 18: Golden eval cases, the live eval and docs

**Files:**
- Create: `crates/kubepit-core/tests/fixtures/ai/{crashloop-go-panic,oomkilled,imagepull-manifest-unknown,pending-insufficient-cpu,readiness-after-image-change,config-error-with-secret,job-backoff-python}.json` and the matching `*.golden.txt`
- Create: `crates/kubepit-core/tests/ai_eval.rs`, `crates/kubepit-core/tests/ai_live_eval.rs`, `apps/desktop/src/lib/ai/eval.test.ts`
- Modify:
  - `docs/ARCHITECTURE.md`: new "AI assistant" section after "Custom actions", covering modules, egress rules, redaction layers, preview-then-send, tools, caching, limits, the demo backend and the eval commands; `history.db` row → "audit log, persisted events / changes, assistant request log (SQLite)"
  - `README.md`: feature line "**AI assistant (opt-in).** Bring your own key or a local model…"

**Interfaces:**
- Consumes: Task 8 `ai_preview` / `ai_send`, Task 4 `support::llm::anthropic_text`, Task 12 `extractSuggestions`.
- Produces: the fixture schema `{ name, locale, intent, scope, sections: AiContextSection[], secrets: string[], expect_sections: string[], max_input_tokens: number, scripted_reply: string, expect_suggestions: { manifest, kubectl, promql, logql }, keywords: string[] }`.

- [ ] **Step 1: Write the fixtures and the failing tests**

```rust
// tests/ai_eval.rs
#[tokio::test] async fn golden_cases_render_stable_leak_free_requests() {
    for case in load_cases() {
        let (preview, bodies) = run_case(&case).await; // fake provider replies anthropic_text(&case.scripted_reply, …)
        for s in &case.secrets { assert!(!bodies.iter().any(|b| b.contains(s)), "{}: {s} leaked", case.name);
                                  assert!(!serde_json::to_string(&preview).unwrap().contains(s)); }
        for id in &case.expect_sections { assert!(preview.sections.iter().any(|x| &x.id == id && !x.excluded), "{}: {id}", case.name); }
        assert!(preview.estimated_input_tokens <= case.max_input_tokens, "{}", case.name);
        golden(&case.name, &context_block_of(&bodies[0])); // compares with <name>.golden.txt; KUBEPIT_UPDATE_GOLDEN=1 rewrites
    }
}
#[tokio::test] async fn the_system_prompt_is_identical_across_cases_per_locale() { }
#[tokio::test] async fn secrets_never_reach_history_db() {
    // set_history_recording(true), run config-error-with-secret, history_flush, read history.db + history.db-wal bytes
    assert!(!bytes.windows(secret.len()).any(|w| w == secret.as_bytes()));
}
```

```rust
// tests/ai_live_eval.rs
#[tokio::test]
#[ignore = "calls the Anthropic API with your own key; run manually"]
async fn live_diagnosis_eval() {
    if std::env::var("KUBEPIT_AI_LIVE_EVAL").as_deref() != Ok("1") { eprintln!("set KUBEPIT_AI_LIVE_EVAL=1 and ANTHROPIC_API_KEY"); return; }
    // MemorySecretStore with the key, set_ai_remote_providers(true), model KUBEPIT_AI_LIVE_MODEL or "claude-opus-5"
    // per case: every keyword present (case-insensitive) and ```yaml count ≥ expect_suggestions.manifest; print name, pass, tokens, cost
    assert!(passed >= 6, "{passed}/7 cases passed");
}
```

```ts
// apps/desktop/src/lib/ai/eval.test.ts — reads the same fixtures with node:fs
it.each(cases())('extracts the expected suggestions for $name', (c) => {
  const counts = countByKind(extractSuggestions(c.scripted_reply));
  expect(counts).toEqual(c.expect_suggestions);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kubepit-core --test ai_eval && pnpm test -- src/lib/ai/eval.test.ts`
Expected: FAIL. The golden files do not exist yet (`golden` reports "missing golden file, rerun with KUBEPIT_UPDATE_GOLDEN=1").

- [ ] **Step 3: Generate and review the golden files**

Run: `KUBEPIT_UPDATE_GOLDEN=1 cargo test -p kubepit-core --test ai_eval`
Then read every `*.golden.txt`:
- no secret values;
- sections in priority order;
- `__SECRET__` where the Secret was.

- [ ] **Step 4: Run the full checks**

Run: `pnpm typecheck && pnpm i18n:check && pnpm test && cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace`
Expected: PASS. `ai_live_eval` is reported as ignored. Then `pnpm dev:ui` works end to end with the demo backend (explain, fix review, PromQL, LogQL, YAML, settings, log).

- [ ] **Step 5: Update the docs** (sections listed under Files)

- [ ] **Step 6: Commit**

```bash
git add crates/kubepit-core/tests/fixtures/ai crates/kubepit-core/tests/ai_eval.rs crates/kubepit-core/tests/ai_live_eval.rs apps/desktop/src/lib/ai/eval.test.ts docs/ARCHITECTURE.md README.md
git commit -m "test(ai): golden diagnosis cases, manual live eval and docs"
```
