<p align="center">
  <img src="docs/icon.png" alt="Kubepit" width="128" height="128" />
</p>

<h1 align="center">Kubepit</h1>

<p align="center">
  <b>One cockpit for every Kubernetes cluster you touch.</b><br />
  Sections, tags, live resource tables, logs, shells, port forwards, Helm and YAML — in one window.
</p>

---

Kubepit is a local-first Kubernetes IDE in the spirit of Lens/Freelens, built with the
[RunHQ](https://github.com/erdembas/runhq) stack and design system: a Rust core on Tauri 2
and a React UI.

## What it does

- **Many clusters, organised.** Import contexts from any kubeconfig (auto-discovery of
  `$KUBECONFIG`, `~/.kube` and extra folders, or paste one), then group clusters into
  colour-coded **sections**, **tag** them, label their **environment**
  (production/staging/testing/development/local) and filter or group the sidebar by any of it.
- **Fleet dashboard.** Connection state, node and pod health, CPU/memory usage and
  warning events across every connected cluster.
- **Cluster workbench.** Resource navigator for every built-in kind and every CRD, live
  (watch-based) tables with Freelens-style columns, a details panel, YAML editing,
  events, metrics, scale/restart/cordon/drain/trigger actions.
- **Dock.** Pod logs with follow/search/previous, pod exec and attach, node shells,
  a cluster-scoped local terminal (`KUBECONFIG` pre-set), create/edit resources in YAML.
- **Port forwarding** for pods and services, managed from one place.
- **Helm releases** read straight from the cluster; rollback, uninstall and values upgrades.
- **Workload operations.** Live rollout status, revision history with diffs and rollback,
  pause/resume, set image, and a server-side dry-run review before every apply.
- **Merged logs and debugging.** Logs of every pod of a workload in one stream, ephemeral
  debug containers (`kubectl debug`) and a container file browser with download/upload.
- **Helm charts.** Repositories, a chart catalog with Artifact Hub search, READMEs and
  values, dry-run previews, installs, upgrades and revision diffs.
- **Fleet tools.** An hour of CPU/memory history without Prometheus, search across every
  connected cluster (⌘⇧F), and cross-cluster compare and drift checks.
- **RBAC-aware.** Actions and kinds you may not use are locked with the reason, and
  _My Permissions_ shows who you are and what you can do, like `kubectl auth can-i`.
- **Safety.** Read-only clusters, typed confirmation for destructive actions on production.
- **English and Turkish** UI.

## Local-first

- No account, no telemetry.
- State lives under `~/.kubepit/` as human-readable JSON.
- Kubepit never modifies your kubeconfig files; pasted kubeconfigs are stored with
  owner-only permissions.

## Development

Requirements: Node.js 22+, pnpm 9, Rust stable (1.89+), Tauri platform dependencies,
and `kubectl` (and optionally `helm`) on your `PATH` for shells and Helm actions.

```bash
pnpm install
pnpm dev        # Tauri app with hot reload
pnpm dev:ui     # UI only, in a browser, against the built-in demo backend
```

Checks:

```bash
pnpm typecheck
pnpm i18n:check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all
```

### Repo layout

```
kubepit/
├── apps/desktop/          # Tauri + React desktop app
│   ├── src/               # UI (shell, dashboard, workbench, dock)
│   └── src-tauri/         # Tauri shell: IPC commands, PTY terminals
├── crates/kubepit-core/   # Kubernetes access, kubeconfig, persistence
└── docs/ARCHITECTURE.md
```

## License

MIT © [Erdem Baş](https://github.com/erdembas). See [LICENSE](./LICENSE).
