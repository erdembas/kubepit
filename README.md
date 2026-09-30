<p align="center">
  <img src="docs/icon.png" alt="Kubepit" width="112" height="112" />
</p>

<h1 align="center">Kubepit</h1>

<p align="center">
  <strong>Your clusters. Your cockpit.</strong><br />
  A local-first Kubernetes IDE for understanding, debugging and changing your fleet.
</p>

<p align="center">
  <a href="https://erdembas.github.io/kubepit/">Website</a> ·
  <a href="https://erdembas.github.io/kubepit/demo/">Try the browser demo</a> ·
  <a href="docs/README.tr.md">Türkçe</a> ·
  <a href="CONTRIBUTING.md">Contribute</a>
</p>

<p align="center"><strong>v0.0.1 · Experimental · MIT licensed · English & Turkish</strong></p>

Kubepit brings live resource tables, logs, terminals, topology, change history,
Helm, GitOps and fleet operations into one desktop workspace. Follow an incident
from a failing workload to its logs, dependencies and recent changes, then review
the fix in the same place.

**The whole product is open source.** There are no paid editions, account gates or
feature tiers. MIT permits personal and commercial use. Optional services you
choose, such as hosted AI providers, have their own terms and costs.

This is the first public version, **0.0.1**. Expect rough edges and evolving APIs.
Start with the demo or a development cluster. The getting-started path for this
release is building from source; this README does not imply that signed installers
or an automatic-update feed are available.

![Kubepit workbench with synthetic Kubernetes resources](apps/website/public/workbench.png)

## Try it before connecting anything

