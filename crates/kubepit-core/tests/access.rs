//! End-to-end tests of the RBAC self-reviews (`access_review`,
//! `access_rules`, `access_whoami`) against the fake API server in
//! `support/`. No real cluster is involved.

mod support;

use std::sync::Arc;

use kubepit_core::access::WHOAMI_UNSUPPORTED;
use kubepit_core::types::AccessCheck;
use serde_json::{json, Value};
use support::{setup, start, status, Log, Reply, Request, Router};

const SSAR: &str = "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews";
const SSRR: &str = "/apis/authorization.k8s.io/v1/selfsubjectrulesreviews";
const SSR_V1: &str = "/apis/authentication.k8s.io/v1/selfsubjectreviews";
const SSR_V1BETA1: &str = "/apis/authentication.k8s.io/v1beta1/selfsubjectreviews";

/// Which SelfSubjectReview versions the fake server serves.
#[derive(Clone, Copy)]
enum WhoAmIApi {
    V1,
    V1beta1,
    None,
}

fn version() -> Reply {
    Reply::Json(
        200,
        json!({"major": "1", "minor": "31", "gitVersion": "v1.31.0",
               "gitCommit": "abc", "gitTreeState": "clean", "buildDate": "2024-01-01T00:00:00Z",
               "goVersion": "go1.22", "compiler": "gc", "platform": "linux/amd64"}),
    )
}

/// Decides a SelfSubjectAccessReview the way the tests expect:
/// `rN` is allowed for even N and explicitly denied for odd N, `broken`
/// fails with HTTP 500, `secrets` has no rule, anything else is allowed.
fn access_review(body: &Value) -> Reply {
    let attrs = &body["spec"]["resourceAttributes"];
    let resource = attrs["resource"].as_str().unwrap_or_default();
    let status = if resource == "broken" {
        return Reply::Json(500, status(500, "InternalError", "etcd is on fire"));
    } else if let Some(n) = resource
        .strip_prefix('r')
        .and_then(|n| n.parse::<u32>().ok())
    {
        if n.is_multiple_of(2) {
            json!({"allowed": true, "reason": format!("rule {n}")})
        } else {
            json!({"allowed": false, "denied": true, "reason": format!("denied {n}")})
        }
    } else if resource == "secrets" {
        json!({"allowed": false})
    } else {
        json!({"allowed": true, "reason": "RBAC: allowed by ClusterRoleBinding \"admin\""})
    };
    Reply::Json(
        201,
        json!({"apiVersion": "authorization.k8s.io/v1", "kind": "SelfSubjectAccessReview",
               "metadata": {"creationTimestamp": null}, "spec": body["spec"], "status": status}),
    )
}

fn rules_review(body: &Value) -> Reply {
    Reply::Json(
        201,
        json!({"apiVersion": "authorization.k8s.io/v1", "kind": "SelfSubjectRulesReview",
        "metadata": {"creationTimestamp": null}, "spec": body["spec"],
        "status": {
            "resourceRules": [
                {"verbs": ["get", "list", "watch"], "apiGroups": [""], "resources": ["pods", "pods/log"]},
                {"verbs": ["patch"], "apiGroups": ["apps"], "resources": ["deployments"],
                 "resourceNames": ["web"]},
                {"verbs": ["create"], "apiGroups": ["authorization.k8s.io"],
                 "resources": ["selfsubjectaccessreviews"]}
            ],
            "nonResourceRules": [{"verbs": ["get"], "nonResourceURLs": ["/healthz", "/version"]}],
            "incomplete": true,
            "evaluationError": "webhook authorizer does not support user rule resolution"
        }}),
    )
}

fn user_info() -> Value {
    json!({"username": "jane@acme.io", "uid": "u-123", "groups": ["devs", "system:authenticated"],
           "extra": {"scopes": ["openid", "email"]}})
}

