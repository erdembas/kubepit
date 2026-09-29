# Plan roadmap

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
