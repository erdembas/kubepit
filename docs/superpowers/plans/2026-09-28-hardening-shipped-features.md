# Hardening of Shipped Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the verified gaps in shipped Kubepit features. Each fix is pinned by a test that fails before it and passes after it.

**Architecture:**
- Fixes are grouped by subsystem: health, watch cache, topology, layout, cost UI, RBAC UI, manifests, cluster registry, service-proxy sources, settings, alerts, upgrade, Helm, test harness, background work, audit.
- Pure logic moves into small tested modules. Components stay thin.
- Contract changes touch Rust serde types, `types/index.ts`, `lib/ipc.ts` and the demo backend in one commit.

**Tech Stack:** Rust (kube 4.2, tokio, notify 8, rusqlite), Tauri 2.12, React 18, Zustand 5, Tailwind v4, Vitest 3 (added in Task 1).

**Spec:** `docs/superpowers/specs/2026-09-28-hardening-shipped-features-design.md`

## Global Constraints

- **IPC contract.** `apps/desktop/src/types/index.ts` and `apps/desktop/src/lib/ipc.ts` define every frontend ⇄ backend command and shape.
  - Change the Rust serde types, the Tauri command, both TS files and the demo backend (`apps/desktop/src/lib/ipc/mock/`) in the same commit.
  - `pnpm dev:ui` must keep working.
- **Design.** Stay visually identical to RunHQ:
  - tokens from `src/styles/theme.css`, primitives from `src/components/ui/`;
  - 11–13 px UI text, uppercase tracked labels, `bg-fg/N` hover pads, the accent strip for active rows.
  - No chart or UI libraries; charts are SVG with tokens. Vitest is dev-only test tooling.
- **i18n is mandatory.** Every user-visible string ships in English and Turkish in the same commit.
  - Components use `import * as i18n from '@/i18n'` (and `i18n.useLocale()`); pure helpers use `@/i18n/core`.
  - Use `i18n.t('… {name}', { name })`, `i18n.rich` and `i18n.plural`. Never concatenate translated fragments.
  - Run `pnpm i18n:check -- --fix`, then add the Turkish values by hand. `pnpm i18n:check` must pass.
  - Never translate Kubernetes data, kinds used as identifiers, YAML, logs, commands or user content.
- **Safety.** Never connect to real clusters from tests or scripts; `~/.kube` may hold production credentials.
  - Rust tests use the fake API server in `crates/kubepit-core/tests/support`, with temp dirs (explicit `Paths`, or `KUBEPIT_HOME` pointed at a temp dir).
  - Frontend tests use in-memory fixtures only.
- **read_only.** Every mutating backend command honours `ClusterDef.read_only` (`ensure_writable`). Dry runs and access reviews stay allowed.
- **Background work is opt-in per process.** Anything that watches or polls a cluster after connect sits behind a `Kubepit::set_*` switch, like `set_alert_monitoring`. Only `apps/desktop/src-tauri/src/setup.rs` turns these on.
- **Container queries.** Responsive layouts use Tailwind v4 `@container` with `@lg:`/`@2xl:`/`@3xl:` variants, never viewport breakpoints.
- **Checks.** These must pass before every commit that touches their area, and all of them at the end:
  - `pnpm typecheck`
  - `pnpm i18n:check`
  - `cargo fmt --all -- --check`
  - `cargo clippy --workspace --all-targets -- -D warnings`
  - `cargo test --workspace`
  - `pnpm --filter @kubepit/desktop build`
- From Task 1 on, `pnpm --filter @kubepit/desktop test` must also pass.
- **Docs.** Update the `docs/ARCHITECTURE.md` section a task changes in that task's commit.
- **Commits.** Conventional messages (`fix(health): …`), one per task.

## Review Focus

