//! Set image: `kubectl set image` for pods and pod-template workloads.
//!
//! The change is a strategic merge patch that names each container (the
//! merge key) with its new image, at the kind's pod spec path. Workloads also
//! get a `kubernetes.io/change-cause` annotation (`kubepit set image
//! deployment/web web=nginx:1.27`), which the controllers copy onto the new
//! ReplicaSet / ControllerRevision so rollout history shows what happened.
//!
//! Image references are sanity-checked before anything is sent (the API
//! server only rejects empty images; a typo would otherwise surface as an
//! `ImagePullBackOff` minutes later). Entries that already match the live
//! image are dropped, so a no-op never rewrites the change-cause.

use anyhow::{anyhow, bail, Context, Result};
use kube::api::{Patch, PatchParams};
use serde_json::{json, Map, Value};

use crate::app::Kubepit;
use crate::error::kube_error;
use crate::objects::to_kube_object;
use crate::resources::object_api;
use crate::rollout::CHANGE_CAUSE_ANNOTATION;
use crate::types::{ContainerImage, Gvk, KubeObject};

/// Longest image reference accepted (Docker caps repository names at 255;
/// registry, tag and digest come on top).
const MAX_IMAGE_LEN: usize = 512;

/// JSON path of the pod spec for the kinds set image supports.
pub fn pod_spec_path(group: &str, kind: &str) -> Option<&'static [&'static str]> {
    match (group, kind) {
        ("", "Pod") => Some(&["spec"]),
        ("apps", "Deployment" | "StatefulSet" | "DaemonSet" | "ReplicaSet")
        | ("", "ReplicationController")
        | ("batch", "Job") => Some(&["spec", "template", "spec"]),
        ("batch", "CronJob") => Some(&["spec", "jobTemplate", "spec", "template", "spec"]),
        _ => None,
    }
}

fn is_tag_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-')
}

/// Sanity check of an image reference: `[registry[:port]/]path[:tag][@algo:hex]`.
/// Deliberately looser than the OCI grammar (registries differ); it catches
/// blanks, whitespace, stray characters and malformed tags or digests.
pub fn validate_image(image: &str) -> Result<()> {
    if image.is_empty() {
        bail!("the image must not be empty");
    }
    if image.chars().any(char::is_whitespace) {
        bail!("image \"{image}\" must not contain whitespace");
    }
    if image.len() > MAX_IMAGE_LEN {
        bail!("image \"{image}\" is longer than {MAX_IMAGE_LEN} characters");
    }
    if let Some(c) = image
        .chars()
        .find(|c| !(c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/' | ':' | '@')))
    {
        bail!("image \"{image}\" contains the invalid character '{c}'");
    }
    let (name, digest) = match image.split_once('@') {
        Some((name, digest)) => (name, Some(digest)),
        None => (image, None),
    };
    if let Some(digest) = digest {
        let valid = digest.split_once(':').is_some_and(|(algo, hex)| {
            !algo.is_empty()
                && algo.chars().all(|c| c.is_ascii_alphanumeric())
                && hex.len() >= 32
                && hex.chars().all(|c| c.is_ascii_hexdigit())
        });
        if !valid {
            bail!(
                "image \"{image}\" has an invalid digest (expected e.g. @sha256:<64 hex digits>)"
            );
        }
    }
    if !name.starts_with(|c: char| c.is_ascii_alphanumeric()) {
        bail!("image \"{image}\" must start with a letter or digit");
    }
    let parts: Vec<&str> = name.split('/').collect();
    if parts.iter().any(|p| p.is_empty()) {
        bail!("image \"{image}\" has an empty path component");
    }
    let last = parts.len() - 1;
    for (index, part) in parts.iter().enumerate() {
        // A colon is a registry port in the first component (when a path
        // follows) or the tag separator in the last one.
        let colons = part.matches(':').count();
        let allowed = if index == last {
            1
        } else {
            usize::from(index == 0)
        };
        if colons > allowed {
            bail!("image \"{image}\" has a misplaced ':'");
        }
    }
    if let Some((repo, tag)) = parts[last].split_once(':') {
        if repo.is_empty() {
            bail!("image \"{image}\" has no repository name");
        }
        if tag.is_empty() || tag.len() > 128 || !tag.chars().all(is_tag_char) {
            bail!("image \"{image}\" has an invalid tag \"{tag}\"");
        }
        if tag.starts_with(['.', '-']) {
            bail!("image \"{image}\" has an invalid tag \"{tag}\"");
        }
    }
    Ok(())
}

/// Reject empty requests, blank container names, duplicates and bad images.
pub fn validate_request(images: &[ContainerImage]) -> Result<()> {
    if images.is_empty() {
        bail!("no images to set");
    }
    let mut seen = std::collections::HashSet::new();
    for entry in images {
        if entry.container.trim().is_empty() {
            bail!("a container name is required");
        }
        if !seen.insert((entry.init, entry.container.as_str())) {
            bail!("container {} is listed twice", entry.container);
        }
        validate_image(&entry.image)?;
    }
    Ok(())
}

fn pod_spec<'a>(obj: &'a Value, path: &[&str]) -> Option<&'a Value> {
    path.iter().try_fold(obj, |cur, key| cur.get(*key))
}

