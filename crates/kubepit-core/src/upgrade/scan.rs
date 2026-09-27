//! Pure matching: object metadata, Helm release manifests, CRDs, API
//! services and the `apiserver_requested_deprecated_apis` metric →
//! [`UpgradeFinding`]s. No I/O here; `upgrade.rs` feeds it.

use std::collections::{BTreeMap, BTreeSet};

use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
use serde_json::Value;

use super::deprecations::{self, impact, DeprecatedApi, Impact, Minor};
use super::{UpgradeFinding, UpgradeHelmRef, UpgradeObjectRef, UpgradeSeverity, UpgradeSource};
use crate::helm_preview::{split_manifest, ObjectIdentity};
use crate::types::{ApiResourceInfo, PromQuerySeries};

pub const LAST_APPLIED: &str = "kubectl.kubernetes.io/last-applied-configuration";

/// Kinds never listed object by object: requests that are not persisted,
/// and high-volume kinds whose every object a controller writes with a
/// current version anyway (events, endpoints).
const NOT_SCANNED: &[&str] = &[
    "Endpoints",
    "Event",
    "LocalSubjectAccessReview",
    "SelfSubjectAccessReview",
    "SelfSubjectRulesReview",
    "SubjectAccessReview",
    "TokenReview",
];

/// The cluster's current version and the upgrade target.
#[derive(Debug, Clone, Copy)]
pub struct Versions {
    pub current: Minor,
    pub target: Minor,
}

fn group_of(api_version: &str) -> &str {
    api_version.split_once('/').map(|(g, _)| g).unwrap_or("")
}

/// What to list for the object scan: per kind of the table, the served
/// resource of a group that kind lives (or lived) in — the replacement
/// group first, so an old cluster serving the kind twice lists it once.
pub fn scan_targets(resources: &[ApiResourceInfo]) -> Vec<ApiResourceInfo> {
    let mut groups: BTreeMap<&str, (BTreeSet<&str>, BTreeSet<&str>)> = BTreeMap::new();
    for e in deprecations::table() {
        if NOT_SCANNED.contains(&e.kind.as_str()) {
            continue;
        }
        let (replacements, old) = groups.entry(e.kind.as_str()).or_default();
        if let Some(r) = &e.replacement {
            if e.replacement_kind.is_none() {
                replacements.insert(group_of(r));
            }
        }
        old.insert(group_of(&e.api_version));
    }
    let listable = |r: &&ApiResourceInfo| r.verbs.iter().any(|v| v == "list");
    let mut out = Vec::new();
    for (kind, (replacements, old)) in groups {
        let candidates: Vec<&ApiResourceInfo> = resources
            .iter()
            .filter(|r| r.kind == kind)
            .filter(listable)
            .collect();
        let pick = candidates
            .iter()
            .find(|r| replacements.contains(r.group.as_str()))
            .or_else(|| candidates.iter().find(|r| old.contains(r.group.as_str())));
        if let Some(r) = pick {
            out.push((*r).clone());
        }
    }
    out
}

fn finding(
    entry: &DeprecatedApi,
    how: Impact,
    source: UpgradeSource,
    id: String,
) -> UpgradeFinding {
    let (severity, already_removed) = match how {
        Impact::Removed { already } => (UpgradeSeverity::Blocker, already),
        Impact::Deprecated => (UpgradeSeverity::Warning, false),
    };
    UpgradeFinding {
        id,
        severity,
        source,
        api_version: entry.api_version.clone(),
        kind: entry.kind.clone(),
        deprecated_in: Some(entry.deprecated_in.clone()),
        removed_in: entry.removed_in.clone(),
        replacement: entry.replacement.clone(),
        replacement_kind: entry.replacement_kind.clone(),
        notes: entry.notes.clone(),
        already_removed,
        object: None,
        helm: None,
        managers: Vec::new(),
        detail: None,
    }
}