- **Old workspace files.** Files written before this change have no `healthOptIns`, or have a malformed one. They must hydrate to "no opt-ins" and never crash (Task 1, `hydrateOptIns tolerates legacy and malformed snapshots`).
- **A Node with no pods scheduled.** Its Map tab must watch no namespaced kind at all, never fall back to cluster-wide (Task 4, `node without pods watches no namespaced slot`).
- **The saving window's own draft.** The window that saved settings must not have its open settings draft reset by its own broadcast; only other windows apply it (Task 13, `ignores the event from the saving window`).
- **Mixed detection results.** When one candidate answers 403 and another is unreachable or times out, the state is `unreachable`. Only an all-403 detection is `forbidden` (Task 12, `mixed forbidden and unreachable candidates stay unreachable`).
- **Audit contents.** A mutating custom action whose command echoes an annotation value (for example a Secret's last-applied configuration) must leave neither the value nor its output in the audit log or the SQLite file (Task 19, `mutating_custom_actions_are_audited_without_output`).

---

## File Structure

| Path | Responsibility |
|------|----------------|
| `apps/desktop/vitest.config.ts` (new) | Vitest config: `@` alias, node environment, `src/**/*.test.{ts,tsx}`, `src/**/*.bench.ts` |
| `apps/desktop/src/lib/kube/health/testing.ts` (new) | `emptyHealthInput()` test helper (never imported by app code) |
| `apps/desktop/src/lib/kube/health/secretRefs.ts` (new) | Secret names referenced by controller objects (Gateway, Issuers, webhooks, Flux) |
| `apps/desktop/src/components/workbench/data/watchBatch.ts` (new) | Pure batch application and snapshot status |
| `apps/desktop/src/lib/kube/topology/scope.ts` (new) | Per-slot watch scope for Map tabs of cluster-scoped roots |
| `apps/desktop/src/components/workbench/topology/dataKey.ts` (new) | Rebuild key of topology inputs (ignores `status`) |
| `apps/desktop/src/components/workbench/changes/ChangesHeader.tsx` (new) | Presentational, container-query Changes header |
| `apps/desktop/src/lib/ui/wheelScroll.ts` (new) | `horizontalWheelDelta` for tab strips |
| `apps/desktop/src/components/workbench/actions/roleBindingTarget.ts` (new) | Namespace and access check of "Add RoleBinding" |
| `apps/desktop/src/components/workbench/dock/manifests/access.ts` (new) | RBAC checks per manifest cell |
| `crates/kubepit-core/src/manifests/watch.rs` (new) | notify-based manifests watcher |
| `apps/desktop/src/components/workbench/common/ProxyForbiddenNotice.tsx` (new) | services/proxy permission notice |
| `apps/desktop/src/lib/settingsSync.ts` (new) | Settings broadcast source filter |
| `apps/desktop/src/lib/alerts/clickThrough.ts` (new) | Focus-after-notification click-through |
| `crates/kubepit-core/tests/background.rs` (new) | Guard: no background traffic unless opted in |
| `apps/desktop/src-tauri/src/ipc/audit_coverage.rs` (new, test-only) | Guard: every mutating command is audited |

---

### Task 1: Vitest and opt-in health rules

**Files:**
- Modify: `apps/desktop/package.json` (devDependency `vitest` `^3.2.4`; scripts `"test": "vitest run"`, `"bench": "vitest bench --run"`)
- Modify: `package.json` (root script `"test:ui": "pnpm --filter @kubepit/desktop test"`)
- Create: `apps/desktop/vitest.config.ts`
- Modify: `apps/desktop/tsconfig.node.json` (add `vitest.config.ts` to `include`)
- Create: `apps/desktop/src/lib/kube/health/testing.ts`
- Modify: `apps/desktop/src/lib/kube/health/rules.ts:11-35` (`optIn`), `:131-139` (split the rule)
- Modify: `apps/desktop/src/lib/kube/health/containers.ts:141-161`
- Modify: `apps/desktop/src/lib/kube/health/engine.ts:170-252`, `index.ts` (export `isSilenced`)
- Modify: `apps/desktop/src/components/workbench/health/HealthBanner.tsx:33`, `useHealthScan.ts:257`
- Modify: `apps/desktop/src/types/index.ts:25-39` (`healthOptIns?`)
- Modify: `apps/desktop/src/store/useHealthStore.ts`
- Modify: `apps/desktop/src/components/app/useAppBootstrap.ts:23,112` and the store subscription that saves the workspace
- Modify: `apps/desktop/src/components/workbench/health/HealthPage.tsx:334-360`
- Modify: `apps/desktop/src/i18n/{en,tr}/workbench.json`, `docs/ARCHITECTURE.md` (Health checks)
- Test: `apps/desktop/src/lib/kube/health/optIn.test.ts`, `apps/desktop/src/store/useHealthStore.test.ts`

**Interfaces:**
- Produces:
  - `pnpm --filter @kubepit/desktop test` (node environment) and `pnpm --filter @kubepit/desktop bench`.
  - `emptyHealthInput(overrides?: Partial<HealthInput>): HealthInput`, in `lib/kube/health/testing.ts`. Every list is `[]`, `loaded` holds every `HealthKind`, `now: 0`. The key set is typed `Record<HealthKind, …>`, so a new kind fails to compile until it is added here.
  - `RuleDef.optIn: boolean`.
  - `isSilenced(f: Pick<Finding, 'ruleId' | 'ref'>, ignores: readonly HealthIgnore[], optIns: readonly string[]): boolean`.
  - `summarize(scan: HealthScan, ignores: readonly HealthIgnore[], optIns?: readonly string[]): HealthSummary`. `optIns` defaults to `[]`.
  - `WorkspaceSnapshot.healthOptIns?: Record<ClusterId, string[]>`.
  - Store: `optIns: Record<ClusterId, string[]>`, `hydrateOptIns(raw: unknown): void`, `setOptIn(clusterId: ClusterId, rule: string, on: boolean): void`, `useHealthOptIns(clusterId): string[]`.

- [x] **Step 1: Add Vitest.** Skip this step if `apps/desktop/vitest.config.ts` already exists (the CI plan may have added it). Add the devDependency and scripts. Create `vitest.config.ts` with:
  - `resolve.alias['@'] = path.resolve(__dirname, 'src')`;
  - `test.environment = 'node'`;
  - `test.include = ['src/**/*.test.{ts,tsx}']`;
  - `benchmark.include = ['src/**/*.bench.ts']`.

  Run `pnpm install`.

- [x] **Step 2: Write the failing tests**

```ts
// apps/desktop/src/lib/kube/health/optIn.test.ts
import { describe, expect, it } from 'vitest';
import { isSilenced, objectFindings, ruleDef, scanHealth, summarize } from '@/lib/kube/health';
import { emptyHealthInput } from './testing';

const deployment = (sc: Record<string, unknown>) => ({
  apiVersion: 'apps/v1', kind: 'Deployment',
  metadata: { name: 'web', namespace: 'shop', uid: 'u1' },
  spec: { template: { spec: { containers: [{ name: 'app', image: 'nginx:1', securityContext: sc }] } } },
});
const escalation = (obj: ReturnType<typeof deployment>) =>
  objectFindings(obj, 0).filter((f) => f.ruleId.startsWith('container-privilege-escalation'));

describe('privilege escalation rules', () => {
  it('reports an explicit true as a warning under the original id', () => {
    expect(escalation(deployment({ allowPrivilegeEscalation: true })).map((f) => [f.ruleId, f.severity]))
      .toEqual([['container-privilege-escalation', 'warning']]);
  });
  it('reports an unset field under the opt-in id', () => {
    expect(escalation(deployment({})).map((f) => f.ruleId)).toEqual(['container-privilege-escalation-unset']);
    expect(ruleDef('container-privilege-escalation-unset')?.optIn).toBe(true);
    expect(ruleDef('container-privilege-escalation')?.optIn).toBe(false);
  });
  it('silences opt-in findings unless the cluster turned the rule on', () => {
    const [f] = escalation(deployment({}));
    const on = ['container-privilege-escalation-unset'];
    expect(isSilenced(f!, [], [])).toBe(true);
    expect(isSilenced(f!, [], on)).toBe(false);
    expect(isSilenced(f!, [{ rule: 'container-privilege-escalation-unset', namespace: null }], on)).toBe(true);
  });
  it('summarize leaves silenced opt-in findings out of the counts', () => {
    const scan = scanHealth(emptyHealthInput({ deployments: [deployment({})] }));
    const count = (s: ReturnType<typeof summarize>) =>
      s.groups.filter((g) => g.ruleId === 'container-privilege-escalation-unset').length;
    expect(count(summarize(scan, []))).toBe(0);
    expect(count(summarize(scan, [], ['container-privilege-escalation-unset']))).toBe(1);
  });
});
```

```ts
// apps/desktop/src/store/useHealthStore.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { useHealthStore } from './useHealthStore';

describe('health opt-ins', () => {
  beforeEach(() => useHealthStore.setState({ optIns: {} }));
  it('hydrateOptIns tolerates legacy and malformed snapshots', () => {
    useHealthStore.getState().hydrateOptIns(undefined);
    expect(useHealthStore.getState().optIns).toEqual({});
    useHealthStore.getState().hydrateOptIns({ c1: ['a', 3, null], c2: 'x', c3: [] });
    expect(useHealthStore.getState().optIns).toEqual({ c1: ['a'] });
  });
  it('setOptIn toggles one rule per cluster', () => {
    const { setOptIn } = useHealthStore.getState();
    setOptIn('c1', 'r', true);
    setOptIn('c1', 'r', true);
    expect(useHealthStore.getState().optIns).toEqual({ c1: ['r'] });
    setOptIn('c1', 'r', false);
    expect(useHealthStore.getState().optIns).toEqual({});
  });
});
```

`HealthSummary.groups` is the per-rule list that `summarize` already returns. If the field has a different name, use it; the assertion stays the same.

- [x] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @kubepit/desktop test -- src/lib/kube/health/optIn.test.ts src/store/useHealthStore.test.ts`
Expected: FAIL. `isSilenced`, `hydrateOptIns` and the `container-privilege-escalation-unset` rule do not exist.

- [x] **Step 4: Implement.**
  - `rule()` gains a trailing `opts: { optIn?: boolean } = {}`.
  - `container-privilege-escalation`: severity `warning`, title "Privilege escalation allowed".
  - New `container-privilege-escalation-unset`: category security, severity info, `needs: []`, `local: true`, `optIn: true`. Title: "Containers that do not disable privilege escalation". Hint: the existing one.
  - `containers.ts:151-160` emits the new id.
  - `isSilenced` = `isIgnored(f, ignores) || (ruleDef(f.ruleId)?.optIn === true && !optIns.includes(f.ruleId))`. `summarize` and `HealthBanner` use it. `useHealthScan.ts:257` passes `useHealthOptIns(clusterId)`.
  - The store sanitizes like `sanitize()` for ignores: keep string entries only, and drop empty lists.
  - `useAppBootstrap` hydrates `workspace.healthOptIns ?? {}` and saves `healthOptIns` next to `healthIgnores`.
  - `HealthPage` adds an "Off by default" card listing `RULES.filter(r => r.optIn)`, each with a "Turn on" or "Turn off" button.
  - Add the EN and TR strings.

- [x] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @kubepit/desktop test && pnpm typecheck && pnpm i18n:check`
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add apps/desktop package.json pnpm-lock.yaml docs/ARCHITECTURE.md
git commit -m "fix(health): make the unset allowPrivilegeEscalation rule opt-in; add Vitest"
```

---

### Task 2: Unused Secrets reads controller references

**Files:**
- Modify: `apps/desktop/src/lib/kube/health/types.ts:18-40` (new `HealthKind`s)
- Create: `apps/desktop/src/lib/kube/health/secretRefs.ts`
- Modify: `apps/desktop/src/lib/kube/health/config.ts:92-161`
- Modify: `apps/desktop/src/lib/kube/health/engine.ts:62-66` (gate), `:112` (`CONTEXT_LISTS`)
- Modify: `apps/desktop/src/lib/kube/health/rules.ts:322-333` (`secret-unused` needs)
- Modify: `apps/desktop/src/components/workbench/health/useHealthScan.ts:28-50,105-137,216`
- Modify: `apps/desktop/src/lib/kube/health/testing.ts`, `i18n/{en,tr}/workbench.json`, `docs/ARCHITECTURE.md` (health list count)
- Test: `apps/desktop/src/lib/kube/health/secretUnused.test.ts`

**Interfaces:**
- Consumes: `emptyHealthInput` (Task 1).
- Produces:
  - `HealthKind` gains `'issuers' | 'clusterIssuers' | 'gateways' | 'validatingWebhooks' | 'mutatingWebhooks' | 'gitRepositories' | 'helmRepositories' | 'ociRepositories' | 'kustomizations' | 'helmReleases' | 'fluxProviders'`.
  - `controllerSecretRefs(obj: KubeObject): Array<{ namespace: string | null; name: string }>`. `namespace: null` means any namespace (cluster-scoped referrer without an explicit namespace).
  - `unusedSecretFindings(input: HealthInput, refs: References, emit: Emit): void`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/desktop/src/lib/kube/health/secretUnused.test.ts
import { describe, expect, it } from 'vitest';
import { scanHealth } from '@/lib/kube/health';
import { emptyHealthInput } from './testing';
import type { HealthKind } from './types';

const secret = (name: string, ns = 'app', extra: Record<string, unknown> = {}) => ({
  apiVersion: 'v1', kind: 'Secret', type: 'Opaque',
  metadata: { name, namespace: ns, uid: `s-${ns}-${name}`, ...extra },
});
const obj = (apiVersion: string, kind: string, name: string, ns: string | null, spec: unknown, meta: Record<string, unknown> = {}) => ({
  apiVersion, kind, metadata: { name, ...(ns ? { namespace: ns } : {}), uid: `${kind}-${name}`, ...meta }, spec,
});
const unused = (input: Parameters<typeof emptyHealthInput>[0]) =>
  scanHealth(emptyHealthInput(input)).findings
    .filter((f) => f.ruleId === 'secret-unused').map((f) => `${f.ref.namespace}/${f.ref.name}`).sort();

describe('secret-unused', () => {
  it('still reports an unreferenced Opaque secret', () => {
    expect(unused({ secrets: [secret('lonely')] })).toEqual(['app/lonely']);
  });
  it('skips secrets named by a Gateway listener certificateRef', () => {
    const gw = obj('gateway.networking.k8s.io/v1', 'Gateway', 'gw', 'app',
      { listeners: [{ name: 'https', tls: { certificateRefs: [{ name: 'gw-tls' }, { kind: 'Secret', name: 'other', namespace: 'certs' }] } }] });
    expect(unused({ secrets: [secret('gw-tls'), secret('other', 'certs')], gateways: [gw] })).toEqual([]);
  });
  it('skips Issuer and ClusterIssuer secrets', () => {
    const issuer = obj('cert-manager.io/v1', 'Issuer', 'le', 'app', { acme: { privateKeySecretRef: { name: 'le-key' } } });
    const cluster = obj('cert-manager.io/v1', 'ClusterIssuer', 'ca', null, { ca: { secretName: 'root-ca' } });
    expect(unused({ secrets: [secret('le-key'), secret('root-ca', 'cert-manager')], issuers: [issuer], clusterIssuers: [cluster] })).toEqual([]);
  });
  it('skips the secret named by inject-ca-from-secret on a webhook configuration', () => {
    const hook = obj('admissionregistration.k8s.io/v1', 'ValidatingWebhookConfiguration', 'v', null, undefined,
      { annotations: { 'cert-manager.io/inject-ca-from-secret': 'webhooks/serving-ca' } });
    expect(unused({ secrets: [secret('serving-ca', 'webhooks')], validatingWebhooks: [hook] })).toEqual([]);
  });
  it('skips Flux source, decryption and valuesFrom secrets but not ConfigMap valuesFrom', () => {
    const repo = obj('source.toolkit.fluxcd.io/v1', 'GitRepository', 'infra', 'flux-system', { secretRef: { name: 'git-auth' } });
    const ks = obj('kustomize.toolkit.fluxcd.io/v1', 'Kustomization', 'apps', 'flux-system', { decryption: { provider: 'sops', secretRef: { name: 'sops-age' } } });
    const hr = obj('helm.toolkit.fluxcd.io/v2', 'HelmRelease', 'api', 'app',
      { valuesFrom: [{ kind: 'Secret', name: 'api-values' }, { kind: 'ConfigMap', name: 'api-cm' }] });
    expect(unused({
      secrets: [secret('git-auth', 'flux-system'), secret('sops-age', 'flux-system'), secret('api-values'), secret('api-cm')],
      gitRepositories: [repo], kustomizations: [ks], helmReleases: [hr],
    })).toEqual(['app/api-cm']);
  });
  it('skips cert-manager issued and Argo CD internal secrets', () => {
    expect(unused({ secrets: [
      secret('web-tls', 'app', { annotations: { 'cert-manager.io/certificate-name': 'web' } }),
      secret('argocd-secret', 'argocd'),
      secret('extra', 'argocd', { labels: { 'app.kubernetes.io/part-of': 'argocd' } }),
    ] })).toEqual([]);
  });
  it('skips the rule when serviceAccounts did not load', () => {
    const input = emptyHealthInput({ secrets: [secret('lonely')] });
    const loaded = new Set(input.loaded); loaded.delete('serviceAccounts' as HealthKind);
    expect(scanHealth({ ...input, loaded }).findings.filter((f) => f.ruleId === 'secret-unused')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @kubepit/desktop test -- src/lib/kube/health/secretUnused.test.ts`
Expected: FAIL. The new `HealthKind`s do not compile, and the other cases report secrets.

- [ ] **Step 3: Implement.**
  - `controllerSecretRefs` walks `spec` (depth ≤ 12) and records names under `secretRef`, `certSecretRef`, `privateKeySecretRef` and `secretName`, plus `certificateRefs[]` entries whose `kind` is `Secret` or absent.
  - It also records `valuesFrom[]` / `substituteFrom[]` entries with `kind: 'Secret'`, and the `cert-manager.io/inject-ca-from-secret` annotation (`ns/name`).
  - The namespace is the ref's `namespace`, else the object's, else `null` (cluster-scoped referrers match the name in any namespace).
  - `collectReferences` adds these refs for every new list. `References.anyNamespaceSecrets: Set<string>` holds the `null`-namespace names.
  - Move the Secret loop into `unusedSecretFindings`, gated in `engine.ts` by `needsMet(input, 'secret-unused')`.
  - Skips, before the reference check:
    - annotations `cert-manager.io/certificate-name`, `cert-manager.io/allow-direct-injection`;
    - label `app.kubernetes.io/part-of=argocd`;
    - names `argocd-secret`, `argocd-initial-admin-secret`, `argocd-redis`, `argocd-notifications-secret`.
  - `secret-unused.needs` gains the eleven new kinds, which are also added to `CONTEXT_LISTS`.
  - `useHealthScan`: a fixed `REFERENCE_KINDS` array maps each kind to `{ group, kind }`: `cert-manager.io` Issuer and ClusterIssuer; `gateway.networking.k8s.io` Gateway; `admissionregistration.k8s.io` Validating- and MutatingWebhookConfiguration; `source.toolkit.fluxcd.io` GitRepository, HelmRepository and OCIRepository; `kustomize.toolkit.fluxcd.io` Kustomization; `helm.toolkit.fluxcd.io` HelmRelease; `notification.toolkit.fluxcd.io` Provider. Each is resolved from `apiResources` like `certificates` and gets one `useWatch` line (fixed hook order; an unserved kind gets gvk `null` and counts as loaded).
  - New finding message: "Not referenced by any workload, service account, ingress or controller".
  - Update `testing.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @kubepit/desktop test && pnpm typecheck && pnpm i18n:check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src docs/ARCHITECTURE.md
git commit -m "fix(health): unused-Secrets rule honours its lists and skips controller-read secrets"
```

---

### Task 3: Watch batches with an error keep their objects

**Files:**
- Create: `apps/desktop/src/components/workbench/data/watchBatch.ts`
- Modify: `apps/desktop/src/components/workbench/data/watchCache.ts:108-121`
- Modify: `apps/desktop/src/components/workbench/table/TableStates.tsx` (add `PartialWatchNotice`), `table/ResourcePage.tsx` (render it)
- Modify: `apps/desktop/src/i18n/{en,tr}/workbench.json`
- Test: `apps/desktop/src/components/workbench/data/watchBatch.test.ts`

**Interfaces:**
- Produces:
  - `applyBatch(map: Map<string, KubeObject>, batch: WatchBatch): void`. It always applies `reset`, then `upserts`, then `deletes`.
  - `batchPatch(prev: Pick<WatchSnapshot, 'synced'>, batch: Pick<WatchBatch, 'error' | 'synced'>, size: number): Partial<WatchSnapshot>`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/components/workbench/data/watchBatch.test.ts
import { describe, expect, it } from 'vitest';
import type { KubeObject, WatchBatch } from '@/types';
import { applyBatch, batchPatch } from './watchBatch';

const pod = (uid: string) => ({ apiVersion: 'v1', kind: 'Pod', metadata: { name: uid, namespace: 'a', uid } }) as KubeObject;
const batch = (b: Partial<WatchBatch>): WatchBatch =>
  ({ watch_id: 'w', reset: false, upserts: [], deletes: [], synced: false, error: null, ...b });

describe('watch batches', () => {
  it('applies upserts of a batch that also carries an error', () => {
    const map = new Map<string, KubeObject>();
    applyBatch(map, batch({ reset: true, upserts: [pod('a1'), pod('a2')], error: 'namespaces "b" is forbidden' }));
    expect([...map.keys()]).toEqual(['a1', 'a2']);
  });
  it('reset clears previous rows even when the batch has an error', () => {
    const map = new Map([['old', pod('old')]]);
    applyBatch(map, batch({ reset: true, upserts: [pod('n')], error: 'x' }));
    expect([...map.keys()]).toEqual(['n']);
  });
  it('status is error only when nothing is left', () => {
    expect(batchPatch({ synced: false }, { error: 'pods is forbidden', synced: true }, 0))
      .toMatchObject({ status: 'error', error: 'pods is forbidden', forbidden: true });
    expect(batchPatch({ synced: false }, { error: 'pods is forbidden', synced: true }, 2))
      .toMatchObject({ status: 'ready', error: 'pods is forbidden', forbidden: true, synced: true });
    expect(batchPatch({ synced: true }, { error: null, synced: true }, 2)).toMatchObject({ error: null, forbidden: false });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @kubepit/desktop test -- src/components/workbench/data/watchBatch.test.ts`
Expected: FAIL with "Cannot find module './watchBatch'".

- [ ] **Step 3: Implement.** Move `isForbidden` into `watchBatch.ts`. `WatchEntry.apply` calls `applyBatch`, bumps `version`, then flushes with `batchPatch(...)` when `batch.error` is set or the batch newly makes the entry synced, else schedules. Add `PartialWatchNotice` ("Some namespaces could not be watched: {error}"), shown by `ResourcePage` when `snapshot.status === 'ready' && snapshot.error`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @kubepit/desktop test && pnpm typecheck && pnpm i18n:check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src
git commit -m "fix(watch): keep the objects of a batch that also reports an error"
```

---

### Task 4: Scope the details Map tab of cluster-scoped objects

**Files:**
- Create: `apps/desktop/src/lib/kube/topology/scope.ts`; modify `lib/kube/topology/index.ts` (export)
- Modify: `apps/desktop/src/components/workbench/topology/useTopologyData.ts:44-58`
- Modify: `apps/desktop/src/components/workbench/topology/MapTab.tsx:17-58`
- Modify: `apps/desktop/src/components/workbench/topology/ResourceMapPage.tsx:34`
- Modify: `docs/ARCHITECTURE.md` (Resource map)
- Test: `apps/desktop/src/lib/kube/topology/scope.test.ts`

**Interfaces:**
- Produces:
  - `type SlotScope = readonly string[] | null`. `[]` means cluster-wide (or a cluster-scoped kind); `null` means the slot is not watched.
  - `mapSeed(rootKind: string): { gvkKey: string; matches(o: KubeObject, rootName: string): boolean } | null`:
    - Node → `pods`, `spec.nodeName`;
    - StorageClass → `persistentvolumeclaims`, `spec.storageClassName`;
    - ClusterRole → `rolebindings.rbac.authorization.k8s.io`, `roleRef.kind === 'ClusterRole' && roleRef.name`;
    - IngressClass → `ingresses.networking.k8s.io`, `spec.ingressClassName`;
    - anything else → `null`.
  - `planMapScope(root: { kind: string; name: string }, sources: ReadonlyArray<Gvk | null>, seed: { items: readonly KubeObject[]; synced: boolean } | null): SlotScope[]`.
  - `useTopologyData(clusterId, slotScopes: ReadonlyArray<SlotScope>, enabled, apiResources, extra)`. It replaces the single `namespaces` argument. `buildTopology` receives the union of the non-null namespace lists.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/lib/kube/topology/scope.test.ts
import { describe, expect, it } from 'vitest';
import { topologySources } from './sources';
import { planMapScope } from './scope';
import { kindKey } from '@/lib/kube/catalog';

const sources = topologySources(null);
const slot = (plan: ReturnType<typeof planMapScope>, key: string) =>
  plan[sources.findIndex((g) => g && kindKey(g) === key)];
const pod = (ns: string, node: string) =>
  ({ apiVersion: 'v1', kind: 'Pod', metadata: { name: `p-${ns}`, namespace: ns, uid: `${ns}-${node}` }, spec: { nodeName: node } });

describe('planMapScope', () => {
  it('scopes namespaced slots to the namespaces of pods on the node', () => {
    const plan = planMapScope({ kind: 'Node', name: 'n1' }, sources,
      { items: [pod('a', 'n1'), pod('b', 'n1'), pod('c', 'n2')], synced: true });
    expect(slot(plan, 'pods')).toEqual([]);
    expect(slot(plan, 'deployments.apps')).toEqual(['a', 'b']);
    expect(slot(plan, 'secrets')).toEqual(['a', 'b']);
    expect(slot(plan, 'nodes')).toEqual([]);
    expect(slot(plan, 'clusterroles.rbac.authorization.k8s.io')).toEqual([]);
  });
  it('node without pods watches no namespaced slot', () => {
    const plan = planMapScope({ kind: 'Node', name: 'idle' }, sources, { items: [pod('a', 'n1')], synced: true });
    expect(slot(plan, 'pods')).toEqual([]);
    expect(slot(plan, 'configmaps')).toBeNull();
    expect(slot(plan, 'endpointslices.discovery.k8s.io')).toBeNull();
  });
  it('waits for the seed before scoping', () => {
    const plan = planMapScope({ kind: 'Node', name: 'n1' }, sources, { items: [], synced: false });
    expect(slot(plan, 'services')).toBeNull();
  });
  it('seeds StorageClass, ClusterRole and IngressClass roots', () => {
    const pvc = { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: 'd', namespace: 'db', uid: 'v' }, spec: { storageClassName: 'fast' } };
    expect(slot(planMapScope({ kind: 'StorageClass', name: 'fast' }, sources, { items: [pvc], synced: true }), 'pods')).toEqual(['db']);
    const rb = { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding', metadata: { name: 'r', namespace: 'ops', uid: 'r' }, roleRef: { kind: 'ClusterRole', name: 'view' } };
    expect(slot(planMapScope({ kind: 'ClusterRole', name: 'view' }, sources, { items: [rb], synced: true }), 'serviceaccounts')).toEqual(['ops']);
    const ing = { apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { name: 'i', namespace: 'web', uid: 'i' }, spec: { ingressClassName: 'nginx' } };
    expect(slot(planMapScope({ kind: 'IngressClass', name: 'nginx' }, sources, { items: [ing], synced: true }), 'services')).toEqual(['web']);
  });
  it('roots without a seed watch cluster-scoped slots only', () => {
    const plan = planMapScope({ kind: 'PriorityClass', name: 'high' }, sources, null);
    expect(slot(plan, 'pods')).toBeNull();
    expect(slot(plan, 'nodes')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @kubepit/desktop test -- src/lib/kube/topology/scope.test.ts`
Expected: FAIL with "Cannot find module './scope'".

- [ ] **Step 3: Implement.**
  - The seed slot gets `[]`.
  - Other namespaced slots get the sorted unique namespaces of the matching seed items, or `null` when there are none or the seed is not synced.
  - Cluster-scoped slots get `[]`.
  - `useTopologyData` calls `useWatch(clusterId, scope === null ? null : sources[i], scope ?? [], enabled)`.
  - `MapTab`, for a cluster-scoped root with a seed, watches the seed gvk cluster-wide and passes `planMapScope(...)`. Namespaced roots keep `scopeFor` for every slot.
  - `ResourceMapPage` passes `sources.map(() => namespaces)`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @kubepit/desktop test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Verify in the demo.** In `pnpm dev:ui` on c-prod-us, open a Node's details and its Map tab. It shows the node, its pods and their owners exactly as before. Opening a Namespace's or Pod's Map tab is unchanged.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src docs/ARCHITECTURE.md
git commit -m "fix(map): scope the Map tab of cluster-scoped objects to the namespaces that matter"
```

---

### Task 5: Leave the Resource Map without rebuilding it

**Files:**
- Create: `apps/desktop/src/components/workbench/topology/dataKey.ts`
- Modify: `apps/desktop/src/components/workbench/topology/useTopologyData.ts:56-99`
- Modify: `apps/desktop/src/lib/kube/topology/view.ts:175-195` (`hideKinds`)
- Modify: `apps/desktop/src/components/workbench/topology/TopologyMap.tsx:98-120` (skip recomputation while inactive), `ResourceMapPage.tsx` / `MapTab.tsx` (pass `active`)
- Test: `apps/desktop/src/components/workbench/topology/dataKey.test.ts`, `apps/desktop/src/lib/kube/topology/view.test.ts`

**Interfaces:**
- Produces:
  - `topologyDataKey(snaps: ReadonlyArray<Pick<WatchSnapshot, 'version' | 'synced' | 'forbidden'>>): string`.
  - `useTopologyData` returns its previous model while `enabled` is false.

- [ ] **Step 1: Copy the current `hideKinds` body verbatim into `view.test.ts` as `hideKindsReference`,** before changing `view.ts`. It is the oracle.

- [ ] **Step 2: Write the failing tests**

```ts
// apps/desktop/src/components/workbench/topology/dataKey.test.ts
import { describe, expect, it } from 'vitest';
import { topologyDataKey } from './dataKey';

describe('topologyDataKey', () => {
  it('ignores status-only changes such as loading → idle on leave', () => {
    const a = [{ version: 3, synced: true, forbidden: false, status: 'loading' }];
    const b = [{ version: 3, synced: true, forbidden: false, status: 'idle' }];
    expect(topologyDataKey(a)).toBe(topologyDataKey(b));
  });
  it('changes with version, synced or forbidden', () => {
    const base = { version: 3, synced: true, forbidden: false };
    expect(topologyDataKey([base])).not.toBe(topologyDataKey([{ ...base, version: 4 }]));
    expect(topologyDataKey([base])).not.toBe(topologyDataKey([{ ...base, forbidden: true }]));
  });
});
```

```ts
// apps/desktop/src/lib/kube/topology/view.test.ts (next to hideKindsReference)
import { describe, expect, it } from 'vitest';
import { hideKinds } from './view';

function chainGraph(n: number) { /* n Deployments → ReplicaSets → Pods with `owns` edges and Pod → ConfigMap `mounts` edges, ids `kind|ns|name` */ }

describe('hideKinds', () => {
  it.each([10, 200, 2000])('matches the previous implementation on %i chains', (n) => {
    const g = chainGraph(n);
    for (const hidden of [['replicasets.apps'], ['pods'], ['replicasets.apps', 'configmaps']]) {
      const norm = (x: ReturnType<typeof hideKinds>) =>
        [...x.edges].map((e) => `${e.from}>${e.to}:${e.kind}`).sort();
      expect(norm(hideKinds(g, new Set(hidden)))).toEqual(norm(hideKindsReference(g, new Set(hidden))));
    }
  });
});
```

`chainGraph` builds the `TopoGraph` shape from `model.ts`: `nodes` Map and `edges` array. Export `hideKinds` from `view.ts` if it is private.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @kubepit/desktop test -- src/components/workbench/topology src/lib/kube/topology/view.test.ts`
Expected: FAIL. `./dataKey` is missing; `hideKinds` is not exported.

- [ ] **Step 4: Implement.**
  - `useTopologyData` memoizes on `topologyDataKey(snaps)` and keeps the last result in a ref while `!enabled`.
  - `hideKinds` builds `incoming` / `outgoing` adjacency maps once and bridges each hidden node from them: O(nodes + edges), with no per-node edge copies.
  - `TopologyMap` skips `deriveView` / `layoutTopology` recomputation while `active` is false.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @kubepit/desktop test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Verify the timing.**
  1. In `pnpm dev:ui` on prod-eu-west-1, open the Resource Map with all namespaces.
  2. Start a Chrome Performance recording and switch to the Overview view.
  3. Expected: the task after the click takes < 200 ms (it took > 1 s before). Put both numbers in the commit body.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src
git commit -m "fix(map): leaving the Resource Map no longer rebuilds the graph"
```

---

### Task 6: Narrow-pane layouts: Changes header and details tab strip

**Files:**
- Create: `apps/desktop/src/components/workbench/changes/ChangesHeader.tsx`
- Modify: `apps/desktop/src/components/workbench/changes/ChangesPage.tsx:255-317,472-530`
- Create: `apps/desktop/src/lib/ui/wheelScroll.ts`
- Modify: `apps/desktop/src/components/workbench/details/DetailsPanel.tsx:226-249`
- Test: `apps/desktop/src/components/workbench/changes/ChangesHeader.test.tsx`, `apps/desktop/src/lib/ui/wheelScroll.test.ts`

**Interfaces:**
- Produces:
  - `ChangesHeader(props: { count: number; recording: ReactNode; ranges: ReactNode; search: ReactNode; refresh: ReactNode }): JSX.Element`. It owns the root `@container`, the wrapping row, the title and the search wrapper.
  - `horizontalWheelDelta(e: { deltaX: number; deltaY: number; deltaMode: number }): number`. It takes the dominant axis and returns pixels (line mode × 16, page mode × 240).

- [ ] **Step 1: Write the failing tests**

```tsx
// apps/desktop/src/components/workbench/changes/ChangesHeader.test.tsx
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChangesHeader } from './ChangesHeader';

describe('ChangesHeader', () => {
  const html = renderToStaticMarkup(
    <ChangesHeader count={3} recording={<i />} ranges={<b />} search={<input />} refresh={<button />} />,
  );
  it('is a container that wraps instead of overflowing', () => {
    expect(html).toMatch(/class="[^"]*@container[^"]*"/);
    expect(html).toMatch(/class="[^"]*\bmin-h-12\b[^"]*\bflex-wrap\b[^"]*"/);
    expect(html).not.toMatch(/\bh-12\b/);
  });
  it('lets the search field fill the row below the @lg breakpoint', () => {
    expect(html).toMatch(/class="[^"]*\bw-full\b[^"]*\bmin-w-0\b[^"]*@lg:w-56[^"]*"/);
  });
});
```

```ts
// apps/desktop/src/lib/ui/wheelScroll.test.ts
import { describe, expect, it } from 'vitest';
import { horizontalWheelDelta } from './wheelScroll';

describe('horizontalWheelDelta', () => {
  it('maps vertical wheels to horizontal pixels', () => {
    expect(horizontalWheelDelta({ deltaX: 0, deltaY: 40, deltaMode: 0 })).toBe(40);
    expect(horizontalWheelDelta({ deltaX: 0, deltaY: 3, deltaMode: 1 })).toBe(48);
    expect(horizontalWheelDelta({ deltaX: 0, deltaY: -1, deltaMode: 2 })).toBe(-240);
  });
  it('keeps a dominant horizontal delta (trackpads)', () => {
    expect(horizontalWheelDelta({ deltaX: -25, deltaY: 4, deltaMode: 0 })).toBe(-25);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @kubepit/desktop test -- src/components/workbench/changes src/lib/ui`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement.**
  - `ChangesHeader`:
    - root `@container`;
    - row `border-border/60 flex min-h-12 shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b px-4 py-2`;
    - title `shrink-0`;
    - right group `ml-auto flex min-w-0 shrink items-center justify-end gap-1.5`;
    - search wrapper `w-full min-w-0 @lg:w-56`.
  - `RecordingIndicator` hides its text below `@2xl` (`hidden @2xl:inline`) and keeps the dot and the switch.
  - `DetailsPanel`:
    - gives each tab `data-details-tab={id}`;
    - runs `scrollIntoView({ inline: 'nearest', block: 'nearest' })` on the active tab when `tab` or `tabs.length` changes;
    - adds an `onWheel` that adds `horizontalWheelDelta(e)` to `scrollLeft` when the strip overflows;
    - replaces `overlay-scroll` with `main-tabbar-scroll`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @kubepit/desktop test && pnpm typecheck && pnpm i18n:check`
Expected: PASS.

- [ ] **Step 5: Verify visually.** In `pnpm dev:ui`, check the Changes view in a split pane about 560 px wide: the header wraps to two rows and nothing is clipped. Drag the details panel to its 380 px minimum and open the Map tab through a node link: the Map tab scrolls into view, and the wheel scrolls the strip.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src
git commit -m "fix(ui): Changes header and details tab strip fit narrow panes"
```

---

### Task 7: One money formatter

**Files:**
- Modify: `apps/desktop/src/lib/cost.ts:10-49`
- Modify: `apps/desktop/src/components/workbench/cost/RightsizingPanel.tsx:246-248`
- Test: `apps/desktop/src/lib/cost.test.ts`

**Interfaces:**
- Produces: `formatMoney(value: number, currency: string, opts?: { compact?: boolean; signed?: boolean }): string`. The `cents` option is removed; nothing uses it.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/lib/cost.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '@/i18n/core';
import { formatMoney } from './cost';

describe('formatMoney', () => {
  afterEach(() => setLocale('en', false));
  it('uses no decimals from 1,000 and two below', () => {
    expect(formatMoney(7969, 'USD')).toBe('$7,969');
    expect(formatMoney(5669.3, 'USD', { compact: true })).toBe('$5,669');
    expect(formatMoney(2299.7, 'USD', { compact: true })).toBe('$2,300');
    expect(formatMoney(12.4, 'USD')).toBe('$12.40');
    expect(formatMoney(999.994, 'USD')).toBe('$999.99');
    expect(formatMoney(999.996, 'USD')).toBe('$1,000');
  });
  it('treats non-finite values as zero', () => {
    expect(formatMoney(0, 'USD')).toBe('$0.00');
    expect(formatMoney(Number.NaN, 'USD')).toBe('$0.00');
  });
  it('compacts only from one million', () => {
    expect(formatMoney(1_234_567, 'USD', { compact: true })).toBe('$1.2M');
    expect(formatMoney(1_234_567, 'USD')).toBe('$1,234,567');
    expect(formatMoney(250_120, 'USD', { compact: true })).toBe('$250,120');
  });
  it('signs deltas when asked', () => {
    expect(formatMoney(-12.5, 'USD', { signed: true })).toBe('-$12.50');
    expect(formatMoney(12.5, 'USD', { signed: true })).toBe('+$12.50');
    expect(formatMoney(0, 'USD', { signed: true })).toBe('$0.00');
  });
  it('follows the UI locale and falls back for unknown codes', () => {
    expect(formatMoney(1500, 'EUR')).toBe('€1,500');
    expect(formatMoney(12.4, 'EURO')).toBe('12.40 EURO');
    setLocale('tr', false);
    expect(formatMoney(7969, 'TRY')).toBe('₺7.969');
    expect(formatMoney(12.4, 'USD')).toBe('$12,40');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @kubepit/desktop test -- src/lib/cost.test.ts`
Expected: FAIL (`$5,669.3` and `$2,299.7` are returned).

- [ ] **Step 3: Implement.**
  - `const amount = Number.isFinite(value) ? Math.round(value * 100) / 100 : 0`.
  - `const decimals = Math.abs(amount) < 1000 ? 2 : 0`.
  - `notation: compact && Math.abs(amount) >= 1_000_000 ? 'compact' : 'standard'`, with `maximumFractionDigits: 1` in compact mode.
  - `signDisplay: signed ? 'exceptZero' : 'auto'`.
  - The fallback uses the same fraction digits.
  - `RightsizingPanel` passes `formatMoney(delta, currency, { signed: true })` instead of the hand-built prefix.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @kubepit/desktop test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src
git commit -m "fix(cost): one money format across the cost view, overview, dashboard and right-sizing"
```

---

### Task 8: "Add RoleBinding" checks the target namespace

**Files:**
- Create: `apps/desktop/src/components/workbench/actions/roleBindingTarget.ts`
- Modify: `apps/desktop/src/components/workbench/actions/wizardActions.ts:66-85`
- Test: `apps/desktop/src/components/workbench/actions/roleBindingTarget.test.ts`

**Interfaces:**
- Produces:
  - `roleBindingNamespace(objNamespace: string | null, selected: readonly string[] | undefined, cluster: Pick<ClusterDef, 'default_namespace'> | undefined): string`.
  - `roleBindingAccess(namespace: string): AccessCheck[]`.

- [x] **Step 1: Write the failing test**

```ts
// apps/desktop/src/components/workbench/actions/roleBindingTarget.test.ts
import { describe, expect, it } from 'vitest';
import { roleBindingAccess, roleBindingNamespace } from './roleBindingTarget';

describe('Add RoleBinding target', () => {
  it('binds in the object namespace, the single selected one, the cluster default, then default', () => {
    expect(roleBindingNamespace('team-a', ['x'], undefined)).toBe('team-a');
    expect(roleBindingNamespace(null, ['team-b'], { default_namespace: 'ops' })).toBe('team-b');
    expect(roleBindingNamespace(null, ['a', 'b'], { default_namespace: 'ops' })).toBe('ops');
    expect(roleBindingNamespace(null, undefined, undefined)).toBe('default');
  });
  it('asks for create rolebindings in that namespace, never cluster-wide', () => {
    expect(roleBindingAccess('team-b')).toEqual([
      expect.objectContaining({ verb: 'create', group: 'rbac.authorization.k8s.io', resource: 'rolebindings', namespace: 'team-b' }),
    ]);
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @kubepit/desktop test -- src/components/workbench/actions/roleBindingTarget.test.ts`
Expected: FAIL (module missing).

- [x] **Step 3: Implement.** `roleBindingAccess` returns `[accessCheck('create', toGvk(BUILTIN.RoleBinding), { namespace })]`. The Role/ClusterRole branch in `wizardActions` computes `namespace` with `roleBindingNamespace` and sets `access: roleBindingAccess(namespace)`, so `requiredAccess` no longer applies.

- [x] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @kubepit/desktop test && pnpm typecheck`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add apps/desktop/src
git commit -m "fix(rbac): Add RoleBinding checks create rolebindings in the target namespace"
```

---

### Task 9: RBAC gating for manifests apply

**Files:**
- Create: `apps/desktop/src/components/workbench/dock/manifests/access.ts`
- Modify: `apps/desktop/src/components/workbench/dock/manifests/model.ts:202-248` (`planApply`, `ApplyPlan.denied`)
- Modify: `apps/desktop/src/components/workbench/dock/manifests/useFleetReview.ts`, `FleetReview.tsx:391-470` (`TargetHeader` lock), `ApplyButton.tsx:10-31` (blocker)
- Modify: `apps/desktop/src/i18n/{en,tr}/dock.json`
- Test: `apps/desktop/src/components/workbench/dock/manifests/access.test.ts`

**Interfaces:**
- Produces:
  - `cellChecks(doc: ReviewDoc, target: ReviewTarget, badge: Badge, apiResources: readonly ApiResourceInfo[] | null): AccessCheck[]`. It returns `[]` when the kind does not resolve. The checks are `patch` (namespace, name), plus `create` when `badge === 'create'`. The namespace is `doc.namespace ?? target.namespace`; cluster-scoped kinds get `null`.
  - `deniedKey(targetKey: string, docIndex: number): string`, which is `` `${targetKey}#${docIndex}` ``.
  - `planApply(docs, targets, runs, selected, included, denied?: ReadonlySet<string>): ApplyPlan`, with `ApplyPlan.denied: number`.
  - `useApplyDenied(review): ReadonlySet<string>`. It reads `useAccess` per target cluster; unknown answers are never denied.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/components/workbench/dock/manifests/access.test.ts
import { describe, expect, it } from 'vitest';
import type { ApiResourceInfo } from '@/types';
import { cellChecks, deniedKey } from './access';
import { planApply, type ReviewDoc, type ReviewTarget, type TargetRun } from './model';

const res = (group: string, version: string, kind: string, plural: string, namespaced: boolean): ApiResourceInfo =>
  ({ group, version, kind, plural, namespaced, api_version: group ? `${group}/${version}` : version, verbs: [], short_names: [], categories: [] });
const api = [res('apps', 'v1', 'Deployment', 'deployments', true), res('', 'v1', 'Namespace', 'namespaces', false)];
const doc = (kind: string, apiVersion: string, namespace: string | null): ReviewDoc =>
  ({ id: kind, source: 'a.yaml', line: 1, apiVersion, kind, name: 'x', namespace, yaml: '' });
const target: ReviewTarget = { key: 'c1|shop', clusterId: 'c1', namespace: 'shop', readOnly: false, production: false };

describe('manifest apply access', () => {
  it('asks for patch, plus create for new objects, in the effective namespace', () => {
    expect(cellChecks(doc('Deployment', 'apps/v1', null), target, 'create', api)).toEqual([
      expect.objectContaining({ verb: 'patch', resource: 'deployments', namespace: 'shop', name: 'x' }),
      expect.objectContaining({ verb: 'create', resource: 'deployments', namespace: 'shop' }),
    ]);
    expect(cellChecks(doc('Namespace', 'v1', null), target, 'update', api)).toEqual([
      expect.objectContaining({ verb: 'patch', resource: 'namespaces', namespace: null }),
    ]);
  });
  it('asks nothing for kinds discovery does not know', () => {
    expect(cellChecks(doc('Widget', 'example.com/v1', 'shop'), target, 'create', api)).toEqual([]);
  });
  it('planApply leaves denied cells out and counts them', () => {
    const docs = [doc('Deployment', 'apps/v1', null), doc('Namespace', 'v1', null)];
    const run = { status: 'done', cells: [{ badge: 'create' }, { badge: 'update' }] } as unknown as TargetRun;
    const plan = planApply(docs, [target], { [target.key]: run }, new Set(['Deployment', 'Namespace']),
      new Set([target.key]), new Set([deniedKey(target.key, 0)]));
    expect(plan.targets[0]?.indexes).toEqual([1]);
    expect(plan.denied).toBe(1);
    expect(plan.changes).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @kubepit/desktop test -- src/components/workbench/dock/manifests/access.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement.**
  - Resolve the plural by `group` (from `apiVersion`) and `kind` in `apiResources`.
  - `useFleetReview` exposes `denied`, built from `useApplyDenied`.
  - `ApplyButton` shows the blocker "You may not apply {count} of the selected changes (RBAC)" (`i18n.plural`) when the plan is empty only because of denials. Otherwise it applies the rest and shows the count as a note.
  - `TargetHeader` shows `LockedIcon` with `deniedMessage` when every selected cell of the target is denied.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @kubepit/desktop test && pnpm typecheck && pnpm i18n:check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src
git commit -m "fix(manifests): gate apply per cell on RBAC"
```

---

### Task 10: Manifests watch via notify

**Files:**
- Create: `crates/kubepit-core/src/manifests/watch.rs`
- Modify: `crates/kubepit-core/src/manifests/mod.rs` (`pub mod watch;`; remove `manifests_fingerprint` at `:137-143`)
- Modify: `crates/kubepit-core/src/app.rs` (field `manifest_watches: TaskRegistry`; `stop_all` in `shutdown` near `:216`)
- Modify: `crates/kubepit-core/src/types.rs` (`ManifestsWatchEvent`)
- Modify: `apps/desktop/src-tauri/src/ipc/manifests.rs:22-29`, `apps/desktop/src-tauri/src/lib.rs:108`
- Modify: `apps/desktop/src/types/index.ts`, `apps/desktop/src/lib/ipc.ts:293-294`
- Modify: `apps/desktop/src/components/workbench/dock/manifests/ManifestsView.tsx:35-36,126-145`
- Modify: `apps/desktop/src/lib/ipc/mock/manifests.ts:143-145,348`
- Modify: `docs/ARCHITECTURE.md:525-526`
- Test: `crates/kubepit-core/tests/manifests.rs`

**Interfaces:**
- Produces:
  - Rust: `pub struct ManifestsWatchEvent { pub watch_id: String, pub fingerprint: String }`.
  - Rust: `pub const WATCH_DEBOUNCE: Duration = Duration::from_millis(300)`.
  - Rust: `impl Kubepit { pub fn manifests_watch<F>(&self, source: &ManifestSource, on_event: F) -> Result<String> where F: Fn(ManifestsWatchEvent) -> bool + Send + Sync + 'static; pub fn manifests_unwatch(&self, watch_id: &str) }`. It must be called inside a Tokio runtime and registers under cluster id `""`.
  - Tauri: `manifests_watch(source, on_event: Channel<ManifestsWatchEvent>) -> String` and `manifests_unwatch(watch_id)`.
  - TS: `ipc.manifestsWatch(source, onEvent): Promise<string>` and `ipc.manifestsUnwatch(watchId): Promise<void>`. `ipc.manifestsFingerprint` is removed.

- [ ] **Step 1: Write the failing tests** (add to `tests/manifests.rs`; reuse its existing app setup helper)

```rust
async fn next_event(rx: &mut tokio::sync::mpsc::UnboundedReceiver<ManifestsWatchEvent>, within: Duration) -> Option<ManifestsWatchEvent> {
    tokio::time::timeout(within, rx.recv()).await.ok().flatten()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn manifests_watch_reports_edits_after_debounce() {
    let (dir, app) = app_with_folder(&[("a.yaml", CONFIGMAP_A)]);
    let source = folder_source(dir.path());
    let initial = app.manifests_render(&source).await.unwrap().fingerprint;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let id = app.manifests_watch(&source, move |e| tx.send(e).is_ok()).unwrap();
    std::fs::write(dir.path().join("b.yaml"), CONFIGMAP_B).unwrap();
    let event = next_event(&mut rx, Duration::from_secs(3)).await.expect("an event");
    assert_eq!(event.watch_id, id);
    assert_ne!(event.fingerprint, initial);
    assert!(next_event(&mut rx, Duration::from_millis(800)).await.is_none(), "one event per burst");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn manifests_watch_sees_atomic_rename_saves() {
    let (dir, app) = app_with_folder(&[("a.yaml", CONFIGMAP_A)]);
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    app.manifests_watch(&folder_source(dir.path()), move |e| tx.send(e).is_ok()).unwrap();
    std::fs::write(dir.path().join(".a.yaml.swp"), CONFIGMAP_B).unwrap();
    std::fs::rename(dir.path().join(".a.yaml.swp"), dir.path().join("a.yaml")).unwrap();
    assert!(next_event(&mut rx, Duration::from_secs(3)).await.is_some());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn manifests_watch_ignores_skipped_files_and_stops_on_unwatch() {
    let (dir, app) = app_with_folder(&[("a.yaml", CONFIGMAP_A)]);
    std::fs::create_dir(dir.path().join("node_modules")).unwrap();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let id = app.manifests_watch(&folder_source(dir.path()), move |e| tx.send(e).is_ok()).unwrap();
    std::fs::write(dir.path().join("node_modules/x.yaml"), CONFIGMAP_B).unwrap();
    assert!(next_event(&mut rx, Duration::from_secs(1)).await.is_none());
    app.manifests_unwatch(&id);
    std::fs::write(dir.path().join("c.yaml"), CONFIGMAP_B).unwrap();
    assert!(next_event(&mut rx, Duration::from_secs(1)).await.is_none());
}
```

`app_with_folder`, `folder_source`, `CONFIGMAP_A` and `CONFIGMAP_B` are small helpers in the test file. They create a temp dir with the files and open `Kubepit` with `Paths` under the temp dir.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kubepit-core --test manifests manifests_watch`
Expected: FAIL (`manifests_watch` not found).

- [ ] **Step 3: Implement.**
  - `resolve(source)` and `helm_values(...)` give the root and the extra files.
  - A `notify::RecommendedWatcher` watches the root `Recursive` and each extra file's parent directory `NonRecursive`. Its callback sends into a `tokio::sync::mpsc::unbounded_channel`.
  - The task owns the watcher. After the first event it waits for `WATCH_DEBOUNCE` of quiet, recomputes `discover::fingerprint`, and calls `on_event` only when the fingerprint changed; it returns when `on_event` returns false.
  - `manifests_unwatch` calls `manifest_watches.stop(id)`.
  - `ManifestsView` starts a watch when `watch && active && source`, reloads when `event.fingerprint !== fingerprint`, and stops the watch on cleanup, including when the id arrives after unmount (pattern: `useLogStream.ts:46-90`).
  - The mock returns an id, never emits, and ignores unwatch.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p kubepit-core --test manifests && pnpm typecheck && cargo clippy --workspace --all-targets -- -D warnings`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates apps/desktop docs/ARCHITECTURE.md
git commit -m "feat(manifests): notify-based Watch replaces 2 s fingerprint polling"
```

---

### Task 11: Prometheus, Loki and cost settings when adding a cluster

**Files:**
- Modify: `crates/kubepit-core/src/types.rs:76` (`ClusterInput`)
- Modify: `crates/kubepit-core/src/cluster.rs:100-146`
- Modify: `apps/desktop/src/types/index.ts:92-108`
- Modify: `apps/desktop/src/components/cluster-editor/ClusterEditor.tsx:135-190,363-373`, `PrometheusFields.tsx:90`, `LokiFields.tsx:65`, `CostFields.tsx:158`
- Modify: `apps/desktop/src/components/workbench/metrics/usePrometheus.ts:40`, `dock/loki/useLoki.ts:21`, `cost/useCost.ts:40` (accept `ClusterId | null`)
- Modify: `apps/desktop/src/lib/ipc/mock/app.ts:345-379`
- Test: `crates/kubepit-core/tests/prometheus.rs`

**Interfaces:**
- Produces:
  - Rust `ClusterInput` gains `#[serde(default)] pub prometheus: PrometheusConfig`, `#[serde(default)] pub loki: LokiConfig` and `#[serde(default)] pub cost: crate::cost::CostConfig`.
  - TS `ClusterInput` gains `prometheus?: PrometheusConfig; loki?: LokiConfig; cost?: CostConfig`.
  - The field components take `clusterId: ClusterId | null`.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn cluster_add_keeps_observability_settings() {
    let dir = tempfile::tempdir().unwrap();
    let app = Kubepit::open(Paths::new(dir.path().join("home")), Arc::new(NullSink)).unwrap();
    let prometheus = PrometheusConfig::Service {
        namespace: "monitoring".into(), service: "prometheus-operated".into(), port: 9090,
        scheme: PrometheusScheme::Http, path_prefix: "/".into(),
    };
    let added = app.cluster_add(vec![ClusterInput {
        name: "Obs".into(), context: "fake".into(),
        kubeconfig_text: Some(support::kubeconfig_for("http://127.0.0.1:1")),
        prometheus: prometheus.clone(), loki: LokiConfig::Off, ..Default::default()
    }]).unwrap();
    assert_eq!(added[0].prometheus, prometheus.normalized().unwrap());
    assert_eq!(added[0].loki, LokiConfig::Off);
    let bad = ClusterInput { name: "Bad".into(), context: "fake".into(),
        kubeconfig_text: Some(support::kubeconfig_for("http://127.0.0.1:1")),
        prometheus: PrometheusConfig::Service { namespace: "a|b".into(), service: "x".into(), port: 1,
            scheme: PrometheusScheme::Http, path_prefix: "/".into() }, ..Default::default() };
    assert!(app.cluster_add(vec![bad]).is_err());
    assert_eq!(app.cluster_list().len(), 1);
}
```

Use the exact variant and field names of `PrometheusConfig::Service` from `types.rs:1283`. The scheme type may have a different name; take it from the struct.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p kubepit-core --test prometheus cluster_add_keeps_observability_settings`
Expected: FAIL. `ClusterInput` has no field `prometheus`.

- [ ] **Step 3: Implement.**
  - `cluster_add` validates every input's configs with the same `normalized()` calls as `cluster_update`, before anything is saved, and stores them.
  - The editor sends the drafts in add mode and drops the `editing &&` guards; `clusterId` is `editing?.id ?? null`.
  - The status hooks return idle for a `null` id.
  - The mock forwards the fields.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p kubepit-core && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates apps/desktop
git commit -m "feat(clusters): set Prometheus, Loki and cost sources when adding a cluster"
```

---

### Task 12: A `forbidden` state for service-proxy sources

**Files:**
- Modify: `crates/kubepit-core/src/service_proxy.rs:181-187` (add `is_proxy_forbidden`)
- Modify: `crates/kubepit-core/src/types.rs:1303-1312,1502-1511`
- Modify: `crates/kubepit-core/src/prometheus/mod.rs:140-206,278-294`, `crates/kubepit-core/src/loki/mod.rs:147-213,255-272`
- Modify: `crates/kubepit-core/src/cost/types.rs:123-144`, `crates/kubepit-core/src/cost/mod.rs:119-127,196-290`
- Modify: `apps/desktop/src/types/index.ts:1503,1626,2020`
- Create: `apps/desktop/src/components/workbench/common/ProxyForbiddenNotice.tsx`
- Modify: `apps/desktop/src/components/workbench/metrics/PrometheusControls.tsx:93-193`, `dock/promql/PromqlView.tsx:220-262`, `dock/loki/LokiView.tsx:431-472`, `cost/CostPage.tsx:101-108`
- Modify: `apps/desktop/src/lib/ipc/mock/prometheus.ts`, `mock/loki.ts`, `mock/cost.ts` (Loki on c-staging answers forbidden)
- Modify: `apps/desktop/src/i18n/{en,tr}/{workbench,dock}.json`, `docs/ARCHITECTURE.md` (Prometheus, Loki)
- Test: `crates/kubepit-core/tests/prometheus.rs`, `tests/loki.rs`, `tests/cost.rs`, unit test in `service_proxy.rs`

**Interfaces:**
- Produces:
  - `pub fn is_proxy_forbidden(err: &anyhow::Error) -> bool`: an `ApiError` with `code == 403 && reason == PROXY_REASON` anywhere in the error chain.
  - `PrometheusState::Forbidden`, `LokiState::Forbidden` (wire `"forbidden"`).
  - `CostStatus.forbidden: bool` (`#[serde(default)]`).
  - `ProxyForbiddenNotice({ what: string; namespace: string; message: string | null })`.
- The state rule, in both `detect_status`s and the cost status:
  - any candidate answered → `Available`;
  - else, when every probed candidate's error `is_proxy_forbidden` → `Forbidden`, with `service` set to the best candidate and `error` to its message;
  - else `Unreachable`.

- [ ] **Step 1: Write the failing tests**

```rust
// tests/prometheus.rs — the router answers every `/proxy/` path with a 403 Status
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn proxy_403_reports_forbidden_state() {
    let server = start(router_with(ProxyAnswer::Forbidden)).await;
    let (_dir, app, _rec, id) = setup(&server.url, false);
    app.cluster_connect(&id).await.unwrap();
    let st = app.prometheus_status(&id, false).await.unwrap();
    assert_eq!(st.state, PrometheusState::Forbidden);
    assert!(st.error.as_deref().unwrap().contains("services/proxy"), "{st:?}");
    assert!(st.service.is_some());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mixed_forbidden_and_unreachable_candidates_stay_unreachable() {
    let server = start(router_with(ProxyAnswer::ForbiddenThen503)).await;
    let (_dir, app, _rec, id) = setup(&server.url, false);
    app.cluster_connect(&id).await.unwrap();
    assert_eq!(app.prometheus_status(&id, false).await.unwrap().state, PrometheusState::Unreachable);
}
```

- `router_with` extends the file's existing detection router with a `ProxyAnswer` switch: `Forbidden` returns `Reply::Json(403, status(403, "Forbidden", "services \"http:prometheus-operated:9090\" is forbidden: User \"dev\" cannot get resource \"services/proxy\" in API group \"\" in the namespace \"monitoring\""))`. `ForbiddenThen503` returns 403 for the first candidate and 503 for the second.
- Add the same pair to `tests/loki.rs` (`LokiState`).
- In `tests/cost.rs` add `forbidden_cost_api_is_flagged`: `status.forbidden == true`, and `source == CostSourceKind::Estimate`.
- Unit test in `service_proxy.rs`, `is_proxy_forbidden_matches_only_proxy_403`: `proxy_error(403, ..)` → true; `proxy_error(503, ..)` → false; a plain kube 403 `ApiError` with reason `Forbidden` → false.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kubepit-core forbidden`
Expected: FAIL (`PrometheusState::Forbidden` not found).

- [ ] **Step 3: Implement.**
  - Add the variants and the field. Apply the state rule. Fix the cost `is_proxy_failure` comment to match the code.
  - `ProxyForbiddenNotice` says "Your account may not use the service proxy for {what}." and "Kubepit reaches it through the API server, which needs get on services/proxy in namespace {namespace}." It shows the API server message verbatim in a `CopyableCodeBlock`, plus a copyable `kubectl auth can-i get services/proxy -n {namespace}`.
  - Each view renders the notice for `forbidden` instead of its "does not answer" state.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p kubepit-core && pnpm typecheck && pnpm i18n:check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates apps/desktop docs/ARCHITECTURE.md
git commit -m "feat(observability): explain missing services/proxy permission for Prometheus, Loki and cost"
```

---

### Task 13: Broadcast settings between windows

**Files:**
- Modify: `apps/desktop/src-tauri/src/app_state.rs:26-27,77-83` (`EVENT_SETTINGS_CHANGED`, `SettingsChanged`)
- Modify: `apps/desktop/src-tauri/src/ipc/app.rs:20-24` (`settings_set`), `ipc/connectivity.rs:82` (`kubeconfig_storage_set`)
- Modify: `apps/desktop/src/types/index.ts` (`SettingsChanged`), `apps/desktop/src/lib/ipc.ts:637-660` (`events.onSettingsChanged`)
- Create: `apps/desktop/src/lib/settingsSync.ts`
- Modify: `apps/desktop/src/components/app/useAppBootstrap.ts:62-80`
- Modify: `apps/desktop/src/lib/ipc/mock/app.ts:280` (emit through `mockEmitAllWindows`; the mock `kubeconfig_storage_set` already calls `settings_set`)
- Modify: `docs/ARCHITECTURE.md:30-41` (global events)
- Test: `apps/desktop/src/lib/settingsSync.test.ts`; unit test in `app_state.rs`

**Interfaces:**
- Produces:
  - Rust `#[derive(Serialize)] pub struct SettingsChanged { pub source: String, pub settings: Settings }`, emitted as `settings://changed` by both commands after a successful save. `source` is the calling window's label.
  - TS `interface SettingsChanged { source: string; settings: Settings }`.
  - `events.onSettingsChanged(handler)`.
  - `remoteSettings(event: SettingsChanged, ownLabel: string): Settings | null`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/desktop/src/lib/settingsSync.test.ts
import { describe, expect, it } from 'vitest';
import type { Settings } from '@/types';
import { remoteSettings } from './settingsSync';

const settings = { change_journal: true } as unknown as Settings;
describe('remoteSettings', () => {
  it('applies settings saved by another window', () => {
    expect(remoteSettings({ source: 'win-2', settings }, 'main')).toBe(settings);
  });
  it('ignores the event from the saving window', () => {
    expect(remoteSettings({ source: 'main', settings }, 'main')).toBeNull();
  });
});
```

```rust
// app_state.rs tests
#[test]
fn settings_changed_payload_shape() {
    let value = serde_json::to_value(SettingsChanged { source: "win-1".into(), settings: Settings::default() }).unwrap();
    assert_eq!(value["source"], "win-1");
    assert!(value["settings"].is_object());
    assert_eq!(EVENT_SETTINGS_CHANGED, "settings://changed");
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @kubepit/desktop test -- src/lib/settingsSync.test.ts && cargo test -p kubepit-desktop settings_changed_payload_shape`
Expected: FAIL (missing module and struct).

- [ ] **Step 3: Implement.** Both commands take `app: tauri::AppHandle, window: tauri::Window` and `emit` after saving. `useAppBootstrap` listens with `events.onSettingsChanged((e) => { const s = remoteSettings(e, windowLabel); if (s) useAppStore.getState().setSettings(s); })`. Keep the `settingsGet` re-read in `useAlertNotifications`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @kubepit/desktop test && cargo test -p kubepit-desktop && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Verify in the demo.** Open two demo windows (`window_open`), mute a cluster in one, and check that the other window's bell menu shows it muted without a reload.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop docs/ARCHITECTURE.md
git commit -m "feat(settings): broadcast saved settings to every window (settings://changed)"
```

---

### Task 14: Notification click-through

**Files:**
- Create: `apps/desktop/src/lib/alerts/clickThrough.ts`
- Modify: `apps/desktop/src/components/alerts/useAlertNotifications.ts:60-100`
- Modify: `apps/desktop/src/lib/alerts/notify.ts:9-11` (comment)
- Modify: `apps/desktop/src/components/settings/NotificationsCategory.tsx` (help text)
- Modify: `apps/desktop/src/i18n/{en,tr}/shell.json`, `docs/ARCHITECTURE.md:356-366`
- Test: `apps/desktop/src/lib/alerts/clickThrough.test.ts`

**Interfaces:**
- Produces:
  - `CLICK_WINDOW_MS = 10_000`.
  - `createClickThrough(windowMs?: number): { posted(run: () => void, now: number): void; focused(now: number): (() => void) | null; clear(): void }`. The action is one-shot, and a newer post replaces an older one.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/lib/alerts/clickThrough.test.ts
import { describe, expect, it, vi } from 'vitest';
import { CLICK_WINDOW_MS, createClickThrough } from './clickThrough';

describe('click-through', () => {
  it('returns the last posted target when focus follows within the window, once', () => {
    const ct = createClickThrough();
    const a = vi.fn(); const b = vi.fn();
    ct.posted(a, 1_000); ct.posted(b, 2_000);
    expect(ct.focused(2_000 + CLICK_WINDOW_MS - 1)).toBe(b);
    expect(ct.focused(2_500)).toBeNull();
  });
  it('expires after the window', () => {
    const ct = createClickThrough();
    ct.posted(() => {}, 0);
    expect(ct.focused(CLICK_WINDOW_MS + 1)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @kubepit/desktop test -- src/lib/alerts/clickThrough.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement.**
  - After a successful desktop `postNotification` (`isTauri`) while `!document.hasFocus()`, call `posted(notification.onClick, Date.now())`.
  - Register `getCurrentWindow().onFocusChanged(({ payload }) => { if (payload) ct.focused(Date.now())?.(); })` from `@tauri-apps/api/window` and unlisten on cleanup.
  - Help text: "Clicking a desktop notification brings Kubepit to the front and opens the alert (within 10 seconds)."

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @kubepit/desktop test && pnpm typecheck && pnpm i18n:check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop docs/ARCHITECTURE.md
git commit -m "feat(alerts): open the notified alert when Kubepit is focused from a desktop notification"
```

---

### Task 15: Explicit coverage in the deprecation table

**Files:**
- Modify: `crates/kubepit-core/src/upgrade/deprecated_apis.json` (`checked_through`, `no_removals`, `updated`, `_comment`)
- Modify: `crates/kubepit-core/src/upgrade/deprecations.rs:32-51` and tests `:149-231`
- Modify: `crates/kubepit-core/src/upgrade.rs:158` (`UpgradeReport.table_checked_through`), `:508`
- Modify: `apps/desktop/src/types/index.ts:1800-1802`, `apps/desktop/src/lib/kube/deprecations.ts:34`
- Modify: `apps/desktop/src/components/workbench/upgrade/UpgradeReadinessPage.tsx:~197`, `apps/desktop/src/lib/ipc/mock/upgrade.ts`
- Modify: `apps/desktop/src/i18n/{en,tr}/workbench.json`, `docs/ARCHITECTURE.md:159-165`
- Test: `crates/kubepit-core/src/upgrade/deprecations.rs` (unit)

**Interfaces:**
- Produces:
  - `pub fn table_checked_through() -> &'static str` and `pub fn no_removals() -> &'static [String]`.
  - `UpgradeReport.table_checked_through: String`.
  - TS `DEPRECATIONS_CHECKED_THROUGH: string`.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn table_accounts_for_every_minor() {
    let through = Minor::parse(table_checked_through()).expect("checked_through parses");
    let removed: HashSet<String> = table().iter().filter_map(|e| e.removed_in.clone()).collect();
    let quiet: HashSet<&str> = no_removals().iter().map(String::as_str).collect();
    let newest = table().iter()
        .flat_map(|e| [Some(&e.deprecated_in), e.removed_in.as_ref()])
        .flatten().filter_map(|v| Minor::parse(v)).max().unwrap();
    assert!(through >= newest, "checked_through {through} is older than {newest}");
    let mut minor = Minor::parse("1.16").unwrap();
    while minor <= through {
        let v = minor.to_string();
        assert!(removed.contains(&v) ^ quiet.contains(v.as_str()), "{v}: removed_in xor no_removals");
        minor = minor.next();
    }
    assert!(quiet.iter().all(|v| Minor::parse(v).is_some_and(|m| m <= through)));
}
```

Match `Minor`'s real API: `parse` returns an `Option` or a `Result`; it provides `next()` and `Display`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p kubepit-core upgrade::deprecations`
Expected: FAIL (`table_checked_through` not found).

- [ ] **Step 3: Update the table.**
  1. Check https://kubernetes.io/docs/reference/using-api/deprecation-guide/ and the "Deprecation" sections of `CHANGELOG-1.33.md` and every newer released `CHANGELOG-1.xx.md`. On 2026-09-28 the guide lists removals only for 1.16, 1.22, 1.25, 1.26, 1.27, 1.29 and 1.32.
  2. Add any newly scheduled removal of a beta or GA API as an entry.
  3. Set `no_removals` to `["1.17","1.18","1.19","1.20","1.21","1.23","1.24","1.28","1.30","1.31","1.33"]` plus every newer checked minor without removals.
  4. Set `checked_through` to the newest checked minor and bump `updated`.
  5. Extend `_comment` with how to maintain both fields.

- [ ] **Step 4: Implement the readers, the report field, the mock and the UI note.** The note reads "The deprecated-API table was checked through Kubernetes {version}; later releases may remove more APIs." and is shown when the target minor is newer than `checked_through`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p kubepit-core upgrade && pnpm typecheck && pnpm i18n:check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates apps/desktop docs/ARCHITECTURE.md
git commit -m "fix(upgrade): record which minors were checked in the deprecation table and test coverage"
```

---

### Task 16: Show the fields a new chart drops in the Helm preview

**Files:**
- Modify: `crates/kubepit-core/src/change_journal/diff.rs` (`dropped_paths`)
- Modify: `crates/kubepit-core/src/helm_preview.rs:345-362,539-594`
- Modify: `apps/desktop/src/types/index.ts:1127-1143`
- Modify: `apps/desktop/src/components/workbench/helm/UpgradeChanges.tsx:~256-275`
- Modify: `apps/desktop/src/lib/ipc/mock/helmPreview.ts:119-170` (one demo object drops an annotation)
- Modify: `apps/desktop/src/i18n/{en,tr}/workbench.json`, `docs/ARCHITECTURE.md:139-152`
- Test: unit tests in `diff.rs`; `crates/kubepit-core/tests/helm_preview.rs`

**Interfaces:**
- Produces:
  - `pub fn dropped_paths(before: &Value, after: &Value, live: &Value) -> Vec<String>`. It returns the paths of leaves or subtrees present in `before`, absent in `after` and present in `live`. Keyed list items use `name` / `mountPath`, and the path syntax is `changed_paths`'s.
  - `HelmPreviewObject.dropped_fields: Vec<String>` (`#[serde(default)]`), filled for `Changed` objects with a live result.
  - TS `dropped_fields: string[]`.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn dropped_paths_are_old_render_minus_new_render_still_live() {
    let before = json!({"metadata": {"annotations": {"a": "1", "keep": "x"}},
        "spec": {"template": {"spec": {"containers": [{"name": "api", "env": [{"name": "DEBUG", "value": "1"}, {"name": "LOG", "value": "i"}]}]}}}});
    let after = json!({"metadata": {"annotations": {"keep": "x"}},
        "spec": {"template": {"spec": {"containers": [{"name": "api", "env": [{"name": "LOG", "value": "i"}]}]}}}});
    let live = json!({"metadata": {"annotations": {"a": "1", "keep": "x", "server": "y"}},
        "spec": {"replicas": 2, "template": {"spec": {"containers": [{"name": "api", "env": [{"name": "DEBUG", "value": "1"}, {"name": "LOG", "value": "i"}]}]}}}});
    assert_eq!(dropped_paths(&before, &after, &live), vec![
        r#"metadata.annotations["a"]"#.to_string(),
        "spec.template.spec.containers[api].env[DEBUG]".to_string(),
    ]);
}

#[test]
fn dropped_paths_skip_fields_already_gone_live() {
    let before = json!({"spec": {"paused": true}});
    assert!(dropped_paths(&before, &json!({"spec": {}}), &json!({"spec": {}})).is_empty());
}
```

- In `tests/helm_preview.rs`, extend `upgrade_preview_diffs_objects_and_live_state_on_read_only_clusters`:
  - the old release manifest's Deployment carries annotation `example.com/legacy: "on"`;
  - the new render omits it;
  - the live Deployment (the router's `deployment(replicas)`) has it;
  - assert `object.dropped_fields == [r#"metadata.annotations["example.com/legacy"]"#]`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kubepit-core dropped_paths && cargo test -p kubepit-core --test helm_preview`
Expected: FAIL (`dropped_paths` not found).

- [ ] **Step 3: Implement.** `dropped_paths` reuses the keyed-list `Walker`. It emits a path when `before` has the node and `after` does not, but only if a structured lookup of the same segments finds it in `live`. `helm_upgrade_preview` fills the field after the live dry run from `before`, `after` and `live.live`. `UpgradeChanges` lists the paths under "Helm will remove these fields from the live object", adds the count to the object row and removes the old caveat line.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p kubepit-core && pnpm typecheck && pnpm i18n:check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates apps/desktop docs/ARCHITECTURE.md
git commit -m "feat(helm): show fields the new chart drops from live objects in the upgrade review"
```

---

### Task 17: Fake-server request headers and the Loki tenant

**Files:**
- Modify: `crates/kubepit-core/tests/support/mod.rs:20-25,65-102`
- Modify: `crates/kubepit-core/tests/fake_apiserver.rs`, `crates/kubepit-core/tests/loki.rs`

**Interfaces:**
- Produces, used by Task 18 and the performance plan:
  - `support::Request { method, path, body, headers: Vec<(String, String)> }`, with header names lowercased.
  - `Request::header(&self, name: &str) -> Option<&str>` (case-insensitive).
  - `Request::path_only(&self) -> &str` (the path without the query).

- [ ] **Step 1: Write the failing tests**

```rust
// tests/fake_apiserver.rs
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn request_headers_are_recorded() {
    let server = start(cluster_router()).await;
    let (_dir, app, _rec, id) = setup(&server.url, false);
    app.cluster_connect(&id).await.unwrap();
    let log = server.log.lock();
    let version = log.iter().find(|r| r.path_only() == "/version").unwrap();
    assert_eq!(version.header("Authorization"), Some("Bearer test-token"));
}

// tests/loki.rs
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn configured_tenant_reaches_every_loki_request() {
    let server = start(router()).await;
    let (_dir, app, _rec, id) = setup(&server.url, false);
    configure_gateway(&app, &id, Some(" team-a "));
    app.cluster_connect(&id).await.unwrap();
    app.loki_labels(&id, &labels_query()).await.unwrap();
    app.loki_query_range(&id, &query("{namespace=\"shop\"}")).await.unwrap();
    let log = server.log.lock();
    let proxied: Vec<_> = log.iter().filter(|r| r.path.contains("/proxy/")).collect();
    assert!(!proxied.is_empty());
    assert!(proxied.iter().all(|r| r.header("x-scope-orgid") == Some("team-a")), "{proxied:#?}");
    assert!(log.iter().filter(|r| !r.path.contains("/proxy/")).all(|r| r.header("x-scope-orgid").is_none()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn detected_loki_sends_no_tenant() {
    let server = start(router()).await;
    let (_dir, app, _rec, id) = setup(&server.url, false);
    app.cluster_connect(&id).await.unwrap();
    app.loki_status(&id, false).await.unwrap();
    assert!(server.log.lock().iter().all(|r| r.header("x-scope-orgid").is_none()));
}
```

`configure_gateway`, `labels_query` and `query` reuse the builders already in `tests/loki.rs` (see `configured_service_off_and_not_found`); take the call signatures from that file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kubepit-core --test fake_apiserver request_headers && cargo test -p kubepit-core --test loki tenant`
Expected: FAIL (`header` not found).

- [ ] **Step 3: Implement.** In `handle`, parse every `name: value` line of the request head into `headers`, with trimmed values and lowercase names.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p kubepit-core`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/kubepit-core/tests
git commit -m "test(harness): record request headers; test the Loki tenant header end to end"
```

---

### Task 18: Background work is opt-in; guard test

**Files:**
- Modify: `crates/kubepit-core/src/metrics_history.rs:274-300,369-373`
- Modify: `apps/desktop/src-tauri/src/setup.rs:24-30`
- Modify: `crates/kubepit-core/tests/fleet.rs:381` (opt in)
- Create: `crates/kubepit-core/tests/background.rs`
- Modify: `docs/ARCHITECTURE.md:315-317` (Fleet)

**Interfaces:**
- Consumes: `Request::path_only` (Task 17).
- Produces: `impl Kubepit { pub fn set_metrics_sampling(&self, on: bool); pub fn metrics_sampling(&self) -> bool }`.
  - On: clusters that connect from now on are sampled.
  - Off: every sampler stops and histories are dropped.
  - Default: off.

- [ ] **Step 1: Write the failing test**

```rust
// tests/background.rs
mod support;
use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::Duration;
use kubepit_core::types::{ClusterInput, HistorySettings, Settings};
use kubepit_core::{Kubepit, Paths};
use support::{start, status, Log, Reply, Request, Router};

/// Answers discovery, empty lists and quiet watches for every path.
fn quiet_router() -> Router { /* /version, /apis, /api/v1 (pods, nodes, events), apps/v1 deployments, batch/v1 jobs; lists → empty *List; watch=true → Reply::Stream(vec![]); metrics.k8s.io → empty lists */ }

fn setup_defaults(url: &str) -> (tempfile::TempDir, Arc<Kubepit>, String) { /* like support::setup, but without accessible_namespaces and without touching Settings.change_journal */ }

fn seen(log: &Log) -> BTreeSet<String> {
    log.lock().iter().map(|r| format!("{} {}", r.method, r.path_only())).collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn connect_starts_no_background_work_unless_opted_in() {
    let server = start(quiet_router()).await;
    let (_dir, app, id) = setup_defaults(&server.url);
    app.cluster_connect(&id).await.unwrap();
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(seen(&server.log), BTreeSet::from(["GET /apis".to_string(), "GET /version".to_string()]));
    assert!(app.alert_monitored_clusters().is_empty());
    assert!(!app.history_status().recording);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn each_opt_in_starts_its_own_traffic() {
    let server = start(quiet_router()).await;
    let (_dir, app, id) = setup_defaults(&server.url);
    app.set_metrics_sampling(true);
    app.set_alert_monitoring(true);
    app.set_change_journal_recording(true);
    app.set_history_recording(true);
    app.set_settings(Settings { history: HistorySettings { persist_clusters: vec![id.clone()], ..Default::default() }, ..app.settings() }).unwrap();
    app.cluster_connect(&id).await.unwrap();
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let paths = seen(&server.log);
    for expected in ["GET /apis/metrics.k8s.io/v1beta1/nodes", "GET /api/v1/pods", "GET /apis/apps/v1/deployments", "GET /api/v1/events"] {
        assert!(paths.contains(expected), "missing {expected} in {paths:#?}");
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kubepit-core --test background`
Expected: FAIL. `set_metrics_sampling` is not found; without it the first test also sees the metrics lists.

- [ ] **Step 3: Implement.**
  - `MetricsHistory` gains `active: AtomicBool`. `start_metrics_sampler` returns early while it is false, and `set_metrics_sampling(false)` calls `stop_all`.
  - `setup.rs` calls `core.set_metrics_sampling(true)` next to the other switches.
  - `tests/fleet.rs::metrics_history_is_sampled_while_connected` calls `app.set_metrics_sampling(true)` before connecting.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --workspace`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates apps/desktop/src-tauri docs/ARCHITECTURE.md
git commit -m "fix(core): metrics sampling is opt-in per process; guard background work in tests"
```

---

### Task 19: Audit custom actions; guard every mutating command

**Files:**
- Modify: `crates/kubepit-core/src/history/types.rs:67-145` (`CustomAction`, `ALL`, `as_str`)
- Modify: `crates/kubepit-core/src/custom_actions/mod.rs:275` (rename to `custom_action_run_unaudited`, `pub(crate)`), `:321` (`prepare_custom_action_terminal_unaudited`); add `redacted_command`
- Modify: `crates/kubepit-core/src/history/audited.rs` (two wrappers)
- Modify: `apps/desktop/src/types/index.ts:702-724`, `apps/desktop/src/lib/history/audit.ts:35-120`
- Modify: `apps/desktop/src/lib/ipc/mock/history.ts` (wrap `custom_action_run` for mutating actions)
- Create: `apps/desktop/src-tauri/src/ipc/audit_coverage.rs`; modify `apps/desktop/src-tauri/src/ipc/mod.rs` (`#[cfg(test)] mod audit_coverage;`)
- Modify: `apps/desktop/src/i18n/{en,tr}/shell.json`, `docs/ARCHITECTURE.md:605-624`
- Test: `crates/kubepit-core/tests/history.rs`, `apps/desktop/src-tauri/src/ipc/audit_coverage.rs`

**Interfaces:**
- Produces:
  - `AuditAction::CustomAction`, wire `"custom-action"`, not revertible.
  - `pub(crate) fn redacted_command(&self, action: &CustomAction, cluster: &ClusterDef, target: &CustomActionTarget, redactor: &Redactor) -> Result<String>`. It renders `render_shell` with every `annotations.*` value replaced by `redactor.secret_marker(key, value)`, and every `labels.*` value too when `redact::secret_like(target.kind)`.
  - The public `custom_action_run` and `prepare_custom_action_terminal` keep their signatures and become the audited entry points.
  - Audit request `{ "action": name, "id": id, "mode": "background" | "terminal", "command": redacted, "targets": n }`.
  - Audit result: `exit {code}`, or the error `timed out after {s}s`; a non-zero exit is recorded with `Audit::fail`.
  - Targets: `AuditTarget::document(api_version, kind, namespace, name)` per selected name (≤ 20); cluster runs use the cluster as the target.

- [ ] **Step 1: Write the failing tests**

```rust
// tests/history.rs
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mutating_custom_actions_are_audited_without_output() {
    if !cfg!(unix) { return; }
    let server = start(router()).await;
    let (dir, app, _recorder, id) = setup(&server.url, false);
    enable(&app, dir.path(), HistorySettings::default());
    let import = app.custom_actions_import(None, Some(&json!([
        { "id": "mut", "name": "Echo", "mode": "background", "mutating": true,
          "command": "printf '%s %s' {annotations.kubectl.kubernetes.io/last-applied-configuration} {name}" },
        { "id": "read", "name": "Read", "mode": "background", "command": "printf ok" }
    ]).to_string())).unwrap();
    app.custom_actions_save(import.actions).unwrap();
    let mut target = pod_target("web-0");
    target.kind = Some("Secret".into());
    target.annotations.insert("kubectl.kubernetes.io/last-applied-configuration".into(), r#"{"data":{"password":"hunter2"}}"#.into());
    let out = app.custom_action_run(&id, "mut", &target).await.unwrap();
    assert!(out.stdout.contains("hunter2"));
    app.custom_action_run(&id, "read", &target).await.unwrap();

    let all = entries(&app);
    let entry = find(&all, AuditAction::CustomAction);
    let text = serde_json::to_string(entry).unwrap();
    assert!(!text.contains("hunter2"), "{text}");
    assert!(text.contains("web-0"));
    assert_eq!(all.iter().filter(|e| e.action == AuditAction::CustomAction).count(), 1, "non-mutating runs are not audited");
    assert!(app.history_flush());
    let raw = std::fs::read(dir.path().join("home/history.db")).unwrap();
    assert!(!String::from_utf8_lossy(&raw).contains("hunter2"));
}
```

- `pod_target` builds a `CustomActionTarget` for a pod in `default`.
- Match the database path to how `enable`/`setup` lay out `Paths` in this file.
- Also check the WAL file, as `secret_values_never_reach_the_database_file` does.
- Extend `read_only_rejections_are_not_recorded_but_dry_runs_are`: a refused mutating custom action on a read-only cluster adds no entry.

```rust
// apps/desktop/src-tauri/src/ipc/audit_coverage.rs
//! Every registered Tauri command is classified; every mutating one must call
//! an audited entry point defined in `kubepit-core/src/history/audited.rs`.
const LIB: &str = include_str!("../lib.rs");
const AUDITED: &str = include_str!("../../../../../crates/kubepit-core/src/history/audited.rs");
const CORE_TERMINAL: &str = include_str!("../../../../../crates/kubepit-core/src/terminal.rs");
const RESOURCES: &str = include_str!("resources.rs");
const WORKLOADS: &str = include_str!("workloads.rs");
const MANIFESTS: &str = include_str!("manifests.rs");
const HELM: &str = include_str!("helm.rs");
const HELM_CHARTS: &str = include_str!("helm_charts.rs");
const LOGS_DEBUG: &str = include_str!("logs_debug.rs");
const COST: &str = include_str!("cost.rs");
const CUSTOM_ACTIONS: &str = include_str!("custom_actions.rs");

/// (command, source that must call the methods, audited core methods)
const MUTATING: &[(&str, &str, &[&str])] = &[
    ("resource_apply_yaml", RESOURCES, &["resource_apply_yaml"]),
    ("resource_delete", RESOURCES, &["resource_delete"]),
    ("resource_patch", RESOURCES, &["resource_patch"]),
    ("resource_scale", RESOURCES, &["resource_scale"]),
    ("resource_restart", RESOURCES, &["resource_restart"]),
    ("cronjob_trigger", RESOURCES, &["cronjob_trigger"]),
    ("node_cordon", RESOURCES, &["node_cordon"]),
    ("node_drain", RESOURCES, &["node_drain"]),
    ("rollout_undo", WORKLOADS, &["rollout_undo"]),
    ("resource_set_image", WORKLOADS, &["resource_set_image"]),
    ("manifests_apply", MANIFESTS, &["manifests_apply"]),
    ("helm_rollback", HELM, &["helm_rollback"]),
    ("helm_uninstall", HELM, &["helm_uninstall"]),
    ("helm_upgrade_values", HELM, &["helm_upgrade_values"]),
    ("helm_install", HELM_CHARTS, &["helm_install"]),
    ("helm_upgrade", HELM_CHARTS, &["helm_upgrade"]),
    ("pod_debug", LOGS_DEBUG, &["pod_debug"]),
    ("pod_fs_upload", LOGS_DEBUG, &["pod_fs_upload"]),
    ("rightsizing_apply", COST, &["rightsizing_apply"]),
    ("custom_action_run", CUSTOM_ACTIONS, &["custom_action_run"]),
    ("terminal_create", CORE_TERMINAL, &["start_node_shell", "prepare_custom_action_terminal"]),
];
/// Read-only, dry-run-only or local-state commands (explicitly listed).
const NOT_MUTATING: &[&str] = &[ /* every other name in generate_handler!, e.g. "resource_dry_run_yaml", "manifests_dry_run", "pod_security_dry_run", "helm_upgrade_preview", "settings_set", "cluster_add", "port_forward_start", "helm_repo_add", "history_clear", … */ ];

fn registered() -> Vec<String> { /* names between `generate_handler![` and `])` in LIB, last `::` segment, comments skipped */ }
fn body<'a>(src: &'a str, command: &str) -> &'a str { /* from `pub async fn {command}(` to the next `#[tauri::command]` or EOF; whole file when not found (core sources) */ }

#[test]
fn every_registered_command_is_classified() {
    for name in registered() {
        let mutating = MUTATING.iter().any(|(c, ..)| *c == name);
        assert!(mutating ^ NOT_MUTATING.contains(&name.as_str()), "classify `{name}` in audit_coverage.rs");
    }
}

#[test]
fn classification_has_no_stale_names() {
    let names = registered();
    for c in MUTATING.iter().map(|(c, ..)| *c).chain(NOT_MUTATING.iter().copied()) {
        assert!(names.iter().any(|n| n == c), "`{c}` is not registered any more");
    }
}

#[test]
fn mutating_commands_call_audited_entry_points() {
    for (command, source, methods) in MUTATING {
        for method in *methods {
            assert!(body(source, command).contains(&format!(".{method}(")), "`{command}` must call `{method}`");
            assert!(AUDITED.contains(&format!("fn {method}(")), "`{method}` must be defined in history/audited.rs");
        }
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p kubepit-core --test history mutating_custom_actions && cargo test -p kubepit-desktop audit_coverage`
Expected: FAIL. `AuditAction::CustomAction` is missing; `custom_action_run` and `prepare_custom_action_terminal` are not defined in `audited.rs`.

- [ ] **Step 3: Implement.**
  - Wrappers per the Interfaces: audit only `mutating` actions in `Background` or `Terminal` mode.
  - A read-only refusal happens inside `runnable_action`, before `self.audit(...)` returns `Some`, so nothing is recorded.
  - Fill `NOT_MUTATING` from the current `generate_handler!` list.
  - The TS union, `AUDIT_ACTIONS`, `actionLabel` ("Custom action") and `actionTone` (tone of `patch`) gain `custom-action`.
  - The mock history wraps `custom_action_run` when the saved action is mutating.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --workspace && pnpm typecheck && pnpm i18n:check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates apps/desktop docs/ARCHITECTURE.md
git commit -m "feat(history): audit mutating custom actions; guard that every mutating command is audited"
```

---

### Task 20: Final verification

**Files:** none new.

- [ ] **Step 1: Run every check**

Run: `pnpm typecheck && pnpm i18n:check && cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace && pnpm --filter @kubepit/desktop build && pnpm --filter @kubepit/desktop test`
Expected: every command exits 0.

- [ ] **Step 2: Smoke-test the demo.** In `pnpm dev:ui`, open Health (the "Off by default" card), a Node's Map tab, Changes in a narrow pane, the Cost view (money formats), the Loki tab on staging (forbidden notice), the Manifests tab with Watch on, the Upgrade view with a target past `checked_through`, and the Activity view. Expected: no console errors.
