//! RBAC self-reviews: what the current user may do.
//!
//! Three read-only reviews back the permission-aware UI:
//!
//! - [`Kubepit::access_review`] — one `SelfSubjectAccessReview` per check
//!   (`kubectl auth can-i`), sent concurrently (bounded) with the order of
//!   the checks preserved. A failing check becomes an error decision instead
//!   of failing the batch, so one flaky request never locks the whole UI.
//! - [`Kubepit::access_rules`] — `SelfSubjectRulesReview` for one namespace
//!   (`kubectl auth can-i --list`). The UI evaluates it locally, which
//!   answers hundreds of checks (navigator, permission matrix) with a single
//!   request.
//! - [`Kubepit::access_whoami`] — `SelfSubjectReview` (`kubectl auth whoami`):
//!   `authentication.k8s.io/v1` (1.28+), falling back to `v1beta1` (1.27).
//!
//! Reviews create no objects, so they are allowed on read-only clusters.

use anyhow::{anyhow, bail, Context, Result};
use futures::{stream, StreamExt};
use k8s_openapi::api::authentication::v1::{SelfSubjectReview, UserInfo};
use k8s_openapi::api::authorization::v1::{
    ResourceAttributes, SelfSubjectAccessReview, SelfSubjectAccessReviewSpec,
    SelfSubjectRulesReview, SelfSubjectRulesReviewSpec, SubjectAccessReviewStatus,
    SubjectRulesReviewStatus,
};
use kube::api::{Api, PostParams};
use kube::Client;
use serde_json::{json, Value};

use crate::app::Kubepit;
use crate::error::{api_code, kube_error};
use crate::types::{
    AccessCheck, AccessDecision, AccessNonResourceRule, AccessResourceRule, AccessRules, WhoAmI,
};

/// Concurrent `SelfSubjectAccessReview` requests per batch.
pub const REVIEW_CONCURRENCY: usize = 16;

const SELF_SUBJECT_REVIEW_V1BETA1: &str = "/apis/authentication.k8s.io/v1beta1/selfsubjectreviews";

/// Error returned by `access_whoami` when neither SelfSubjectReview version
/// is served. The UI matches on "not supported by this cluster".
pub const WHOAMI_UNSUPPORTED: &str =
    "SelfSubjectReview is not supported by this cluster (it needs Kubernetes 1.28+, or 1.27 with the beta API)";