fn last_applied_api_version(meta: &ObjectMeta) -> Option<String> {
    let raw = meta.annotations.as_ref()?.get(LAST_APPLIED)?;
    let value: Value = serde_json::from_str(raw).ok()?;
    value
        .get("apiVersion")
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Findings for one live object: its last-applied configuration and every
/// `managedFields` entry written through a deprecated `apiVersion`. One
/// finding per deprecated version, naming the managers that used it.
pub fn object_findings(
    resource: &ApiResourceInfo,
    meta: &ObjectMeta,
    versions: Versions,
) -> Vec<UpgradeFinding> {
    let mut by_version: BTreeMap<String, (bool, BTreeSet<String>)> = BTreeMap::new();
    if let Some(api_version) = last_applied_api_version(meta) {
        if deprecations::lookup(&api_version, &resource.kind).is_some() {
            by_version.entry(api_version).or_default().0 = true;
        }
    }
    for entry in meta.managed_fields.iter().flatten() {
        let Some(api_version) = entry.api_version.as_deref() else {
            continue;
        };
        if deprecations::lookup(api_version, &resource.kind).is_none() {
            continue;
        }
        let manager = entry.manager.clone().unwrap_or_default();
        let slot = by_version.entry(api_version.to_string()).or_default();
        if !manager.is_empty() {
            slot.1.insert(manager);
        }
    }
    let name = meta.name.clone().unwrap_or_default();
    let namespace = meta.namespace.clone().filter(|ns| !ns.is_empty());
    by_version
        .into_iter()
        .filter_map(|(api_version, (last_applied, managers))| {
            let entry = deprecations::lookup(&api_version, &resource.kind)?;
            let how = impact(entry, versions.current, versions.target)?;
            let source = if last_applied {
                UpgradeSource::LastApplied
            } else {
                UpgradeSource::ManagedFields
            };
            let id = format!(
                "object|{api_version}|{}|{}|{name}",
                resource.kind,
                namespace.as_deref().unwrap_or("")
            );
            let mut f = finding(entry, how, source, id);
            f.object = Some(UpgradeObjectRef {
                api_version: resource.api_version.clone(),
                kind: resource.kind.clone(),
                namespace: namespace.clone(),
                name: name.clone(),
            });
            f.managers = managers.into_iter().collect();
            Some(f)
        })
        .collect()
}

fn str_at<'a>(value: &'a Value, pointer: &str) -> &'a str {
    value.pointer(pointer).and_then(Value::as_str).unwrap_or("")
}

/// Findings for the stored manifest of a release's newest revision. Helm
/// rebuilds the objects of that manifest on every upgrade and rollback, so
/// an apiVersion the cluster no longer serves makes the release
/// un-upgradable even when the new chart version is fixed.
pub fn helm_findings(
    release: &Value,
    fallback_namespace: &str,
    versions: Versions,
) -> Vec<UpgradeFinding> {
    let namespace = match str_at(release, "/namespace") {
        "" => fallback_namespace,
        ns => ns,
    };
    let helm = UpgradeHelmRef {
        namespace: namespace.to_string(),
        name: str_at(release, "/name").to_string(),
        revision: release.get("version").and_then(Value::as_i64).unwrap_or(0),
        chart: str_at(release, "/chart/metadata/name").to_string(),
        chart_version: str_at(release, "/chart/metadata/version").to_string(),
    };
    let mut out = Vec::new();
    for object in split_manifest(str_at(release, "/manifest")) {
        let api_version = str_at(&object.value, "/apiVersion");
        let kind = str_at(&object.value, "/kind");
        let Some(entry) = deprecations::lookup(api_version, kind) else {
            continue;
        };
        let Some(how) = impact(entry, versions.current, versions.target) else {
            continue;
        };
        let identity = ObjectIdentity::of(&object.value, namespace);
        let id = format!("helm|{}|{}|{}", helm.namespace, helm.name, identity.key());
        let mut f = finding(entry, how, UpgradeSource::HelmRelease, id);
        f.object = Some(UpgradeObjectRef {
            api_version: api_version.to_string(),
            kind: kind.to_string(),
            namespace: identity.namespace,
            name: identity.name,
        });
        f.helm = Some(helm.clone());
        f.detail = object.source;
        out.push(f);
    }
    out
}