/// The requested entries that actually change something. Fails when a
/// container does not exist on the object (like `kubectl set image`).
pub fn pending_changes(
    obj: &Value,
    path: &[&str],
    images: &[ContainerImage],
) -> Result<Vec<ContainerImage>> {
    let spec = pod_spec(obj, path);
    let mut out = Vec::new();
    for entry in images {
        let list = if entry.init {
            "initContainers"
        } else {
            "containers"
        };
        let current = spec
            .and_then(|s| s.get(list))
            .and_then(Value::as_array)
            .and_then(|cs| {
                cs.iter()
                    .find(|c| c.get("name").and_then(Value::as_str) == Some(&entry.container))
            })
            .ok_or_else(|| {
                anyhow!(
                    "{} \"{}\" not found",
                    if entry.init {
                        "init container"
                    } else {
                        "container"
                    },
                    entry.container
                )
            })?;
        if current.get("image").and_then(Value::as_str) != Some(entry.image.as_str()) {
            out.push(entry.clone());
        }
    }
    Ok(out)
}

/// `kubepit set image deployment/web web=nginx:1.27 envoy=envoy:v1.33`.
pub fn change_cause(kind: &str, name: &str, images: &[ContainerImage]) -> String {
    let pairs: Vec<String> = images
        .iter()
        .map(|i| format!("{}={}", i.container, i.image))
        .collect();
    format!(
        "kubepit set image {}/{name} {}",
        kind.to_lowercase(),
        pairs.join(" ")
    )
}

/// Strategic merge patch setting `images` at `path` (see [`pod_spec_path`]).
pub fn set_image_patch(
    path: &[&str],
    images: &[ContainerImage],
    change_cause: Option<&str>,
) -> Value {
    let entries = |init: bool| -> Vec<Value> {
        images
            .iter()
            .filter(|i| i.init == init)
            .map(|i| json!({"name": i.container, "image": i.image}))
            .collect()
    };
    let mut spec = Map::new();
    for (key, init) in [("containers", false), ("initContainers", true)] {
        let list = entries(init);
        if !list.is_empty() {
            spec.insert(key.into(), Value::Array(list));
        }
    }
    let mut patch = Value::Object(spec);
    for key in path.iter().rev() {
        let mut wrapper = Map::new();
        wrapper.insert((*key).to_string(), patch);
        patch = Value::Object(wrapper);
    }
    if let Some(cause) = change_cause {
        patch["metadata"] = json!({ "annotations": { CHANGE_CAUSE_ANNOTATION: cause } });
    }
    patch
}

