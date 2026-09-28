//! End-to-end test of the upgrade readiness scan against the fake API
//! server in `support/`: live objects (last-applied annotation and
//! managedFields), a Helm release manifest, CRDs, API services, the
//! accessible-namespace fallback and the read-only guarantee. No real
//! cluster is involved.

mod support;

use std::sync::Arc;

use base64::Engine as _;
use kubepit_core::upgrade::{
    UpgradeMetricsState, UpgradeScanOptions, UpgradeSeverity, UpgradeSource,
};
use serde_json::{json, Value};
use support::{setup, start, status, Log, Reply, Request, Router};

fn version() -> Reply {
    Reply::Json(
        200,
        json!({"major": "1", "minor": "24", "gitVersion": "v1.24.17-eks-5e0fdde",
               "gitCommit": "abc", "gitTreeState": "clean", "buildDate": "2024-01-01T00:00:00Z",
               "goVersion": "go1.22", "compiler": "gc", "platform": "linux/amd64"}),
    )
}

fn resource(name: &str, kind: &str, namespaced: bool) -> Value {
    json!({"name": name, "singularName": "", "namespaced": namespaced, "kind": kind,
           "verbs": ["get", "list", "watch"]})
}

fn group(name: &str, version: &str) -> Value {
    let gv = format!("{name}/{version}");
    json!({"name": name, "versions": [{"groupVersion": gv, "version": version}],
           "preferredVersion": {"groupVersion": gv, "version": version}})
}

fn resources(gv: &str, list: Vec<Value>) -> Reply {
    Reply::Json(
        200,
        json!({"kind": "APIResourceList", "groupVersion": gv, "resources": list}),
    )
}

fn meta_list(items: Vec<Value>) -> Reply {
    Reply::Json(
        200,
        json!({"kind": "PartialObjectMetadataList", "apiVersion": "meta.k8s.io/v1",
               "metadata": {"resourceVersion": "1"}, "items": items}),
    )
}

fn list(kind: &str, api_version: &str, items: Vec<Value>) -> Reply {
    Reply::Json(
        200,
        json!({"kind": format!("{kind}List"), "apiVersion": api_version,
               "metadata": {"resourceVersion": "1"}, "items": items}),
    )
}

fn object_meta(name: &str, namespace: &str, annotations: Value, managed: Value) -> Value {
    json!({"kind": "PartialObjectMetadata", "apiVersion": "meta.k8s.io/v1",
           "metadata": {"name": name, "namespace": namespace, "uid": format!("uid-{name}"),
                        "annotations": annotations, "managedFields": managed}})
}

fn managed(manager: &str, api_version: &str) -> Value {
    json!({"manager": manager, "operation": "Update", "apiVersion": api_version,
           "time": "2024-01-01T00:00:00Z", "fieldsType": "FieldsV1", "fieldsV1": {}})
}

fn release_payload() -> String {
    use std::io::Write as _;
    let release = json!({
        "name": "portal", "namespace": "legacy", "version": 3,
        "info": {"status": "deployed"},
        "chart": {"metadata": {"name": "acme-portal", "version": "0.9.1"}},
        "manifest": "---\n# Source: acme-portal/templates/ingress.yaml\napiVersion: extensions/v1beta1\nkind: Ingress\nmetadata:\n  name: portal\n---\n# Source: acme-portal/templates/pdb.yaml\napiVersion: policy/v1beta1\nkind: PodDisruptionBudget\nmetadata:\n  name: portal\n---\n# Source: acme-portal/templates/svc.yaml\napiVersion: v1\nkind: Service\nmetadata:\n  name: portal\n"
    });
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gz.write_all(release.to_string().as_bytes()).unwrap();
    let engine = base64::engine::general_purpose::STANDARD;
    engine.encode(engine.encode(gz.finish().unwrap()))
}

