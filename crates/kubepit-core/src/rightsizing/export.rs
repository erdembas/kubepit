//! JSON and YAML exports of recommendations (spec §10.5), built in Rust so
//! they are locale-invariant (JSON numbers, Kubernetes quantities).
//!
//! - **JSON** ([`export_json`]): the report data only — format, cluster
//!   display name, scan time (RFC 3339), source, window, strategy, settings,
//!   currency and the selected `WorkloadRecommendation`s. Never connection
//!   metadata: no kubeconfig, server URL, Prometheus service or access
//!   settings (tenant, Secret reference, label selector), no stored
//!   `source_config`, and no notes (their details may quote a service or an
//!   error message).
//! - **YAML** ([`export_yaml`]): one fragment per changed container with the
//!   complete resulting `resources` block (recommended values where they
//!   change, current values where they stay, unset fields omitted), in
//!   `patch::format_cpu` / `patch::format_memory` quantities. The comments
//!   are fixed English, never translated.

use anyhow::{anyhow, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;

use super::patch::{format_cpu, format_memory};
use super::strategy::limit_ratio;
use super::types::{
    ContainerRecommendation, RightsizingReport, RightsizingSettings, RightsizingSource,
    WorkloadRecommendation, WorkloadRef,
};

/// `format` of JSON exports.
pub const EXPORT_FORMAT: &str = "kubepit.recommendations/v1";
/// The YAML export when no selected container changes.
const NO_CHANGES: &str = "# No changes to export.\n";

/// The workloads of `report` that `selection` names (every one when empty).
fn selected<'a>(
    report: &'a RightsizingReport,
    selection: &'a [WorkloadRef],
) -> impl Iterator<Item = &'a WorkloadRecommendation> {
    report.workloads.iter().filter(move |w| {
        selection.is_empty()
            || selection
                .iter()
                .any(|r| r.kind == w.kind && r.namespace == w.namespace && r.name == w.name)
    })
}

/// The JSON export (spec §10.5): field order is the document's.
#[derive(Serialize)]
struct JsonExport<'a> {
    format: &'static str,
    cluster: &'a str,
    scanned_at: String,
    source: RightsizingSource,
    window_secs: u64,
    strategy: &'a str,
    settings: &'a RightsizingSettings,
    currency: &'a str,
    workloads: Vec<&'a WorkloadRecommendation>,
}

/// Pretty JSON of the selected workloads (`selection` empty = every
/// workload) of a scan of `cluster_name` taken at `scanned_at` (epoch ms).
pub fn export_json(
    report: &RightsizingReport,
    cluster_name: &str,
    scanned_at: i64,
    selection: &[WorkloadRef],
) -> Result<String> {
    let scanned_at = DateTime::<Utc>::from_timestamp_millis(scanned_at)
        .ok_or_else(|| anyhow!("invalid scan time {scanned_at}"))?
        .to_rfc3339_opts(SecondsFormat::Secs, true);
    let export = JsonExport {
        format: EXPORT_FORMAT,
        cluster: cluster_name,
        scanned_at,
        source: report.source,
        window_secs: report.window_secs,
        strategy: &report.strategy,
        settings: &report.settings,
        currency: &report.currency,
        workloads: selected(report, selection).collect(),
    };
    Ok(serde_json::to_string_pretty(&export)?)
}