fn router(whoami: WhoAmIApi) -> Router {
    Arc::new(move |req: &Request, _log: &Log| {
        let path = req.path.split('?').next().unwrap_or_default();
        let body: Value = serde_json::from_str(&req.body).unwrap_or(Value::Null);
        match (req.method.as_str(), path) {
            ("GET", "/version") => version(),
            ("GET", "/apis") => Reply::Json(
                200,
                json!({"kind": "APIGroupList", "apiVersion": "v1", "groups": []}),
            ),
            ("POST", SSAR) => access_review(&body),
            ("POST", SSRR) => rules_review(&body),
            ("POST", SSR_V1) if matches!(whoami, WhoAmIApi::V1) => Reply::Json(
                201,
                json!({"apiVersion": "authentication.k8s.io/v1", "kind": "SelfSubjectReview",
                       "metadata": {"creationTimestamp": null}, "status": {"userInfo": user_info()}}),
            ),
            ("POST", SSR_V1BETA1) if matches!(whoami, WhoAmIApi::V1beta1) => Reply::Json(
                201,
                json!({"apiVersion": "authentication.k8s.io/v1beta1", "kind": "SelfSubjectReview",
                       "metadata": {"creationTimestamp": null}, "status": {"userInfo": user_info()}}),
            ),
            _ => Reply::Json(
                404,
                status(
                    404,
                    "NotFound",
                    "the server could not find the requested resource",
                ),
            ),
        }
    })
}

fn check(verb: &str, resource: &str) -> AccessCheck {
    AccessCheck {
        verb: verb.into(),
        group: String::new(),
        resource: resource.into(),
        ..AccessCheck::default()
    }
}