fn router() -> Router {
    Arc::new(|req: &Request, _log: &Log| {
        let (path, query) = req.path.split_once('?').unwrap_or((req.path.as_str(), ""));
        if req.method != "GET" {
            panic!("the scan sent a write: {} {}", req.method, req.path);
        }
        match path {
            "/version" => version(),
            "/api/v1" => resources(
                "v1",
                vec![
                    resource("secrets", "Secret", true),
                    resource("events", "Event", true),
                    resource("endpoints", "Endpoints", true),
                    resource("pods", "Pod", true),
                ],
            ),
            "/apis" => Reply::Json(
                200,
                json!({"kind": "APIGroupList", "apiVersion": "v1", "groups": [
                    group("networking.k8s.io", "v1"),
                    group("batch", "v1"),
                    group("autoscaling", "v2"),
                    group("policy", "v1"),
                    group("apiextensions.k8s.io", "v1"),
                    group("apiregistration.k8s.io", "v1"),
                ]}),
            ),
            "/apis/networking.k8s.io/v1" => resources(
                "networking.k8s.io/v1",
                vec![resource("ingresses", "Ingress", true)],
            ),
            "/apis/batch/v1" => resources("batch/v1", vec![resource("cronjobs", "CronJob", true)]),
            "/apis/autoscaling/v2" => resources(
                "autoscaling/v2",
                vec![resource(
                    "horizontalpodautoscalers",
                    "HorizontalPodAutoscaler",
                    true,
                )],
            ),
            "/apis/policy/v1" => resources(
                "policy/v1",
                vec![resource(
                    "poddisruptionbudgets",
                    "PodDisruptionBudget",
                    true,
                )],
            ),
            "/apis/apiextensions.k8s.io/v1" => resources(
                "apiextensions.k8s.io/v1",
                vec![resource(
                    "customresourcedefinitions",
                    "CustomResourceDefinition",
                    false,
                )],
            ),
            "/apis/apiregistration.k8s.io/v1" => resources(
                "apiregistration.k8s.io/v1",
                vec![resource("apiservices", "APIService", false)],
            ),
            "/apis/networking.k8s.io/v1/ingresses" => meta_list(vec![
                object_meta(
                    "shop",
                    "web",
                    json!({"kubectl.kubernetes.io/last-applied-configuration":
                           "{\"apiVersion\":\"networking.k8s.io/v1beta1\",\"kind\":\"Ingress\"}"}),
                    json!([
                        managed("kubectl-client-side-apply", "networking.k8s.io/v1beta1"),
                        managed("nginx-ingress-controller", "networking.k8s.io/v1")
                    ]),
                ),
                object_meta(
                    "clean",
                    "web",
                    json!({}),
                    json!([managed("helm", "networking.k8s.io/v1")]),
                ),
            ]),
            "/apis/batch/v1/cronjobs" => meta_list(vec![object_meta(
                "nightly",
                "jobs",
                json!({}),
                json!([managed("ci-deployer", "batch/v1beta1")]),
            )]),
            // Forbidden cluster-wide: the scan falls back to accessible namespaces.
            "/apis/autoscaling/v2/horizontalpodautoscalers" => {
                Reply::Json(403, status(403, "Forbidden", "hpa is forbidden"))
            }
            "/apis/autoscaling/v2/namespaces/team-a/horizontalpodautoscalers" => {
                meta_list(vec![object_meta(
                    "api",
                    "team-a",
                    json!({}),
                    json!([managed(
                        "argocd-application-controller",
                        "autoscaling/v2beta2"
                    )]),
                )])
            }
            "/apis/autoscaling/v2/namespaces/team-b/horizontalpodautoscalers" => {
                Reply::Json(403, status(403, "Forbidden", "hpa is forbidden"))
            }
            // Denied everywhere: reported as skipped.
            "/apis/policy/v1/poddisruptionbudgets"
            | "/apis/policy/v1/namespaces/team-a/poddisruptionbudgets"
            | "/apis/policy/v1/namespaces/team-b/poddisruptionbudgets" => {
                Reply::Json(403, status(403, "Forbidden", "pdb is forbidden"))
            }
            "/api/v1/secrets" => {
                assert!(query.contains("owner%3Dhelm"), "{query}");
                meta_list(vec![
                    json!({"metadata": {"name": "sh.helm.release.v1.portal.v2", "namespace": "legacy",
                                        "labels": {"owner": "helm", "name": "portal", "version": "2"}}}),
                    json!({"metadata": {"name": "sh.helm.release.v1.portal.v3", "namespace": "legacy",
                                        "labels": {"owner": "helm", "name": "portal", "version": "3"}}}),
                ])
            }
            "/api/v1/namespaces/legacy/secrets/sh.helm.release.v1.portal.v3" => Reply::Json(
                200,
                json!({"apiVersion": "v1", "kind": "Secret", "type": "helm.sh/release.v1",
                       "metadata": {"name": "sh.helm.release.v1.portal.v3", "namespace": "legacy"},
                       "data": {"release": release_payload()}}),
            ),
            "/apis/apiextensions.k8s.io/v1/customresourcedefinitions" => list(
                "CustomResourceDefinition",
                "apiextensions.k8s.io/v1",
                vec![
                    json!({"apiVersion": "apiextensions.k8s.io/v1", "kind": "CustomResourceDefinition",
                    "metadata": {"name": "widgets.acme.io"},
                    "spec": {"group": "acme.io", "scope": "Namespaced",
                             "names": {"kind": "Widget", "plural": "widgets"},
                             "versions": [
                                 {"name": "v1alpha1", "served": true, "storage": false, "deprecated": true},
                                 {"name": "v1", "served": true, "storage": true}]}}),
                ],
            ),
            "/apis/apiregistration.k8s.io/v1/apiservices" => list(
                "APIService",
                "apiregistration.k8s.io/v1",
                vec![
                    json!({"apiVersion": "apiregistration.k8s.io/v1", "kind": "APIService",
                    "metadata": {"name": "v1.batch"},
                    "spec": {"group": "batch", "version": "v1", "service": null}}),
                ],
            ),
            _ => Reply::Json(404, status(404, "NotFound", "not found")),
        }
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn scan_reports_blockers_and_warnings_without_writing() {
    let server = start(router()).await;
    // Read-only on purpose: scanning only reads.
    let (_dir, app, _recorder, id) = setup(&server.url, true);

    let report = app
        .upgrade_readiness_scan(&id, &UpgradeScanOptions::default())
        .await
        .unwrap();
    assert_eq!(report.server_version, "1.24");
    assert_eq!(report.target_version, "1.25", "defaults to the next minor");
    assert_eq!(report.next_version, "1.25");
    assert_eq!(report.metrics, UpgradeMetricsState::Skipped);
    assert_eq!(report.helm_releases_scanned, 1, "only the newest revision");
    assert_eq!(report.crds_scanned, 1);
    assert_eq!(
        report.objects_scanned, 6,
        "ingresses, cronjob, team-a HPA, CRD, API service"
    );
    assert!(!report.truncated);

    let summary: Vec<(UpgradeSeverity, UpgradeSource, &str, &str, String)> = report
        .findings
        .iter()
        .map(|f| {
            (
                f.severity,
                f.source,
                f.api_version.as_str(),
                f.kind.as_str(),
                f.object
                    .as_ref()
                    .map(|o| o.name.clone())
                    .unwrap_or_default(),
            )
        })
        .collect();
    use UpgradeSeverity::*;
    use UpgradeSource::*;
    assert_eq!(
        summary,
        vec![
            (
                Blocker,
                HelmRelease,
                "extensions/v1beta1",
                "Ingress",
                "portal".into()
            ),
            (
                Blocker,
                HelmRelease,
                "policy/v1beta1",
                "PodDisruptionBudget",
                "portal".into()
            ),
            (
                Blocker,
                LastApplied,
                "networking.k8s.io/v1beta1",
                "Ingress",
                "shop".into()
            ),
            (
                Blocker,
                ManagedFields,
                "batch/v1beta1",
                "CronJob",
                "nightly".into()
            ),
            (
                Warning,
                ManagedFields,
                "autoscaling/v2beta2",
                "HorizontalPodAutoscaler",
                "api".into()
            ),
            (
                Warning,
                Crd,
                "acme.io/v1alpha1",
                "Widget",
                "widgets.acme.io".into()
            ),
        ]
    );
    let ingress = &report.findings[2];
    assert!(ingress.already_removed, "removed in 1.22, before 1.24");
    assert_eq!(ingress.managers, vec!["kubectl-client-side-apply"]);
    assert_eq!(
        ingress.object.as_ref().unwrap().api_version,
        "networking.k8s.io/v1"
    );
    let helm = report.findings[0].helm.as_ref().unwrap();
    assert_eq!((helm.name.as_str(), helm.revision), ("portal", 3));
    let cronjob = &report.findings[3];
    assert!(!cronjob.already_removed, "removed in exactly 1.25");
    assert_eq!(
        report
            .skipped
            .iter()
            .map(|s| s.what.as_str())
            .collect::<Vec<_>>(),
        vec!["PodDisruptionBudget"]
    );

    // A later target turns the HPA warning into a blocker; an older one is refused.
    let later = app
        .upgrade_readiness_scan(
            &id,
            &UpgradeScanOptions {
                target_version: Some("v1.26".into()),
                metrics: false,
            },
        )
        .await
        .unwrap();
    assert_eq!(later.target_version, "1.26");
    let hpa = later
        .findings
        .iter()
        .find(|f| f.kind == "HorizontalPodAutoscaler")
        .unwrap();
    assert_eq!(hpa.severity, Blocker);
    for bad in ["1.20", "two"] {
        assert!(app
            .upgrade_readiness_scan(
                &id,
                &UpgradeScanOptions {
                    target_version: Some(bad.into()),
                    metrics: false,
                },
            )
            .await
            .is_err());
    }

    // Events and endpoints are never listed object by object.
    let paths: Vec<String> = server.log.lock().iter().map(|r| r.path.clone()).collect();
    assert!(
        !paths
            .iter()
            .any(|p| p.contains("/events") || p.contains("/endpoints")),
        "{paths:?}"
    );
    // Metadata-only lists for the object scan.
    assert!(paths
        .iter()
        .any(|p| p.starts_with("/apis/batch/v1/cronjobs")));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn metrics_are_optional() {
    let server = start(router()).await;
    let (_dir, app, _recorder, id) = setup(&server.url, false);
    // No Prometheus on the fake server: asked for, but unavailable — the
    // rest of the scan still completes.
    let report = app
        .upgrade_readiness_scan(
            &id,
            &UpgradeScanOptions {
                target_version: None,
                metrics: true,
            },
        )
        .await
        .unwrap();
    assert_eq!(report.metrics, UpgradeMetricsState::Unavailable);
    assert!(report.metrics_error.is_some());
    assert!(!report.findings.is_empty());
}
