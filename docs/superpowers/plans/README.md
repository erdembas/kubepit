# Plan roadmap

> **Superseded — 2026-09-30.** Kubepit is launching v0.0.1 as a free, open-source
> community project under the [MIT license](../../../LICENSE). The commercial,
> subscription, private-edition and license-transition plans below are historical
> records, not the current roadmap or instructions to execute. See the
> [project README](../../../README.md) for the current direction.
>
> **Geçerliliğini yitirdi — 2026-09-30.** Kubepit, v0.0.1 sürümünü
> [MIT lisanslı](../../../LICENSE), ücretsiz ve açık kaynaklı bir topluluk projesi
> olarak yayımlıyor. Aşağıdaki ticari ürün, abonelik, özel sürüm ve lisans geçişi
> planları tarihsel kayıtlardır; güncel yol haritası veya uygulama talimatı değildir.
> Güncel yön için [proje README'sine](../../../README.md) bakın.

## Commercial program — historical proposal (2026-09-29)

The [Open-core commercial program](2026-09-29-commercial-program.md) recorded the
proposed paid cloud-import and team-profile work. It coordinated the
[cloud implementation](2026-09-29-commercial-cloud.md),
[desktop implementation](2026-09-29-commercial-desktop.md),
[product strategy](../specs/2026-09-29-open-core-commercial-strategy.md) and
[licensing/repository decision](../specs/2026-09-29-commercial-licensing-and-repository.md).

The proposed product was an independently buildable open-source Community app plus
private paid desktop features and a small Node/PostgreSQL service for organizations,
teams, Paddle subscriptions and profiles. Pricing is $3/seat/month or $30/seat/year.
The founder says the current MIT-labeled code has not been published; the new
proposal is AGPL core with a controlled commercial alternative, subject to ownership
and legal review. No license or Git history was changed by the planning work.

The older cloud/local and team-sharing documents below are historical technical
references: their all-public placement and file-only sharing design are superseded.
Do not execute those plans unchanged. Other roadmap plans retain their own scope.

## Earlier roadmap

Implementation plans written in the superpowers `writing-plans` format. Each plan
has a design spec next to it in `../specs/` and is meant to be executed with
`superpowers:subagent-driven-development` (recommended) or
`superpowers:executing-plans`, one plan at a time, in the order below.

| #   | Plan                                                                             | Tasks               | Depends on                                                        | Needs from you before starting                                                             |
| --- | -------------------------------------------------------------------------------- | ------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1   | [Hardening of shipped features](2026-09-28-hardening-shipped-features.md)        | 20                  | —                                                                 | Decide on Vitest (the plan adds it; later plans reuse it)                                  |
| 2   | [CI and signed releases](2026-09-28-ci-and-signed-releases.md)                   | 8                   | 1 (tests to run)                                                  | Git remote, repository secrets, Apple Developer ID, a Windows signing choice, the tap repo |
| 3   | [Linux and Windows validation](2026-09-28-cross-platform-validation.md)          | 11                  | 2 (Tasks 1 and 5)                                                 | Access to Linux and Windows machines for the manual QA checklist                           |
| 4   | [Large-cluster performance](2026-09-28-large-cluster-performance.md)             | 23                  | 1 (Vitest, header capture, opt-in metrics sampling), 2 (`ci.yml`) | Budget reference machine, Playwright in the nightly job                                    |
| 5   | [KubeFit-style recommendations](2026-09-28-kubefit-recommendations.md)           | 33                  | — (builds on the merged cost/right-sizing and history code)       | Answers to the spec's open questions; phase 5 is optional                                  |
| 6   | [AI assistant](2026-09-28-ai-assistant.md)                                       | 18                  | 1 (Vitest)                                                        | Default model, consent and logging policy (spec open questions)                            |
| 7   | [Cloud import and local clusters](2026-09-28-cloud-import-and-local-clusters.md) | 15                  | 1 (Vitest)                                                        | A real GKE auth-plugin check before release                                                |
| 8   | [Team sharing](2026-09-28-team-sharing.md)                                       | 15                  | 7 (`ClusterDef.origin`), 5 (Prometheus settings to share)         | Profile hosting convention for your team                                                   |
| 9   | [Falco runtime threats](2026-09-29-falco-runtime-threats.md)                     | 15 (+2 optional)    | — (builds on the merged Trivy install, alerts and history code)   | Answers to the spec's open questions (alert threshold, source cap)                         |
| 10  | [More languages](2026-09-28-more-languages.md)                                   | 9 (+6 locale tasks) | Last, so every new string is translated once                      | Reviewers for the drafted locales                                                          |

## Why this order

- **Hardening first.** It fixes known bugs in shipped features and adds the test
  infrastructure (Vitest, request-header capture in the fake API server, opt-in
  metrics sampling) that the performance, AI, cloud-import and team plans rely on.
  Plans 6–8 contain a skip-if-present task that adds Vitest; after plan 1 it is a no-op.
- **CI before cross-platform and performance.** Both add jobs to `.github/workflows/ci.yml`.
- **Recommendations before team sharing.** Team profiles share per-cluster
  Prometheus/Loki/cost settings, which the recommendations plan extends.
- **Languages last.** Translating after the other features land avoids translating
  strings twice.

## Conventions every plan follows

The project rules in `AGENTS.md` (IPC contract, RunHQ design without chart/UI
libraries, EN+TR i18n, no real clusters in tests, `read_only`, opt-in background
work, container-query layouts) and the checks: `pnpm typecheck`, `pnpm i18n:check`,
`cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings`,
`cargo test --workspace`, `pnpm --filter @kubepit/desktop build` — plus `pnpm test`
once Vitest exists.