/// Custom resource versions the CRD itself marks `deprecated: true` while
/// still serving them. When no served version is left that is not
/// deprecated, clients have nothing to move to yet (`crd_only_deprecated`).
pub fn crd_findings(crd: &Value) -> Vec<UpgradeFinding> {
    let name = str_at(crd, "/metadata/name");
    let group = str_at(crd, "/spec/group");
    let kind = str_at(crd, "/spec/names/kind");
    let versions: &[Value] = crd
        .pointer("/spec/versions")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let flag = |v: &Value, key: &str| v.get(key).and_then(Value::as_bool).unwrap_or(false);
    let alternative = versions
        .iter()
        .find(|v| flag(v, "served") && !flag(v, "deprecated"))
        .map(|v| format!("{group}/{}", str_at(v, "/name")));
    versions
        .iter()
        .filter(|v| flag(v, "served") && flag(v, "deprecated"))
        .map(|v| {
            let api_version = format!("{group}/{}", str_at(v, "/name"));
            UpgradeFinding {
                id: format!("crd|{name}|{api_version}"),
                severity: UpgradeSeverity::Warning,
                source: UpgradeSource::Crd,
                api_version,
                kind: kind.to_string(),
                deprecated_in: None,
                removed_in: None,
                replacement: alternative.clone(),
                replacement_kind: None,
                notes: vec![if alternative.is_some() {
                    "crd_deprecated_version".to_string()
                } else {
                    "crd_only_deprecated".to_string()
                }],
                already_removed: false,
                object: Some(UpgradeObjectRef {
                    api_version: "apiextensions.k8s.io/v1".into(),
                    kind: "CustomResourceDefinition".into(),
                    namespace: None,
                    name: name.to_string(),
                }),
                helm: None,
                managers: Vec::new(),
                detail: Some(str_at(v, "/deprecationWarning").to_string())
                    .filter(|w| !w.is_empty()),
            }
        })
        .collect()
}

/// Aggregated API services (backed by a service, not the API server
/// itself) that register a group-version of the table: the extension
/// server keeps a removed API alive until it is upgraded or removed.
pub fn apiservice_findings(apiservice: &Value, versions: Versions) -> Vec<UpgradeFinding> {
    if apiservice
        .pointer("/spec/service")
        .is_none_or(Value::is_null)
    {
        return Vec::new();
    }
    let name = str_at(apiservice, "/metadata/name");
    let group = str_at(apiservice, "/spec/group");
    let version = str_at(apiservice, "/spec/version");
    let api_version = if group.is_empty() {
        version.to_string()
    } else {
        format!("{group}/{version}")
    };
    deprecations::table()
        .iter()
        .filter(|e| e.api_version == api_version)
        .filter_map(|entry| {
            let how = impact(entry, versions.current, versions.target)?;
            let id = format!("apiservice|{name}|{}", entry.kind);
            let mut f = finding(entry, how, UpgradeSource::ApiService, id);
            f.object = Some(UpgradeObjectRef {
                api_version: "apiregistration.k8s.io/v1".into(),
                kind: "APIService".into(),
                namespace: None,
                name: name.to_string(),
            });
            f.detail = Some(format!(
                "{}/{}",
                str_at(apiservice, "/spec/service/namespace"),
                str_at(apiservice, "/spec/service/name")
            ));
            Some(f)
        })
        .collect()
}

/// `apiserver_requested_deprecated_apis` series (labels `group`, `version`,
/// `resource`, `subresource`, `removed_release`): deprecated APIs clients
/// requested since the API server started. Known APIs take the table's
/// data; others the metric's `removed_release`.
pub fn metric_findings(series: &[PromQuerySeries], versions: Versions) -> Vec<UpgradeFinding> {
    let mut out: BTreeMap<String, UpgradeFinding> = BTreeMap::new();
    for s in series {
        let label = |k: &str| s.labels.get(k).map(String::as_str).unwrap_or("");
        let (group, version, resource) = (label("group"), label("version"), label("resource"));
        if version.is_empty() || resource.is_empty() {
            continue;
        }
        let api_version = if group.is_empty() {
            version.to_string()
        } else {
            format!("{group}/{version}")
        };
        let subresource = label("subresource");
        let detail = if subresource.is_empty() {
            resource.to_string()
        } else {
            format!("{resource}/{subresource}")
        };
        let id = format!("metrics|{api_version}|{detail}");
        let f = match deprecations::lookup_resource(&api_version, resource) {
            Some(entry) => {
                let Some(how) = impact(entry, versions.current, versions.target) else {
                    continue;
                };
                finding(entry, how, UpgradeSource::Metrics, id.clone())
            }
            None => {
                let removed = Minor::parse(label("removed_release"));
                let removed_in_target = removed.is_some_and(|r| r <= versions.target);
                UpgradeFinding {
                    id: id.clone(),
                    severity: if removed_in_target {
                        UpgradeSeverity::Blocker
                    } else {
                        UpgradeSeverity::Warning
                    },
                    source: UpgradeSource::Metrics,
                    api_version,
                    kind: resource.to_string(),
                    deprecated_in: None,
                    removed_in: removed.map(|r| r.to_string()),
                    replacement: None,
                    replacement_kind: None,
                    notes: Vec::new(),
                    already_removed: removed.is_some_and(|r| r <= versions.current),
                    object: None,
                    helm: None,
                    managers: Vec::new(),
                    detail: None,
                }
            }
        };
        out.insert(
            id,
            UpgradeFinding {
                detail: Some(detail),
                ..f
            },
        );
    }
    out.into_values().collect()
}