fn non_empty(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// The review sent for `check`; empty optional fields are omitted, like
/// `kubectl auth can-i` does.
pub fn access_review_request(check: &AccessCheck) -> SelfSubjectAccessReview {
    SelfSubjectAccessReview {
        spec: SelfSubjectAccessReviewSpec {
            resource_attributes: Some(ResourceAttributes {
                verb: Some(check.verb.trim().to_string()),
                group: Some(check.group.trim().to_string()),
                resource: Some(check.resource.trim().to_string()),
                subresource: non_empty(check.subresource.as_deref()),
                namespace: non_empty(check.namespace.as_deref()),
                name: non_empty(check.name.as_deref()),
                ..ResourceAttributes::default()
            }),
            non_resource_attributes: None,
        },
        ..SelfSubjectAccessReview::default()
    }
}

/// Reduce a review status to the contract shape. An `evaluationError`
/// without a reason becomes the reason, so the UI can still explain it.
pub fn decision_from_status(status: Option<SubjectAccessReviewStatus>) -> AccessDecision {
    let Some(status) = status else {
        return AccessDecision {
            error: Some("the API server returned no review status".into()),
            ..AccessDecision::default()
        };
    };
    AccessDecision {
        allowed: status.allowed,
        denied: status.denied.unwrap_or(false),
        reason: non_empty(status.reason.as_deref())
            .or_else(|| non_empty(status.evaluation_error.as_deref())),
        error: None,
    }
}

fn error_decision(message: String) -> AccessDecision {
    AccessDecision {
        error: Some(message),
        ..AccessDecision::default()
    }
}

pub fn rules_from_status(status: SubjectRulesReviewStatus) -> AccessRules {
    AccessRules {
        resource_rules: status
            .resource_rules
            .into_iter()
            .map(|r| AccessResourceRule {
                verbs: r.verbs,
                api_groups: r.api_groups.unwrap_or_default(),
                resources: r.resources.unwrap_or_default(),
                resource_names: r.resource_names.unwrap_or_default(),
            })
            .collect(),
        non_resource_rules: status
            .non_resource_rules
            .into_iter()
            .map(|r| AccessNonResourceRule {
                verbs: r.verbs,
                non_resource_urls: r.non_resource_urls.unwrap_or_default(),
            })
            .collect(),
        incomplete: status.incomplete,
        evaluation_error: non_empty(status.evaluation_error.as_deref()),
    }
}

pub fn whoami_from_user(user: UserInfo) -> WhoAmI {
    WhoAmI {
        username: user.username.unwrap_or_default(),
        uid: non_empty(user.uid.as_deref()),
        groups: user.groups.unwrap_or_default(),
        extra: user.extra.unwrap_or_default(),
    }
}

async fn review_one(client: Client, check: AccessCheck) -> AccessDecision {
    if check.verb.trim().is_empty() || check.resource.trim().is_empty() {
        return error_decision("an access check needs a verb and a resource".into());
    }
    let api: Api<SelfSubjectAccessReview> = Api::all(client);
    match api
        .create(&PostParams::default(), &access_review_request(&check))
        .await
    {
        Ok(review) => decision_from_status(review.status),
        Err(e) => error_decision(format!("{:#}", kube_error(e))),
    }
}

/// `authentication.k8s.io/v1beta1` SelfSubjectReview (Kubernetes 1.27).
/// Parsed from raw JSON: the typed struct only accepts the v1 apiVersion.
async fn whoami_v1beta1(client: &Client) -> Result<UserInfo> {
    let body = json!({
        "apiVersion": "authentication.k8s.io/v1beta1",
        "kind": "SelfSubjectReview",
        "metadata": {}
    });
    let request = kube::core::Request::new(SELF_SUBJECT_REVIEW_V1BETA1)
        .create(&PostParams::default(), serde_json::to_vec(&body)?)
        .map_err(|e| anyhow!("failed to build the SelfSubjectReview request: {e}"))?;
    let response: Value = client.request(request).await.map_err(kube_error)?;
    let user = response
        .pointer("/status/userInfo")
        .cloned()
        .unwrap_or(Value::Null);
    if user.is_null() {
        bail!("the API server returned no user info");
    }
    serde_json::from_value(user).context("invalid SelfSubjectReview user info")
}

impl Kubepit {
    /// `access_review`: one decision per check, in the order of `checks`.
    pub async fn access_review(
        &self,
        cluster_id: &str,
        checks: Vec<AccessCheck>,
    ) -> Result<Vec<AccessDecision>> {
        if checks.is_empty() {
            return Ok(Vec::new());
        }
        let client = self.client(cluster_id).await?;
        Ok(stream::iter(checks)
            .map(|check| review_one(client.clone(), check))
            .buffered(REVIEW_CONCURRENCY)
            .collect()
            .await)
    }

    /// `access_rules`: the rules RBAC (and any other rule-listing
    /// authorizer) grants the current user in `namespace`, including
    /// cluster-wide grants.
    pub async fn access_rules(&self, cluster_id: &str, namespace: &str) -> Result<AccessRules> {
        let namespace = namespace.trim();
        if namespace.is_empty() {
            bail!("a namespace is required to list access rules");
        }
        let client = self.client(cluster_id).await?;
        let api: Api<SelfSubjectRulesReview> = Api::all(client);
        let review = SelfSubjectRulesReview {
            spec: SelfSubjectRulesReviewSpec {
                namespace: Some(namespace.to_string()),
            },
            ..SelfSubjectRulesReview::default()
        };
        let result = api
            .create(&PostParams::default(), &review)
            .await
            .map_err(kube_error)
            .with_context(|| format!("failed to list access rules in {namespace}"))?;
        let status = result
            .status
            .ok_or_else(|| anyhow!("the API server returned no rules review status"))?;
        Ok(rules_from_status(status))
    }

    /// `access_whoami`: the authenticated user as the API server sees it.
    pub async fn access_whoami(&self, cluster_id: &str) -> Result<WhoAmI> {
        let client = self.client(cluster_id).await?;
        let api: Api<SelfSubjectReview> = Api::all(client.clone());
        let user = match api
            .create(&PostParams::default(), &SelfSubjectReview::default())
            .await
        {
            Ok(review) => review
                .status
                .and_then(|s| s.user_info)
                .ok_or_else(|| anyhow!("the API server returned no user info"))?,
            Err(e) => {
                let err = kube_error(e);
                if api_code(&err) != Some(404) {
                    return Err(err.context("failed to read the current identity"));
                }
                match whoami_v1beta1(&client).await {
                    Ok(user) => user,
                    Err(err) if api_code(&err) == Some(404) => bail!(WHOAMI_UNSUPPORTED),
                    Err(err) => return Err(err.context("failed to read the current identity")),
                }
            }
        };
        let who = whoami_from_user(user);
        // The audit log names this user for later actions on the cluster.
        self.history.remember_identity(cluster_id, &who.username);
        Ok(who)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::api::authorization::v1::{NonResourceRule, ResourceRule};

    #[test]
    fn review_request_omits_empty_fields() {
        let body = serde_json::to_value(access_review_request(&AccessCheck {
            verb: "get".into(),
            group: String::new(),
            resource: "pods".into(),
            subresource: Some("log".into()),
            namespace: Some(" ".into()),
            name: None,
        }))
        .unwrap();
        assert_eq!(body["apiVersion"], "authorization.k8s.io/v1");
        assert_eq!(body["kind"], "SelfSubjectAccessReview");
        let attrs = &body["spec"]["resourceAttributes"];
        assert_eq!(attrs["verb"], "get");
        assert_eq!(attrs["group"], "");
        assert_eq!(attrs["resource"], "pods");
        assert_eq!(attrs["subresource"], "log");
        assert!(attrs.get("namespace").is_none());
        assert!(attrs.get("name").is_none());
    }

    #[test]
    fn decisions_fall_back_to_the_evaluation_error() {
        let d = decision_from_status(Some(SubjectAccessReviewStatus {
            allowed: false,
            denied: None,
            reason: Some(String::new()),
            evaluation_error: Some("webhook timed out".into()),
        }));
        assert!(!d.allowed && !d.denied);
        assert_eq!(d.reason.as_deref(), Some("webhook timed out"));
        assert!(d.error.is_none());
        let missing = decision_from_status(None);
        assert!(missing.error.is_some());
    }

    #[test]
    fn rules_and_users_map_optional_lists_to_empty() {
        let rules = rules_from_status(SubjectRulesReviewStatus {
            resource_rules: vec![ResourceRule {
                verbs: vec!["get".into()],
                api_groups: None,
                resources: Some(vec!["pods".into()]),
                resource_names: None,
            }],
            non_resource_rules: vec![NonResourceRule {
                verbs: vec!["get".into()],
                non_resource_urls: None,
            }],
            incomplete: false,
            evaluation_error: Some(String::new()),
        });
        assert!(rules.resource_rules[0].api_groups.is_empty());
        assert!(rules.resource_rules[0].resource_names.is_empty());
        assert!(rules.non_resource_rules[0].non_resource_urls.is_empty());
        assert!(rules.evaluation_error.is_none());
        let who = whoami_from_user(UserInfo {
            username: Some("kind-admin".into()),
            uid: Some(String::new()),
            groups: None,
            extra: None,
        });
        assert_eq!(who.username, "kind-admin");
        assert!(who.uid.is_none() && who.groups.is_empty() && who.extra.is_empty());
    }
}