The [browser demo](https://erdembas.github.io/kubepit/demo/) runs the actual desktop
frontend against an in-memory backend, with synthetic clusters, workloads, logs,
metrics and incidents. It needs no account, kubeconfig or Kubernetes cluster.
Cluster operations and AI responses are simulated; no real shell, cluster or AI
provider is invoked. Demo resource changes reset on reload; some UI preferences
may remain in browser storage. Do not enter real credentials into the demo.

A short tour:

1. Open `prod-eu-west-1` and explore the fleet and cluster overviews.
2. Find `checkout/payment-api-7c9d8b6f5-x2kqp`; inspect its logs, events and resource map.
3. Open Health, Changes, Network Policy and Recommendations to see the fixture fleet from different angles.
4. Explore Helm and GitOps; inspect a diff before changing a fixture resource.
5. Enable keyboard mode in Settings, or enable the simulated Assistant and a demo cluster to try its context preview.

Prefer a local preview? Only Node.js 22+ and pnpm 9.14.4 are needed:

```bash
git clone https://github.com/erdembas/kubepit.git
cd kubepit
pnpm install --frozen-lockfile
pnpm dev:ui
```

## Built around the work, from investigation to review

### A workspace for your fleet

Import or paste kubeconfigs, organize clusters into colored sections, add tags and
environment labels, and search across connected clusters. Compare resources across
clusters, inspect drift and review a manifest against multiple targets before
applying. Split panes, pinned tabs, saved table views, bookmarks and multiple
windows keep useful context within reach.

### Follow the evidence

Live tables cover built-in resources and discovered CRDs. Open related objects in
the resource map; combine workload logs across pods and containers; filter
structured records by level and field; correlate events, rollout revisions and
changes. CPU and memory history can come from metrics-server, with richer charts
and historical logs available through Prometheus and Loki.

### Review the change you are about to make

YAML completion and validation use the connected cluster's OpenAPI schema,
including CRDs. Server-side dry runs show live-to-result diffs; production apply
requires review. Helm upgrades expose rendered and live diffs, values schemas and
fields the new chart drops. Read-only clusters, RBAC hints and typed production
confirmations help keep the target and consequence visible.

### Keep your keyboard habits

Optional vim/k9s-style navigation adds `j`/`k`, `/`, `:` commands and resource
shortcuts. Custom actions run your own terminal or background commands, or open
URLs with resource context. Import supported k9s plugin definitions with conversion
notes. A cluster-scoped local terminal, pod exec/attach, debug containers, file
browsing and saved port forwards are part of the desktop workflow.

If you like Freelens-style resource exploration, Kubepit adds a coherent place to
investigate fleet changes and review actions. If you prefer a keyboard-led
workflow, it combines those habits with visual relationships, diffs and history.
This is a workflow choice, not a claim that a young project has proven faster or
more reliable than established tools. Kubepit is independent of Freelens and k9s.

## Capabilities and what they need

| Area                  | Included                                                                                       | Dependency or boundary                                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Cluster workbench     | Live resources, CRDs, details, YAML, events, exports, saved views                              | Your kubeconfig and Kubernetes RBAC; cloud exec-auth helpers remain external                                                 |
| Fleet operations      | Search, compare, drift, multi-cluster manifest review, Kustomize sources                       | Connected targets; local Kustomize rendering uses `kubectl`                                                                  |
| Debugging             | Pod/workload logs, structured filtering, exec/attach, node shell, file browser                 | `kubectl` for interactive shells/debugging; node shell creates a privileged helper pod; file operations need container tools |
| Delivery              | Rollouts, revision diffs, rollback, Helm releases, charts and upgrade review                   | Helm release inspection is native; chart and mutation operations need `helm`                                                 |
| GitOps                | Argo CD and Flux overview, details and supported actions                                       | Corresponding CRDs/controllers installed; no Argo/Flux CLI required                                                          |
| Observability         | Up to an hour of in-memory CPU/memory history, PromQL, Loki/LogQL, alerts                      | metrics-server for basic usage; suitable in-cluster Prometheus/Loki sources and permissions for richer data                  |
| Health and security   | Health rules, certificate expiry, Pod Security checks, Trivy report views, RBAC inspection     | Trivy views read installed Trivy Operator reports; they do not scan images themselves                                        |
| Network understanding | Relationship map, NetworkPolicy explanations, reachability matrix                              | Simulation of standard NetworkPolicy, not a live traffic test; CNI-specific policies and incomplete data are flagged         |
| Change history        | In-memory change timeline, local audit, optional persisted events/changes, reviewed revert     | Records observed activity; this is not a complete API-server audit or an external compliance archive                         |
| Cost and capacity     | OpenCost/Kubecost data or labeled estimates, right-sizing evidence, saved recommendation scans | Availability and confidence depend on usage history; estimates are not cloud invoices or guaranteed savings                  |
| Upgrade readiness     | Deprecated API findings across objects, Helm, CRDs and optional request metrics                | Bounded, versioned rules; newer target versions are marked when outside checked coverage                                     |
| Assistant             | Workload diagnosis, YAML, kubectl/PromQL/LogQL suggestions, context preview                    | Disabled by default; your provider or supported installed agent; see data controls below                                     |

Integrations are discovered or configured where appropriate. Kubepit does not
install observability, security or GitOps controllers into your cluster just to
open the workbench. Missing permissions or data are surfaced rather than treated
as proof that a cluster is healthy.

## Local-first, with explicit data boundaries

There is no Kubepit account, product telemetry or hosted workspace synchronization.
The desktop app communicates with the clusters and integrations you use. Helm
catalog access, authentication helpers, configured AI providers and a configured
update feed may also contact their respective services. Local-first does not mean
that connected operations are offline.

| Data                                                                                    | Where it lives                                                                   |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Cluster registry, settings, workspace, saved forwards and custom actions                | JSON files under `~/.kubepit/`; override with `KUBEPIT_HOME`                     |
| Imported kubeconfigs                                                                    | Managed copies in owner-only files, or optional OS credential storage            |
| Audit, opted-in event/change history, recommendation scans and optional AI request logs | Local SQLite database, `~/.kubepit/history.db`, with retention and size controls |
| Table preferences, saved views and bookmarks                                            | The desktop webview's local storage                                              |
| Assistant conversations                                                                 | Memory; optional redacted request logging is separate                            |

Kubepit does not rewrite your original kubeconfig. File imports embed referenced
certificate/token files into a managed snapshot; exec authentication still needs
its external program and credentials. Keychain mode can create temporary
single-context kubeconfig files for `kubectl`, Helm and terminals, removed during
normal disconnect/shutdown cleanup.

The desktop app enables audit recording by default. Persisting cluster events and
changes, scheduled recommendation scans and assistant request logging have
separate controls. Redaction covers known sensitive fields; arbitrary logs,
ConfigMaps, commands and user content can still be sensitive. See
[Security](SECURITY.md) for the trust model.

### An assistant you choose to enable

Use Anthropic, an OpenAI-compatible endpoint, local Ollama, or supported installed
Codex, Claude and OpenCode agents. Installed-agent availability is not proof of
authentication; Cursor can be detected but is not selectable. Remote providers
and installed agents may send data to their own services and incur their own costs.

Enable the assistant and authorize clusters individually. Included context is
redacted and previewed before sending; sensitive values and tokens are masked,
while IP/hostname masking is optional and off by default. Typed follow-ups without
attached context send directly. Read-only assistant tools ask before returning
results by default; session consent can allow later results. Generated commands
are suggestions, and YAML still passes through the existing review flow. Local-only
mode refuses remote providers and installed agents. It is not a whole-app network
firewall. AI answers remain fallible.

## Run the desktop app

Install Node.js 22+, pnpm 9.14.4, Rust stable (at least 1.89) and the
[Tauri prerequisites for your operating system](https://v2.tauri.app/start/prerequisites/).
Install `kubectl` for terminal/debug workflows, `helm` for chart operations, and
any authentication helper your kubeconfig uses.

```bash
pnpm install --frozen-lockfile
pnpm dev
```

For a local release build:

```bash
pnpm tauri:build
```

Tauri targets macOS, Linux and Windows; build prerequisites and runtime behavior
vary by platform. A platform target is not a promise of a verified installer for
every architecture in 0.0.1. The committed macOS configuration uses ad-hoc signing,
and in-app updates stay disabled until a release-signing key is configured.

For production access, use a least-privilege kubeconfig. Kubepit's read-only setting
blocks built-in mutations but cannot sandbox arbitrary commands in a local shell
or enforce the truth of a custom action's `mutating` flag. Kubernetes RBAC is the
enforcement boundary.

## Develop, contribute and publish

The desktop uses **Tauri 2 + Rust** and **React 18 + Tailwind v4 + Zustand**, with
the [RunHQ](https://github.com/erdembas/runhq) design language. The website uses
Next.js static export and ships to GitHub Pages alongside the fixture demo.

```text
apps/desktop/           React workbench and Tauri shell
apps/website/           Next.js product website
crates/kubepit-core/    Kubernetes access, persistence and integrations
scripts/               Validation, Pages build and performance tooling
docs/ARCHITECTURE.md    Implementation contracts and detailed behavior
```

```bash
pnpm dev:site
pnpm build:pages
pnpm typecheck
pnpm i18n:check
pnpm test:ui
pnpm test:site
pnpm check:version
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Tests and performance fixtures must never use real clusters or production
credentials. English and Turkish ship together. Useful contributions include
reproducible bugs, platform validation, accessibility, translations and fixes for
real Kubernetes workflows. Start with [Contributing](CONTRIBUTING.md) and
[Architecture](docs/ARCHITECTURE.md).

See [Changelog](CHANGELOG.md) for the 0.0.1 scope and
[Releasing](docs/RELEASING.md) for GitHub Pages, source tags and the signing boundary.
The website needs no custom domain or hosted application server.

## License

[MIT](LICENSE) © Erdem Baş. Free to use, study, modify and distribute, including
commercial use. Third-party projects and services retain their own licenses,
trademarks and terms.
