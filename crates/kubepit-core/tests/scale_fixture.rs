//! Correctness of the scale fixture (`support::scale`): preset counts,
//! determinism, paging, metadata-only lists and selectors. Runs against the
//! in-process fake API server on 127.0.0.1; no real cluster.

mod support;

use std::collections::HashSet;
use std::sync::Arc;

use serde_json::Value;
use support::scale::{preset, ScaleCluster, ScaleServe};
use support::{get_json, start};

#[test]
fn presets_generate_the_declared_counts() {
    let s = ScaleCluster::generate(&preset("s"));
    assert_eq!(s.count("/api/v1/pods"), Some(1_000));
    assert_eq!(s.count("/api/v1/nodes"), Some(50));
    assert_eq!(s.count("/api/v1/services"), Some(250));
    assert_eq!(s.count("/apis/apps/v1/deployments"), Some(250));
    assert_eq!(s.count("/apis/apps/v1/replicasets"), Some(500));
    assert_eq!(
        s.count("/apis/apiextensions.k8s.io/v1/customresourcedefinitions"),
        Some(20)
    );
    assert_eq!(s.custom_resources(), 200);
    let l = ScaleCluster::generate(&preset("l"));
    assert_eq!(l.count("/api/v1/pods"), Some(20_000));
    assert_eq!(l.count("/api/v1/nodes"), Some(1_000));
    assert_eq!(l.count("/api/v1/services"), Some(5_000));
}

#[test]
fn generation_is_deterministic() {
    let a = ScaleCluster::generate(&preset("s"));
    let b = ScaleCluster::generate(&preset("s"));
    assert_eq!(
        serde_json::to_string(a.objects("/api/v1/pods")).unwrap(),
        serde_json::to_string(b.objects("/api/v1/pods")).unwrap()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn paging_returns_every_object_once() {
    let server =
        start(Arc::new(ScaleCluster::generate(&preset("m"))).router(ScaleServe::default())).await;
    let (mut uids, mut token, mut pages) = (HashSet::new(), None::<String>, 0);
    loop {
        let path = match &token {
            Some(t) => format!("/api/v1/pods?limit=500&continue={t}"),
            None => "/api/v1/pods?limit=500".into(),
        };
        let (code, list) = get_json(&server.url, &path, &[]).await;
        assert_eq!(code, 200);
        assert!(list["metadata"]["resourceVersion"].is_string());
        for item in list["items"].as_array().unwrap() {
            assert!(uids.insert(item["metadata"]["uid"].as_str().unwrap().to_string()));
        }
        pages += 1;
        token = list["metadata"]["continue"]
            .as_str()
            .filter(|t| !t.is_empty())
            .map(String::from);
        if token.is_none() {
            break;
        }
    }
    assert_eq!((uids.len(), pages), (10_000, 20));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn paging_edges() {
    let server =
        start(Arc::new(ScaleCluster::generate(&preset("s"))).router(ScaleServe::default())).await;
    let (code, _) = get_json(&server.url, "/api/v1/pods?limit=500&continue=bogus", &[]).await;
    assert_eq!(code, 410);
    let (_, all) = get_json(&server.url, "/api/v1/nodes?limit=5000", &[]).await;
    assert_eq!(all["items"].as_array().unwrap().len(), 50);
    assert!(all["metadata"]
        .get("continue")
        .is_none_or(|c| c.as_str() == Some("")));
    let (_, unpaged) = get_json(&server.url, "/api/v1/pods", &[]).await;
    assert_eq!(unpaged["items"].as_array().unwrap().len(), 1_000);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn metadata_only_lists_and_selectors() {
    let server =
        start(Arc::new(ScaleCluster::generate(&preset("s"))).router(ScaleServe::default())).await;
    let accept = [(
        "Accept",
        "application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1",
    )];
    let (_, meta) = get_json(&server.url, "/api/v1/secrets?limit=10", &accept).await;
    assert_eq!(meta["kind"], "PartialObjectMetadataList");
    assert!(
        meta["items"][0].get("data").is_none() && meta["items"][0]["metadata"]["name"].is_string()
    );
    let (_, one) = get_json(
        &server.url,
        "/api/v1/pods?fieldSelector=spec.nodeName%3Dnode-0007",
        &[],
    )
    .await;
    assert!(one["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|p: &Value| p["spec"]["nodeName"] == "node-0007"));
    assert!(!one["items"].as_array().unwrap().is_empty());
}

/// Field selectors match on any field path (events by `involvedObject.uid`,
/// Helm's Secrets by `type`), like the API server's field labels.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn field_selectors_match_any_path() {
    let cluster = Arc::new(ScaleCluster::generate(&preset("s")));
    let pod_uid = cluster.objects("/api/v1/pods")[0]["metadata"]["uid"]
        .as_str()
        .unwrap()
        .to_string();
    let server = start(cluster.router(ScaleServe::default())).await;
    let path = format!("/api/v1/events?fieldSelector=involvedObject.uid%3D{pod_uid}");
    let (code, events) = get_json(&server.url, &path, &[]).await;
    assert_eq!(code, 200);
    let events = events["items"].as_array().unwrap();
    assert_eq!(events.len(), 2, "s has two events per pod");
    assert!(events
        .iter()
        .all(|e| e["involvedObject"]["uid"] == pod_uid.as_str()));
    let helm = "/api/v1/secrets?fieldSelector=type%3Dhelm.sh%2Frelease.v1";
    let (code, none) = get_json(&server.url, helm, &[]).await;
    assert_eq!(code, 200);
    assert!(none["items"].as_array().unwrap().is_empty());
    let (_, opaque) = get_json(
        &server.url,
        "/api/v1/secrets?fieldSelector=type%3DOpaque",
        &[],
    )
    .await;
    assert_eq!(opaque["items"].as_array().unwrap().len(), 250);
    let (_, running) = get_json(
        &server.url,
        "/api/v1/pods?fieldSelector=status.phase%21%3DRunning",
        &[],
    )
    .await;
    assert!(running["items"].as_array().unwrap().is_empty());
}

/// `scale.test.ts` pins the same names: the demo backend's generator mirrors
/// this one, so backend and UI numbers stay comparable.
#[test]
fn names_match_the_demo_generator() {
    let s = ScaleCluster::generate(&preset("s"));
    let names = |path: &str| -> HashSet<String> {
        s.objects(path)
            .iter()
            .map(|o| {
                let ns = o["metadata"]["namespace"].as_str().unwrap_or_default();
                format!("{ns}/{}", o["metadata"]["name"].as_str().unwrap())
            })
            .collect()
    };
    assert!(names("/api/v1/pods").contains("ns-0001/app-0001-api-kbf2jnh5rf-6gdhk"));
    assert!(names("/apis/apps/v1/replicasets").contains("ns-0001/app-0001-api-bs5r87rj9j"));
    assert!(
        names("/apis/discovery.k8s.io/v1/endpointslices").contains("ns-0001/app-0001-api-29dnx")
    );
    assert!(
        names("/api/v1/events").contains("ns-0001/app-0001-api-kbf2jnh5rf-6gdhk.c9e192c28c8c4cde")
    );
    assert!(names("/apis/scale7.example.com/v1/widgets").contains("ns-0011/widget-0001"));
    let l = ScaleCluster::generate(&preset("l"));
    let last = l.objects("/api/v1/pods").last().unwrap();
    assert_eq!(
        last["metadata"]["name"],
        "app-5000-gateway-pxzk6tb9sn-vjhp5"
    );
    assert_eq!(last["metadata"]["namespace"], "ns-0400");
}
