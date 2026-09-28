//! The strategic merge patch that applies a recommendation.
//!
//! Containers are merged by name (their patch merge key), so only the named
//! containers and only the given resource keys change:
//!
//! ```json
//! {"metadata":{"annotations":{"kubernetes.io/change-cause":"kubepit right-size deployment/web"}},
//!  "spec":{"template":{"spec":{"containers":[
//!    {"name":"app","resources":{"requests":{"cpu":"250m","memory":"320Mi"},"limits":{"memory":"448Mi"}}}]}}}}
//! ```
//!
//! A CronJob's containers sit at `spec.jobTemplate.spec.template.spec`
//! ([`template_path`]).
//!
//! Quantities are written the way people write them: whole cores as `2`,
//! otherwise millicores (`250m`); memory in `Gi` when whole, else `Mi`
//! (rounded up), else `Ki`.

use anyhow::{bail, Result};
use serde_json::{json, Map, Value};

use super::types::ContainerResourceChange;
use crate::rollout::CHANGE_CAUSE_ANNOTATION;

const KIB: f64 = 1024.0;
const MIB: f64 = 1024.0 * KIB;
const GIB: f64 = 1024.0 * MIB;

/// Kinds right-sizing can patch, with the path of their pod spec. A
/// CronJob's is its job template's, so only the Jobs it starts from then
/// on get the new values.
pub fn template_path(kind: &str) -> Option<&'static [&'static str]> {
    match kind {
        "Deployment" | "StatefulSet" | "DaemonSet" => Some(&["spec", "template", "spec"]),
        "CronJob" => Some(&["spec", "jobTemplate", "spec", "template", "spec"]),
        _ => None,
    }
}

/// `2`, `1500m`, `250m` (rounded up to whole millicores).
pub fn format_cpu(millicores: f64) -> String {
    let m = millicores.max(0.0).ceil() as u64;
    if m > 0 && m.is_multiple_of(1000) {
        format!("{}", m / 1000)
    } else {
        format!("{m}m")
    }
}

/// `2Gi`, `320Mi`, `1536Mi`, `100Ki` (rounded up).
pub fn format_memory(bytes: f64) -> String {
    let b = bytes.max(0.0);
    if b >= GIB && (b / GIB).fract() == 0.0 {
        format!("{}Gi", (b / GIB) as u64)
    } else if b >= MIB {
        format!("{}Mi", (b / MIB).ceil() as u64)
    } else if b >= KIB {
        format!("{}Ki", (b / KIB).ceil() as u64)
    } else {
        format!("{}", b.ceil() as u64)
    }
}

fn positive(value: Option<f64>) -> bool {
    value.is_none_or(|v| v.is_finite() && v > 0.0)
}

/// Every value positive and finite, requests not above limits, names unique.
pub fn validate(changes: &[ContainerResourceChange]) -> Result<()> {
    if changes.is_empty() {
        bail!("nothing to change");
    }
    let mut seen = std::collections::HashSet::new();
    for c in changes {
        if c.container.trim().is_empty() {
            bail!("a container name is required");
        }
        if !seen.insert(c.container.as_str()) {
            bail!("container \"{}\" is listed twice", c.container);
        }
        if ![c.cpu_request, c.cpu_limit, c.memory_request, c.memory_limit]
            .into_iter()
            .all(positive)
        {
            bail!(
                "resource values of container \"{}\" must be positive",
                c.container
            );
        }
        if let (Some(r), Some(l)) = (c.cpu_request, c.cpu_limit) {
            if r > l {
                bail!(
                    "the CPU request of container \"{}\" is above its limit",
                    c.container
                );
            }
        }
        if let (Some(r), Some(l)) = (c.memory_request, c.memory_limit) {
            if r > l {
                bail!(
                    "the memory request of container \"{}\" is above its limit",
                    c.container
                );
            }
        }
        if [c.cpu_request, c.cpu_limit, c.memory_request, c.memory_limit]
            .iter()
            .all(Option::is_none)
        {
            bail!("no new values for container \"{}\"", c.container);
        }
    }
    Ok(())
}

/// Change cause recorded on the workload (`kubepit right-size deployment/web`).
pub fn change_cause(kind: &str, name: &str) -> String {
    format!("kubepit right-size {}/{name}", kind.to_ascii_lowercase())
}

/// The strategic merge patch of `changes` at `path`.
pub fn resources_patch(
    path: &[&str],
    changes: &[ContainerResourceChange],
    change_cause: Option<&str>,
) -> Value {
    let containers: Vec<Value> = changes
        .iter()
        .map(|c| {
            let mut requests = Map::new();
            let mut limits = Map::new();
            if let Some(v) = c.cpu_request {
                requests.insert("cpu".into(), json!(format_cpu(v)));
            }
            if let Some(v) = c.memory_request {
                requests.insert("memory".into(), json!(format_memory(v)));
            }
            if let Some(v) = c.cpu_limit {
                limits.insert("cpu".into(), json!(format_cpu(v)));
            }
            if let Some(v) = c.memory_limit {
                limits.insert("memory".into(), json!(format_memory(v)));
            }
            let mut resources = Map::new();
            if !requests.is_empty() {
                resources.insert("requests".into(), Value::Object(requests));
            }
            if !limits.is_empty() {
                resources.insert("limits".into(), Value::Object(limits));
            }
            json!({"name": c.container, "resources": resources})
        })
        .collect();
    let mut node = json!({ "containers": containers });
    for key in path.iter().rev() {
        let mut wrapped = Map::new();
        wrapped.insert((*key).to_string(), node);
        node = Value::Object(wrapped);
    }
    if let Some(cause) = change_cause {
        let mut annotations = Map::new();
        annotations.insert(CHANGE_CAUSE_ANNOTATION.to_string(), json!(cause));
        node["metadata"] = json!({ "annotations": annotations });
    }
    node
}