fn source_rank(source: UpgradeSource) -> u8 {
    match source {
        UpgradeSource::HelmRelease => 0,
        UpgradeSource::LastApplied => 1,
        UpgradeSource::ManagedFields => 2,
        UpgradeSource::Metrics => 3,
        UpgradeSource::ApiService => 4,
        UpgradeSource::Crd => 5,
    }
}

/// Blockers first, then by source, kind, namespace and name.
pub fn sort_findings(findings: &mut [UpgradeFinding]) {
    let place = |f: &UpgradeFinding| {
        (
            f.severity,
            source_rank(f.source),
            f.kind.clone(),
            f.object.as_ref().and_then(|o| o.namespace.clone()),
            f.object
                .as_ref()
                .map(|o| o.name.clone())
                .unwrap_or_default(),
            f.id.clone(),
        )
    };
    findings.sort_by_key(place);
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::ManagedFieldsEntry;
    use serde_json::json;

    fn v(current: u32, target: u32) -> Versions {
        Versions {
            current: Minor::new(1, current),
            target: Minor::new(1, target),
        }
    }

    fn resource(group: &str, version: &str, kind: &str, plural: &str) -> ApiResourceInfo {
        ApiResourceInfo {
            group: group.into(),
            version: version.into(),
            kind: kind.into(),
            plural: plural.into(),
            namespaced: true,
            api_version: if group.is_empty() {
                version.into()
            } else {
                format!("{group}/{version}")
            },
            verbs: vec!["get".into(), "list".into()],
            short_names: vec![],
            categories: vec![],
        }
    }

    fn managed(manager: &str, api_version: &str) -> ManagedFieldsEntry {
        ManagedFieldsEntry {
            manager: Some(manager.into()),
            api_version: Some(api_version.into()),
            operation: Some("Update".into()),
            ..Default::default()
        }
    }

    #[test]
    fn scan_targets_pick_one_served_resource_per_kind() {
        let resources = vec![
            resource("networking.k8s.io", "v1", "Ingress", "ingresses"),
            // An old cluster also serves the kind in its old group.
            resource("extensions", "v1beta1", "Ingress", "ingresses"),
            resource("batch", "v1", "CronJob", "cronjobs"),
            resource("", "v1", "Event", "events"),
            resource("", "v1", "Endpoints", "endpoints"),
            resource("authentication.k8s.io", "v1", "TokenReview", "tokenreviews"),
            resource("apps", "v1", "Deployment", "deployments"),
            resource("", "v1", "Pod", "pods"),
        ];
        let targets = scan_targets(&resources);
        let names: Vec<String> = targets
            .iter()
            .map(|r| format!("{}/{}", r.api_version, r.kind))
            .collect();
        assert_eq!(
            names,
            vec![
                "batch/v1/CronJob",
                "apps/v1/Deployment",
                "networking.k8s.io/v1/Ingress"
            ]
        );
    }

    #[test]
    fn last_applied_and_managed_fields_are_matched() {
        let ingress = resource("networking.k8s.io", "v1", "Ingress", "ingresses");
        let meta = ObjectMeta {
            name: Some("shop".into()),
            namespace: Some("web".into()),
            annotations: Some(
                [(
                    LAST_APPLIED.to_string(),
                    r#"{"apiVersion":"extensions/v1beta1","kind":"Ingress"}"#.to_string(),
                )]
                .into(),
            ),
            managed_fields: Some(vec![
                managed("kubectl-client-side-apply", "extensions/v1beta1"),
                managed("nginx-ingress-controller", "networking.k8s.io/v1beta1"),
                managed("kube-controller-manager", "networking.k8s.io/v1"),
            ]),
            ..Default::default()
        };
        let findings = object_findings(&ingress, &meta, v(24, 25));
        assert_eq!(findings.len(), 2);
        let ext = &findings[0];
        assert_eq!(ext.api_version, "extensions/v1beta1");
        assert_eq!(ext.source, UpgradeSource::LastApplied);
        assert_eq!(ext.severity, UpgradeSeverity::Blocker);
        assert!(ext.already_removed, "gone since 1.22");
        assert_eq!(ext.managers, vec!["kubectl-client-side-apply"]);
        assert_eq!(ext.replacement.as_deref(), Some("networking.k8s.io/v1"));
        let object = ext.object.as_ref().unwrap();
        assert_eq!(object.api_version, "networking.k8s.io/v1");
        assert_eq!(object.namespace.as_deref(), Some("web"));
        let beta = &findings[1];
        assert_eq!(beta.source, UpgradeSource::ManagedFields);
        assert_eq!(beta.managers, vec!["nginx-ingress-controller"]);

        // Current versions only: nothing to report.
        let clean = ObjectMeta {
            name: Some("ok".into()),
            managed_fields: Some(vec![managed("kubectl", "networking.k8s.io/v1")]),
            annotations: Some([(LAST_APPLIED.to_string(), "not json".to_string())].into()),
            ..Default::default()
        };
        assert!(object_findings(&ingress, &clean, v(31, 32)).is_empty());

        // Deprecated but still served in the target: a warning.
        let hpa = resource(
            "autoscaling",
            "v2",
            "HorizontalPodAutoscaler",
            "horizontalpodautoscalers",
        );
        let meta = ObjectMeta {
            name: Some("api".into()),
            namespace: Some("shop".into()),
            managed_fields: Some(vec![managed("argocd-controller", "autoscaling/v2beta2")]),
            ..Default::default()
        };
        let findings = object_findings(&hpa, &meta, v(23, 24));
        assert_eq!(findings[0].severity, UpgradeSeverity::Warning);
        assert_eq!(
            object_findings(&hpa, &meta, v(25, 26))[0].severity,
            UpgradeSeverity::Blocker
        );
    }

    #[test]
    fn helm_manifests_are_matched() {
        let release = json!({
            "name": "portal", "namespace": "legacy", "version": 7,
            "chart": {"metadata": {"name": "acme-portal", "version": "0.9.1"}},
            "manifest": "---\n# Source: acme-portal/templates/ingress.yaml\napiVersion: extensions/v1beta1\nkind: Ingress\nmetadata:\n  name: portal\n---\n# Source: acme-portal/templates/cron.yaml\napiVersion: batch/v1beta1\nkind: CronJob\nmetadata:\n  name: cleanup\n  namespace: jobs\n---\n# Source: acme-portal/templates/deploy.yaml\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: portal\n---\n# Source: acme-portal/templates/fs.yaml\napiVersion: flowcontrol.apiserver.k8s.io/v1beta3\nkind: FlowSchema\nmetadata:\n  name: portal\n"
        });
        let findings = helm_findings(&release, "fallback", v(31, 32));
        assert_eq!(findings.len(), 3);
        let ingress = &findings[0];
        assert_eq!(ingress.source, UpgradeSource::HelmRelease);
        assert_eq!(ingress.severity, UpgradeSeverity::Blocker);
        assert!(ingress.already_removed);
        assert_eq!(
            ingress.detail.as_deref(),
            Some("acme-portal/templates/ingress.yaml")
        );
        let helm = ingress.helm.as_ref().unwrap();
        assert_eq!(
            (helm.namespace.as_str(), helm.name.as_str(), helm.revision),
            ("legacy", "portal", 7)
        );
        assert_eq!(helm.chart_version, "0.9.1");
        assert_eq!(
            ingress.object.as_ref().unwrap().namespace.as_deref(),
            Some("legacy")
        );
        assert_eq!(
            findings[1].object.as_ref().unwrap().namespace.as_deref(),
            Some("jobs")
        );
        // FlowSchema v1beta3 is removed in exactly the target release, and cluster-scoped.
        let fs = &findings[2];
        assert_eq!(fs.severity, UpgradeSeverity::Blocker);
        assert!(!fs.already_removed);
        assert_eq!(fs.object.as_ref().unwrap().namespace, None);
        // One release earlier the FlowSchema is only deprecated.
        let earlier = helm_findings(&release, "fallback", v(30, 31));
        assert_eq!(earlier[2].severity, UpgradeSeverity::Warning);
        assert!(helm_findings(&json!({"name": "x"}), "ns", v(31, 32)).is_empty());
    }

    #[test]
    fn crds_apiservices_and_metrics() {
        let crd = json!({"metadata": {"name": "widgets.acme.io"},
            "spec": {"group": "acme.io", "names": {"kind": "Widget"}, "versions": [
                {"name": "v1alpha1", "served": true, "storage": false, "deprecated": true,
                 "deprecationWarning": "acme.io/v1alpha1 Widget is deprecated; use acme.io/v1"},
                {"name": "v1beta1", "served": false, "deprecated": true},
                {"name": "v1", "served": true, "storage": true}]}});
        let findings = crd_findings(&crd);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].api_version, "acme.io/v1alpha1");
        assert_eq!(findings[0].replacement.as_deref(), Some("acme.io/v1"));
        assert_eq!(findings[0].notes, vec!["crd_deprecated_version"]);
        assert!(findings[0]
            .detail
            .as_deref()
            .unwrap()
            .contains("deprecated"));
        let only = json!({"metadata": {"name": "gadgets.acme.io"},
            "spec": {"group": "acme.io", "names": {"kind": "Gadget"}, "versions": [
                {"name": "v1beta1", "served": true, "storage": true, "deprecated": true}]}});
        assert_eq!(crd_findings(&only)[0].notes, vec!["crd_only_deprecated"]);
        assert_eq!(crd_findings(&only)[0].replacement, None);

        let local = json!({"metadata": {"name": "v1beta1.batch"},
            "spec": {"group": "batch", "version": "v1beta1", "service": null}});
        assert!(apiservice_findings(&local, v(24, 25)).is_empty());
        let aggregated = json!({"metadata": {"name": "v1beta1.batch"},
            "spec": {"group": "batch", "version": "v1beta1",
                     "service": {"namespace": "ext", "name": "batch-shim"}}});
        let found = apiservice_findings(&aggregated, v(24, 25));
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].kind, "CronJob");
        assert_eq!(found[0].detail.as_deref(), Some("ext/batch-shim"));

        let series = |group: &str, version: &str, resource: &str, removed: &str| PromQuerySeries {
            labels: [
                ("group", group),
                ("version", version),
                ("resource", resource),
                ("subresource", ""),
                ("removed_release", removed),
            ]
            .into_iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
            points: vec![(0, 1.0)],
        };
        let metrics = metric_findings(
            &[
                series(
                    "flowcontrol.apiserver.k8s.io",
                    "v1beta3",
                    "flowschemas",
                    "1.32",
                ),
                series(
                    "flowcontrol.apiserver.k8s.io",
                    "v1beta3",
                    "flowschemas",
                    "1.32",
                ),
                series("example.io", "v1beta1", "things", "1.40"),
                series("", "", "", ""),
            ],
            v(31, 32),
        );
        assert_eq!(
            metrics.len(),
            2,
            "duplicates merge, empty series are skipped"
        );
        let unknown = metrics.iter().find(|f| f.kind == "things").unwrap();
        assert_eq!(unknown.severity, UpgradeSeverity::Warning);
        assert_eq!(unknown.removed_in.as_deref(), Some("1.40"));
        let fs = metrics.iter().find(|f| f.kind == "FlowSchema").unwrap();
        assert_eq!(fs.severity, UpgradeSeverity::Blocker);
        assert_eq!(fs.detail.as_deref(), Some("flowschemas"));

        let mut all = [findings, metrics].concat();
        sort_findings(&mut all);
        assert_eq!(all[0].severity, UpgradeSeverity::Blocker);
        assert_eq!(all.last().unwrap().source, UpgradeSource::Crd);
    }
}