fn posts(log: &Log, path: &str) -> Vec<Value> {
    log.lock()
        .iter()
        .filter(|r| r.method == "POST" && r.path.split('?').next() == Some(path))
        .map(|r| serde_json::from_str(&r.body).unwrap())
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn access_review_keeps_order_and_isolates_failures() {
    let server = start(router(WhoAmIApi::V1)).await;
    // Reviews are read-only, so they must work on read-only clusters too.
    let (_dir, app, _recorder, id) = setup(&server.url, true);

    // More checks than the concurrency bound, answered out of order by the
    // server's concurrent handlers, must come back in request order.
    let mut checks: Vec<AccessCheck> = (0..40).map(|n| check("get", &format!("r{n}"))).collect();
    checks.insert(7, check("list", "broken"));
    checks.insert(
        3,
        AccessCheck {
            verb: "get".into(),
            group: String::new(),
            resource: "pods".into(),
            subresource: Some("log".into()),
            namespace: Some("team-a".into()),
            name: Some("web-0".into()),
        },
    );
    checks.push(check("list", "secrets"));
    checks.push(check("", "pods"));

    let decisions = app.access_review(&id, checks.clone()).await.unwrap();
    assert_eq!(decisions.len(), checks.len());
    for (check, decision) in checks.iter().zip(&decisions) {
        match check.resource.as_str() {
            "broken" => {
                assert!(!decision.allowed && !decision.denied, "{decision:?}");
                assert!(
                    decision
                        .error
                        .as_deref()
                        .unwrap()
                        .contains("etcd is on fire"),
                    "{decision:?}"
                );
            }
            "secrets" => {
                assert!(!decision.allowed && !decision.denied && decision.error.is_none());
                assert!(decision.reason.is_none());
            }
            "pods" if check.verb.is_empty() => {
                assert!(decision.error.as_deref().unwrap().contains("needs a verb"));
            }
            "pods" => {
                assert!(decision.allowed);
                assert!(decision
                    .reason
                    .as_deref()
                    .unwrap()
                    .contains("ClusterRoleBinding"));
            }
            r => {
                let n: u32 = r[1..].parse().unwrap();
                assert_eq!(decision.allowed, n.is_multiple_of(2), "{r}: {decision:?}");
                assert_eq!(decision.denied, !n.is_multiple_of(2), "{r}: {decision:?}");
                let expected = if n.is_multiple_of(2) {
                    format!("rule {n}")
                } else {
                    format!("denied {n}")
                };
                assert_eq!(decision.reason.as_deref(), Some(expected.as_str()));
                assert!(decision.error.is_none());
            }
        }
    }

    // One POST per valid check (the verb-less one never leaves the process),
    // with empty optional attributes omitted.
    let bodies = posts(&server.log, SSAR);
    assert_eq!(bodies.len(), checks.len() - 1);
    assert!(bodies
        .iter()
        .all(|b| b["kind"] == "SelfSubjectAccessReview"
            && b["apiVersion"] == "authorization.k8s.io/v1"));
    let log_check = bodies
        .iter()
        .map(|b| &b["spec"]["resourceAttributes"])
        .find(|a| a["resource"] == "pods")
        .unwrap();
    assert_eq!(
        log_check,
        &json!({"verb": "get", "group": "", "resource": "pods", "subresource": "log",
                "namespace": "team-a", "name": "web-0"})
    );
    let cluster_wide = bodies
        .iter()
        .map(|b| &b["spec"]["resourceAttributes"])
        .find(|a| a["resource"] == "secrets")
        .unwrap();
    assert!(cluster_wide.get("namespace").is_none());
    assert!(cluster_wide.get("subresource").is_none());

    // An empty batch sends nothing.
    let before = server.log.lock().len();
    assert!(app.access_review(&id, Vec::new()).await.unwrap().is_empty());
    assert_eq!(server.log.lock().len(), before);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn access_rules_posts_a_rules_review_for_the_namespace() {
    let server = start(router(WhoAmIApi::V1)).await;
    let (_dir, app, _recorder, id) = setup(&server.url, true);

    let rules = app.access_rules(&id, "team-a").await.unwrap();
    let bodies = posts(&server.log, SSRR);
    assert_eq!(bodies.len(), 1);
    assert_eq!(bodies[0]["kind"], "SelfSubjectRulesReview");
    assert_eq!(bodies[0]["spec"], json!({"namespace": "team-a"}));

    assert_eq!(rules.resource_rules.len(), 3);
    assert_eq!(rules.resource_rules[0].resources, vec!["pods", "pods/log"]);
    assert!(rules.resource_rules[0].resource_names.is_empty());
    assert_eq!(rules.resource_rules[1].resource_names, vec!["web"]);
    assert_eq!(rules.resource_rules[1].api_groups, vec!["apps"]);
    assert_eq!(
        rules.non_resource_rules[0].non_resource_urls,
        vec!["/healthz", "/version"]
    );
    assert!(rules.incomplete);
    assert!(rules
        .evaluation_error
        .as_deref()
        .unwrap()
        .contains("webhook"));

    let err = app.access_rules(&id, "  ").await.unwrap_err();
    assert!(err.to_string().contains("namespace is required"), "{err}");
    assert_eq!(posts(&server.log, SSRR).len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn whoami_uses_v1_then_falls_back_to_v1beta1() {
    for (api, expected_posts) in [
        (WhoAmIApi::V1, vec![SSR_V1]),
        (WhoAmIApi::V1beta1, vec![SSR_V1, SSR_V1BETA1]),
    ] {
        let server = start(router(api)).await;
        let (_dir, app, _recorder, id) = setup(&server.url, false);
        let who = app.access_whoami(&id).await.unwrap();
        assert_eq!(who.username, "jane@acme.io");
        assert_eq!(who.uid.as_deref(), Some("u-123"));
        assert_eq!(who.groups, vec!["devs", "system:authenticated"]);
        assert_eq!(who.extra["scopes"], vec!["openid", "email"]);

        let sent: Vec<String> = server
            .log
            .lock()
            .iter()
            .filter(|r| r.method == "POST")
            .map(|r| r.path.split('?').next().unwrap().to_string())
            .collect();
        assert_eq!(sent, expected_posts);
        let body: Value = serde_json::from_str(
            &server
                .log
                .lock()
                .iter()
                .rfind(|r| r.method == "POST")
                .unwrap()
                .body,
        )
        .unwrap();
        assert_eq!(body["kind"], "SelfSubjectReview");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn whoami_reports_unsupported_clusters_clearly() {
    let server = start(router(WhoAmIApi::None)).await;
    let (_dir, app, _recorder, id) = setup(&server.url, false);
    let err = app.access_whoami(&id).await.unwrap_err();
    assert_eq!(err.to_string(), WHOAMI_UNSUPPORTED);
    assert!(err.to_string().contains("not supported by this cluster"));
}