/// Container names of the live object's pod spec at `path`.
pub fn live_containers(live: &Value, path: &[&str]) -> Vec<String> {
    let mut node = live;
    for key in path {
        match node.get(*key) {
            Some(next) => node = next,
            None => return Vec::new(),
        }
    }
    node.get("containers")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|c| c.get("name").and_then(Value::as_str).map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(container: &str) -> ContainerResourceChange {
        ContainerResourceChange {
            container: container.into(),
            cpu_request: Some(250.0),
            cpu_limit: None,
            memory_request: Some(320.0 * MIB),
            memory_limit: Some(448.0 * MIB),
        }
    }

    #[test]
    fn quantities_are_written_like_people_write_them() {
        assert_eq!(format_cpu(250.0), "250m");
        assert_eq!(format_cpu(249.2), "250m", "rounded up");
        assert_eq!(format_cpu(2000.0), "2");
        assert_eq!(format_cpu(1500.0), "1500m");
        assert_eq!(format_memory(320.0 * MIB), "320Mi");
        assert_eq!(format_memory(2.0 * GIB), "2Gi");
        assert_eq!(format_memory(1.5 * GIB), "1536Mi");
        assert_eq!(format_memory(300.5 * MIB), "301Mi");
        assert_eq!(format_memory(100.0 * KIB), "100Ki");
        assert_eq!(format_memory(512.0), "512");
    }

    #[test]
    fn patch_names_containers_at_the_template_path() {
        let path = template_path("Deployment").unwrap();
        let patch = resources_patch(
            path,
            &[
                change("app"),
                ContainerResourceChange {
                    container: "sidecar".into(),
                    cpu_request: None,
                    cpu_limit: Some(1000.0),
                    memory_request: None,
                    memory_limit: None,
                },
            ],
            Some(&change_cause("Deployment", "web")),
        );
        assert_eq!(
            patch,
            json!({
                "metadata": {"annotations": {"kubernetes.io/change-cause": "kubepit right-size deployment/web"}},
                "spec": {"template": {"spec": {"containers": [
                    {"name": "app", "resources": {
                        "requests": {"cpu": "250m", "memory": "320Mi"},
                        "limits": {"memory": "448Mi"}}},
                    {"name": "sidecar", "resources": {"limits": {"cpu": "1"}}}
                ]}}}
            })
        );
        assert!(template_path("StatefulSet").is_some());
        assert!(template_path("DaemonSet").is_some());
        assert!(
            template_path("Job").is_none(),
            "Jobs are recommended through their CronJob"
        );
        assert!(template_path("Pod").is_none());
    }

    #[test]
    fn cronjob_patches_the_job_template() {
        let path = template_path("CronJob").unwrap();
        assert_eq!(path, &["spec", "jobTemplate", "spec", "template", "spec"]);
        let body = resources_patch(
            path,
            &[change("job")],
            Some(&change_cause("CronJob", "nightly")),
        );
        assert_eq!(
            body.pointer(
                "/spec/jobTemplate/spec/template/spec/containers/0/resources/requests/cpu"
            ),
            Some(&json!("250m"))
        );
        assert!(body.pointer("/spec/template").is_none());
        assert_eq!(
            body["metadata"]["annotations"]["kubernetes.io/change-cause"],
            "kubepit right-size cronjob/nightly"
        );
        let live = json!({"spec": {"jobTemplate": {"spec": {"template": {"spec": {
            "containers": [{"name": "job"}]}}}}}});
        assert_eq!(live_containers(&live, path), vec!["job"]);
    }

    #[test]
    fn changes_are_validated() {
        assert!(validate(&[change("app")]).is_ok());
        assert!(validate(&[]).is_err());
        assert!(
            validate(&[change("app"), change("app")]).is_err(),
            "duplicate"
        );
        let mut bad = change("app");
        bad.cpu_request = Some(-1.0);
        assert!(validate(&[bad]).is_err());
        let mut nan = change("app");
        nan.memory_limit = Some(f64::NAN);
        assert!(validate(&[nan]).is_err());
        let mut inverted = change("app");
        inverted.memory_request = Some(GIB);
        assert!(validate(&[inverted]).is_err(), "request above limit");
        let empty = ContainerResourceChange {
            container: "app".into(),
            cpu_request: None,
            cpu_limit: None,
            memory_request: None,
            memory_limit: None,
        };
        assert!(validate(&[empty]).is_err());
    }

    #[test]
    fn live_container_names() {
        let live = json!({"spec": {"template": {"spec": {"containers": [{"name": "app"}, {"name": "proxy"}]}}}});
        assert_eq!(
            live_containers(&live, template_path("Deployment").unwrap()),
            vec!["app", "proxy"]
        );
        assert!(live_containers(&json!({}), &["spec"]).is_empty());
    }
}