impl Kubepit {
    /// `resource_set_image`: returns the patched object.
    pub(crate) async fn resource_set_image_unaudited(
        &self,
        cluster_id: &str,
        gvk: &Gvk,
        namespace: Option<&str>,
        name: &str,
        images: Vec<ContainerImage>,
    ) -> Result<KubeObject> {
        self.ensure_writable(cluster_id, "set image")?;
        let path = pod_spec_path(&gvk.group, &gvk.kind)
            .ok_or_else(|| anyhow!("set image is not supported for {}", gvk.kind))?;
        validate_request(&images)?;
        let client = self.client(cluster_id).await?;
        let (api, ar) = object_api(client, gvk, namespace)?;
        let live = api
            .get(name)
            .await
            .map_err(kube_error)
            .with_context(|| format!("failed to get {} {name}", gvk.kind))?;
        let live = serde_json::to_value(live)?;
        let changes = pending_changes(&live, path, &images)
            .with_context(|| format!("cannot set image on {} {name}", gvk.kind))?;
        if changes.is_empty() {
            bail!("{} {name} already runs these images", gvk.kind);
        }
        let cause = (gvk.kind != "Pod").then(|| change_cause(&gvk.kind, name, &changes));
        let patch = set_image_patch(path, &changes, cause.as_deref());
        let obj = api
            .patch(name, &PatchParams::default(), &Patch::Strategic(&patch))
            .await
            .map_err(kube_error)
            .with_context(|| format!("failed to set image on {} {name}", gvk.kind))?;
        Ok(to_kube_object(obj, &ar))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image(container: &str, image: &str, init: bool) -> ContainerImage {
        ContainerImage {
            container: container.into(),
            image: image.into(),
            init,
        }
    }

    #[test]
    fn accepts_common_references() {
        for ok in [
            "nginx",
            "nginx:1.27",
            "library/nginx:1.27-alpine",
            "ghcr.io/acme/payment-api:2.14.3",
            "localhost:5000/app",
            "registry.example.com:5000/team/app:v1.2.3_rc.1",
            "nginx@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            "nginx:1.27@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            "123456789012.dkr.ecr.eu-west-1.amazonaws.com/api:latest",
        ] {
            validate_image(ok).unwrap_or_else(|e| panic!("{ok}: {e}"));
        }
    }

    #[test]
    fn rejects_malformed_references() {
        for (bad, why) in [
            ("", "empty"),
            ("nginx 1.27", "whitespace"),
            (" nginx", "whitespace"),
            ("nginx:", "invalid tag"),
            ("nginx:1.27!", "invalid character"),
            ("nginx:-1", "invalid tag"),
            ("/nginx", "start with"),
            ("ghcr.io//nginx", "empty path"),
            ("nginx/", "empty path"),
            ("a/b:c/d", "misplaced"),
            ("nginx:1:2", "misplaced"),
            (":1.27", "start with"),
            ("nginx@sha256:xyz", "digest"),
            ("nginx@sha256", "digest"),
        ] {
            let err = validate_image(bad).expect_err(bad).to_string();
            assert!(err.contains(why), "{bad}: {err}");
        }
        assert!(validate_image(&format!("a:{}", "1".repeat(200))).is_err());
    }

    #[test]
    fn requests_are_validated() {
        assert!(validate_request(&[]).is_err());
        assert!(validate_request(&[image(" ", "nginx", false)]).is_err());
        assert!(validate_request(&[image("a", "nginx", false), image("a", "x", false)]).is_err());
        validate_request(&[image("a", "nginx", false), image("a", "busybox", true)]).unwrap();
        assert!(validate_request(&[image("a", "bad image", false)]).is_err());
    }

    #[test]
    fn patch_paths_per_kind() {
        let images = [
            image("web", "nginx:1.27", false),
            image("migrate", "tool:2", true),
        ];
        let pod = set_image_patch(pod_spec_path("", "Pod").unwrap(), &images, None);
        assert_eq!(
            pod,
            json!({"spec": {
                "containers": [{"name": "web", "image": "nginx:1.27"}],
                "initContainers": [{"name": "migrate", "image": "tool:2"}]
            }})
        );
        for (group, kind) in [
            ("apps", "Deployment"),
            ("apps", "StatefulSet"),
            ("apps", "DaemonSet"),
            ("apps", "ReplicaSet"),
            ("", "ReplicationController"),
            ("batch", "Job"),
        ] {
            let path = pod_spec_path(group, kind).unwrap();
            let patch = set_image_patch(path, &images[..1], Some("why"));
            assert_eq!(
                patch["spec"]["template"]["spec"]["containers"][0]["image"], "nginx:1.27",
                "{kind}"
            );
            assert!(patch["spec"]["template"]["spec"]
                .get("initContainers")
                .is_none());
            assert_eq!(
                patch["metadata"]["annotations"][CHANGE_CAUSE_ANNOTATION],
                "why"
            );
        }
        let cron = set_image_patch(pod_spec_path("batch", "CronJob").unwrap(), &images, None);
        assert_eq!(
            cron["spec"]["jobTemplate"]["spec"]["template"]["spec"]["initContainers"][0]["name"],
            "migrate"
        );
        assert!(cron.get("metadata").is_none());
        assert!(pod_spec_path("example.com", "Deployment").is_none());
        assert!(pod_spec_path("", "ConfigMap").is_none());
    }

    #[test]
    fn pending_changes_drop_no_ops_and_reject_unknown_containers() {
        let deployment = json!({"spec": {"template": {"spec": {
            "containers": [{"name": "web", "image": "nginx:1.27"}, {"name": "envoy", "image": "envoy:v1"}],
            "initContainers": [{"name": "migrate", "image": "tool:1"}]
        }}}});
        let path = pod_spec_path("apps", "Deployment").unwrap();
        let changes = pending_changes(
            &deployment,
            path,
            &[
                image("web", "nginx:1.27", false),
                image("envoy", "envoy:v2", false),
                image("migrate", "tool:2", true),
            ],
        )
        .unwrap();
        assert_eq!(
            changes,
            vec![
                image("envoy", "envoy:v2", false),
                image("migrate", "tool:2", true)
            ]
        );
        let err = pending_changes(&deployment, path, &[image("web", "x", true)])
            .unwrap_err()
            .to_string();
        assert!(err.contains("init container \"web\" not found"), "{err}");
        assert_eq!(
            change_cause("Deployment", "web", &changes),
            "kubepit set image deployment/web envoy=envoy:v2 migrate=tool:2"
        );
    }
}