/// `2`, `1.5`, `1.33`: at most two decimals, no trailing zeros.
fn ratio_text(ratio: f64) -> String {
    let text = format!("{ratio:.2}");
    text.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// `    cpu: "250m"` with an optional trailing comment.
fn quantity_line(out: &mut String, key: &str, value: String, comment: Option<String>) {
    out.push_str(&format!("    {key}: \"{value}\""));
    if let Some(comment) = comment {
        out.push_str(&format!("  # {comment}"));
    }
    out.push('\n');
}

fn raised_comment(raised: bool, request: Option<f64>, limit: Option<f64>) -> Option<String> {
    raised.then(|| {
        format!(
            "raised with the request (limit ÷ request ×{})",
            ratio_text(limit_ratio(request, limit))
        )
    })
}

/// The fragment of one changed container.
fn fragment(w: &WorkloadRecommendation, c: &ContainerRecommendation) -> String {
    let mut out = format!(
        "# {} {}/{} · container {}\n\
         # Resource fragment, not a complete manifest. Values are rounded up.\n\
         resources:\n",
        w.kind, w.namespace, w.name, c.name
    );
    let (current, next) = (&c.current, &c.recommended);
    if next.cpu_request.is_some() || next.memory_request.is_some() {
        out.push_str("  requests:\n");
        if let Some(v) = next.cpu_request {
            quantity_line(&mut out, "cpu", format_cpu(v), None);
        }
        if let Some(v) = next.memory_request {
            quantity_line(&mut out, "memory", format_memory(v), None);
        }
    }
    if next.cpu_limit.is_some() || next.memory_limit.is_some() {
        out.push_str("  limits:\n");
        if let Some(v) = next.cpu_limit {
            let comment =
                raised_comment(c.cpu_limit_raised, current.cpu_request, current.cpu_limit);
            quantity_line(&mut out, "cpu", format_cpu(v), comment);
        }
        if let Some(v) = next.memory_limit {
            let comment = raised_comment(
                c.memory_limit_raised,
                current.memory_request,
                current.memory_limit,
            );
            quantity_line(&mut out, "memory", format_memory(v), comment);
        }
    }
    out
}

/// Container `resources` fragments of the selected workloads (`selection`
/// empty = every workload), one per changed container, separated by a
/// blank line; `# No changes to export.` when nothing changes.
pub fn export_yaml(report: &RightsizingReport, selection: &[WorkloadRef]) -> String {
    let fragments: Vec<String> = selected(report, selection)
        .flat_map(|w| {
            w.containers
                .iter()
                .filter(|c| c.changed())
                .map(move |c| fragment(w, c))
        })
        .collect();
    if fragments.is_empty() {
        return NO_CHANGES.to_string();
    }
    fragments.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cost::CostPricing;
    use crate::rightsizing::math::{change_of, GIB, MIB};
    use crate::rightsizing::strategy;
    use crate::rightsizing::types::{
        Confidence, ContainerRecommendation, RecommendationWarning, ResourceValues,
        RightsizingNote, RightsizingNoteKind, RightsizingSource, UsageStats, Verdict,
    };
    use crate::rightsizing::workload_history::WorkloadHistory;
    use crate::types::{PromScheme, PrometheusConfig};
    use serde_json::{json, Value};

    fn container(
        name: &str,
        current: ResourceValues,
        recommended: ResourceValues,
    ) -> ContainerRecommendation {
        ContainerRecommendation {
            name: name.into(),
            current,
            recommended,
            usage: Some(UsageStats {
                cpu_p95: 100.0,
                cpu_max: 200.0,
                memory_max: 100.0 * MIB,
                hours: 168.0,
                ..Default::default()
            }),
            cpu: change_of(current.cpu_request, recommended.cpu_request),
            memory: change_of(current.memory_request, recommended.memory_request),
            memory_limit: change_of(current.memory_limit, recommended.memory_limit),
            cpu_limit: change_of(current.cpu_limit, recommended.cpu_limit),
            confidence: Confidence::High,
            warnings: Vec::new(),
            cpu_limit_raised: false,
            memory_limit_raised: false,
            evidence: None,
        }
    }

    fn workload(name: &str, containers: Vec<ContainerRecommendation>) -> WorkloadRecommendation {
        WorkloadRecommendation {
            kind: "Deployment".into(),
            namespace: "shop".into(),
            name: name.into(),
            uid: format!("uid-{name}"),
            replicas: 2,
            confidence: Confidence::High,
            verdict: Verdict::Over,
            coverage_hours: 168.0,
            changed: containers.iter().any(ContainerRecommendation::changed),
            monthly_delta: -10.0,
            monthly_current: 40.0,
            containers,
            pods: vec![format!("{name}-a")],
            pods_truncated: false,
            hpa: None,
            lenses: Vec::new(),
            cost_replicas: 2.0,
        }
    }

    fn report(workloads: Vec<WorkloadRecommendation>) -> RightsizingReport {
        RightsizingReport {
            source: RightsizingSource::Prometheus,
            window_secs: 604_800,
            settings: WorkloadHistory::defaults(),
            currency: "USD".into(),
            pricing: CostPricing {
                currency: "USD".into(),
                cpu_hour: 0.04,
                memory_gib_hour: 0.005,
                gpu_hour: None,
                storage_gib_month: None,
                discount_percent: 0.0,
            },
            workloads,
            notes: Vec::new(),
            strategy: "workload-history".into(),
            strategies: strategy::strategies(),
            computed_at: 1,
            strategy_auto: true,
            window_end: 2,
        }
    }

    /// `web`'s `app` container going from 1 core / 2 GiB (no memory limit)
    /// to `cpu` / `memory` / `memory_limit`.
    fn report_with(cpu: f64, memory: f64, memory_limit: Option<f64>) -> RightsizingReport {
        let current = ResourceValues {
            cpu_request: Some(1000.0),
            cpu_limit: None,
            memory_request: Some(2.0 * GIB),
            memory_limit: None,
        };
        let recommended = ResourceValues {
            cpu_request: Some(cpu),
            cpu_limit: None,
            memory_request: Some(memory),
            memory_limit,
        };
        report(vec![workload(
            "web",
            vec![container("app", current, recommended)],
        )])
    }

    /// CPU request 1000 m / limit 2000 m raised to 2400 m / 4800 m, plus an
    /// unchanged sidecar.
    fn raised_report() -> RightsizingReport {
        let current = ResourceValues {
            cpu_request: Some(1000.0),
            cpu_limit: Some(2000.0),
            memory_request: Some(128.0 * MIB),
            memory_limit: Some(256.0 * MIB),
        };
        let mut app = container(
            "app",
            current,
            ResourceValues {
                cpu_request: Some(2400.0),
                cpu_limit: Some(4800.0),
                ..current
            },
        );
        app.cpu_limit_raised = true;
        let sidecar = container("sidecar", current, current);
        report(vec![workload("web", vec![app, sidecar])])
    }

    fn unchanged_report() -> RightsizingReport {
        let current = ResourceValues {
            cpu_request: Some(100.0),
            ..Default::default()
        };
        report(vec![workload(
            "web",
            vec![container("app", current, current)],
        )])
    }

    #[test]
    fn yaml_fragments_use_kubernetes_quantities() {
        let y = export_yaml(
            &report_with(350.0, 402_653_184.0, Some(1_073_741_824.0)),
            &[],
        );
        assert!(
            y.contains(r#"cpu: "350m""#)
                && y.contains(r#"memory: "384Mi""#)
                && y.contains(r#"memory: "1Gi""#)
        );
        assert!(!y.contains("402653184") && !y.contains("1073741824"));
        assert!(
            export_yaml(&report_with(350.0, 384.0 * MIB + 1.0, None), &[])
                .contains(r#"memory: "385Mi""#)
        );
        assert!(
            export_yaml(&report_with(2000.0, 2.0 * GIB, None), &[]).contains(r#"memory: "2Gi""#)
        );
        assert!(
            export_yaml(&report_with(349.2, 64.0 * MIB, None), &[]).contains(r#"cpu: "350m""#),
            "never a fractional millicore"
        );
        assert_eq!(
            y,
            "# Deployment shop/web · container app\n\
             # Resource fragment, not a complete manifest. Values are rounded up.\n\
             resources:\n\
            \x20 requests:\n\
            \x20   cpu: \"350m\"\n\
            \x20   memory: \"384Mi\"\n\
            \x20 limits:\n\
            \x20   memory: \"1Gi\"\n"
        );
        let parsed: Value = serde_yaml::from_str(&y).unwrap();
        assert_eq!(parsed["resources"]["requests"]["cpu"], json!("350m"));
    }

    #[test]
    fn yaml_calls_out_raised_limits_and_skips_unchanged() {
        let y = export_yaml(&raised_report(), &[]);
        assert!(
            y.contains(r#"cpu: "4800m""#)
                && y.contains("# raised with the request (limit ÷ request ×2)")
        );
        assert!(
            !y.contains("container sidecar"),
            "unchanged containers are skipped"
        );
        assert!(
            y.contains(r#"memory: "128Mi""#) && y.contains(r#"memory: "256Mi""#),
            "current values where they stay"
        );
        assert_eq!(
            export_yaml(&unchanged_report(), &[]),
            "# No changes to export.\n"
        );
        let parsed: Value = serde_yaml::from_str(&y).unwrap();
        assert_eq!(parsed["resources"]["limits"]["cpu"], json!("4800m"));

        // Ratios keep at most two decimals, without trailing zeros.
        let mut odd = raised_report();
        let app = &mut odd.workloads[0].containers[0];
        app.current.cpu_limit = Some(1500.0);
        app.recommended.cpu_limit = Some(3600.0);
        assert!(export_yaml(&odd, &[]).contains("(limit ÷ request ×1.5)"));
        let app = &mut odd.workloads[0].containers[0];
        app.current.cpu_request = Some(300.0);
        app.current.cpu_limit = Some(400.0);
        app.memory_limit_raised = true;
        let y = export_yaml(&odd, &[]);
        assert!(y.contains("(limit ÷ request ×1.33)"), "{y}");
        assert!(
            y.contains("memory: \"256Mi\"  # raised with the request (limit ÷ request ×2)"),
            "{y}"
        );
    }

    #[test]
    fn exports_follow_the_selection() {
        let mut both = raised_report();
        let mut api = both.workloads[0].clone();
        api.name = "api".into();
        both.workloads.push(api);
        let api_ref = WorkloadRef {
            kind: "Deployment".into(),
            namespace: "shop".into(),
            name: "api".into(),
        };
        let all = export_yaml(&both, &[]);
        assert!(all.contains("shop/web ·") && all.contains("shop/api ·"));
        assert!(
            all.contains("\n\n# Deployment shop/api"),
            "fragments are separated by a blank line"
        );
        let one = export_yaml(&both, std::slice::from_ref(&api_ref));
        assert!(one.contains("shop/api ·") && !one.contains("shop/web ·"));
        let json: Value =
            serde_json::from_str(&export_json(&both, "prod", 0, &[api_ref]).unwrap()).unwrap();
        assert_eq!(json["workloads"].as_array().unwrap().len(), 1);
        assert_eq!(json["workloads"][0]["name"], "api");
        let other = WorkloadRef {
            kind: "StatefulSet".into(),
            namespace: "shop".into(),
            name: "web".into(),
        };
        assert_eq!(export_yaml(&both, &[other]), "# No changes to export.\n");
    }

    /// The report of a cluster whose Prometheus is a configured service
    /// behind a tenant and a Secret: notes and warnings quote them, the
    /// pricing is the cluster's.
    fn report_from_service_cluster() -> RightsizingReport {
        let mut app = container(
            "app",
            ResourceValues {
                cpu_request: Some(1000.0),
                ..Default::default()
            },
            ResourceValues {
                cpu_request: Some(120.0),
                ..Default::default()
            },
        );
        app.warnings
            .push(RecommendationWarning::new("partial-data"));
        let mut r = report(vec![workload("web", vec![app])]);
        r.notes = vec![
            RightsizingNote {
                kind: RightsizingNoteKind::PrometheusFailed,
                detail: Some(
                    "GET /api/v1/namespaces/monitoring/services/http:prometheus-operated:9090/proxy \
                     (X-Scope-OrgID: team-a, bearer token from Secret monitoring/prom-auth, \
                     kubeconfig ~/.kube/config)"
                        .into(),
                ),
            },
            RightsizingNote {
                kind: RightsizingNoteKind::PartialData,
                detail: Some("Q15".into()),
            },
        ];
        r
    }

    /// What the store keeps as the run's `source_config` once access
    /// settings exist (phase 7): the service, the tenant and the Secret.
    fn source_config() -> String {
        let prometheus = PrometheusConfig::Service {
            namespace: "monitoring".into(),
            service: "prometheus-operated".into(),
            port: 9090,
            scheme: PromScheme::Https,
            path_prefix: "/select/0/prometheus".into(),
        };
        json!({
            "prometheus": prometheus,
            "prometheus_access": {
                "tenant": "team-a",
                "secret": {"namespace": "monitoring", "name": "prom-auth", "key": "token"},
                "selector": {"cluster": "prod-eu"}
            }
        })
        .to_string()
    }

    #[test]
    fn json_is_locale_invariant_and_has_no_connection_metadata() {
        let r = report_from_service_cluster();
        let j = export_json(&r, "prod", 1_790_000_000_000, &[]).unwrap();
        let v: Value = serde_json::from_str(&j).unwrap();
        assert_eq!(v["format"], EXPORT_FORMAT);
        assert_eq!(v["cluster"], "prod");
        assert_eq!(v["scanned_at"], "2026-09-21T14:13:20Z");
        assert_eq!(v["source"], "prometheus");
        assert_eq!(v["window_secs"], 604_800);
        assert_eq!(v["strategy"], "workload-history");
        assert_eq!(v["currency"], "USD");
        assert_eq!(v["settings"]["cpu_headroom_percent"], json!(20.0));
        assert_eq!(
            v["workloads"][0]["containers"][0]["recommended"]["cpu_request"],
            json!(120.0)
        );
        assert!(
            j.contains(r#""cpu_request": 120.0"#),
            "a JSON number, never a localized one"
        );
        let keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        let mut expected = vec![
            "cluster",
            "currency",
            "format",
            "scanned_at",
            "settings",
            "source",
            "strategy",
            "window_secs",
            "workloads",
        ];
        expected.sort_unstable();
        let mut keys = keys;
        keys.sort_unstable();
        assert_eq!(keys, expected, "only the report data");
        for secret in [
            "prometheus-operated",
            "monitoring",
            "kubeconfig",
            "token",
            "X-Scope-OrgID",
        ] {
            assert!(!j.contains(secret), "{secret}");
        }
    }

    #[test]
    fn exports_never_carry_prometheus_access_configuration() {
        let r = report_from_service_cluster();
        let config = source_config();
        let json = export_json(&r, "prod", 1_790_000_000_000, &[]).unwrap();
        let yaml = export_yaml(&r, &[]);
        assert!(yaml.contains("resources:"));
        for export in [&json, &yaml] {
            assert!(!export.contains(&config), "the source_config string");
            for field in [
                "prometheus_access",
                "source_config",
                "tenant",
                "team-a",
                "secret",
                "Secret",
                "prom-auth",
                "selector",
                "prod-eu",
                "credential",
                "bearer",
                "path_prefix",
                "/select/0/prometheus",
                "9090",
                "pricing",
                "notes",
            ] {
                assert!(!export.contains(field), "{field} leaked into\n{export}");
            }
        }
    }
}
