//! Connectivity end to end against the fake API server in `support/`:
//! proxies, saved port forwards that start on connect, and kubeconfig file
//! watching. Everything lives in temp dirs; no real cluster, `~/.kube` or
//! OS credential store is touched.

mod support;

use std::sync::Arc;
use std::time::{Duration, Instant};

use kubepit_core::kubeconfig_watch::DiscoveryRoots;
use kubepit_core::types::{
    ClusterDef, ClusterInput, ClusterStatus, ConnState, KubeconfigChanged, PortForward,
    PortForwardKind, PortForwardState, SavedPortForwardInput,
};
use kubepit_core::{EventSink, Kubepit, Paths};
use parking_lot::Mutex;
use serde_json::json;
use support::{kubeconfig_for, start, Log, Reply, Request, Router};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

#[derive(Default)]
struct Events {
    changes: Mutex<Vec<KubeconfigChanged>>,
    forwards: Mutex<Vec<Vec<PortForward>>>,
}

impl EventSink for Events {
    fn cluster_status(&self, _status: &ClusterStatus) {}
    fn cluster_list(&self, _clusters: &[ClusterDef]) {}
    fn port_forwards(&self, forwards: &[PortForward]) {
        self.forwards.lock().push(forwards.to_vec());
    }
    fn kubeconfig_changed(&self, change: &KubeconfigChanged) {
        self.changes.lock().push(change.clone());
    }
}

fn router() -> Router {
    Arc::new(|req: &Request, _log: &Log| {
        let path = req.path.split('?').next().unwrap_or_default();
        match (req.method.as_str(), path) {
            ("GET", "/version") => Reply::Json(
                200,
                json!({"major": "1", "minor": "31", "gitVersion": "v1.31.0",
                       "gitCommit": "abc", "gitTreeState": "clean", "buildDate": "2024-01-01T00:00:00Z",
                       "goVersion": "go1.22", "compiler": "gc", "platform": "linux/amd64"}),
            ),
            ("GET", "/apis") => Reply::Json(
                200,
                json!({"kind": "APIGroupList", "apiVersion": "v1", "groups": []}),
            ),
            ("GET", "/api/v1/namespaces/default/pods/web") => Reply::Json(
                200,
                json!({"apiVersion": "v1", "kind": "Pod",
                       "metadata": {"name": "web", "namespace": "default", "uid": "u1"},
                       "status": {"phase": "Running"}}),
            ),
            _ => Reply::Json(
                404,
                support::status(
                    404,
                    "NotFound",
                    "the server could not find the requested resource",
                ),
            ),
        }
    })
}

fn open(dir: &tempfile::TempDir) -> (Arc<Kubepit>, Arc<Events>) {
    let events = Arc::new(Events::default());
    let app = Kubepit::open(Paths::new(dir.path().join("kubepit")), events.clone()).unwrap();
    (Arc::new(app), events)
}

fn add_file_cluster(app: &Kubepit, path: &std::path::Path) -> ClusterDef {
    app.cluster_add(vec![ClusterInput {
        context: "fake".into(),
        kubeconfig_path: Some(path.to_string_lossy().to_string()),
        ..Default::default()
    }])
    .unwrap()
    .remove(0)
}

async fn wait_for<T>(what: &str, mut probe: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(value) = probe() {
            return value;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// A minimal HTTP CONNECT proxy that records the targets it tunnelled to.
async fn connect_proxy() -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let seen: Arc<Mutex<Vec<String>>> = Arc::default();
    let log = seen.clone();
    tokio::spawn(async move {
        while let Ok((mut client, _)) = listener.accept().await {
            let log = log.clone();
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 1024];
                let end = loop {
                    let n = client.read(&mut chunk).await.ok()?;
                    if n == 0 {
                        return None;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        break pos + 4;
                    }
                };
                let head = String::from_utf8_lossy(&buf[..end]).to_string();
                let line = head.lines().next().unwrap_or_default().to_string();
                let target = line.split_whitespace().nth(1)?.to_string();
                log.lock().push(line);
                let mut upstream = TcpStream::connect(target).await.ok()?;
                client
                    .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                    .await
                    .ok()?;
                upstream.write_all(&buf[end..]).await.ok()?;
                tokio::io::copy_bidirectional(&mut client, &mut upstream)
                    .await
                    .ok()
            });
        }
    });
    (url, seen)
}

#[tokio::test]
async fn cluster_proxy_override_and_kubeconfig_proxy_url_are_used() {
    let server = start(router()).await;
    let (proxy, seen) = connect_proxy().await;
    let dir = tempfile::tempdir().unwrap();
    let (app, _) = open(&dir);
    let host = server.url.trim_start_matches("http://").to_string();

    // Override in the cluster definition.
    let config = dir.path().join("config");
    std::fs::write(&config, kubeconfig_for(&server.url)).unwrap();
    let mut cluster = add_file_cluster(&app, &config);
    cluster.proxy_url = Some(proxy.clone());
    let cluster = app.cluster_update(cluster).unwrap();
    let status = app.cluster_connect(&cluster.id).await.unwrap();
    assert_eq!(status.state, ConnState::Connected, "{:?}", status.error);
    assert!(
        seen.lock()
            .iter()
            .any(|l| l == &format!("CONNECT {host} HTTP/1.1")),
        "{:?}",
        seen.lock()
    );
    // External tools get the same proxy.
    let run = app.paths().run_kubeconfig(&cluster.id).unwrap();
    assert!(std::fs::read_to_string(run)
        .unwrap()
        .contains(&format!("proxy-url: {proxy}")));
    let info = app.cluster_proxy_info(&cluster.id).unwrap();
    assert_eq!(info.url.as_deref(), Some(proxy.as_str()));

    // `proxy-url` in the user's kubeconfig, no override.
    seen.lock().clear();
    let with_proxy = kubeconfig_for(&server.url).replace(
        &format!("    server: {}\n", server.url),
        &format!("    server: {}\n    proxy-url: {proxy}\n", server.url),
    );
    let config2 = dir.path().join("config2");
    std::fs::write(&config2, with_proxy).unwrap();
    let second = add_file_cluster(&app, &config2);
    let status = app.cluster_connect(&second.id).await.unwrap();
    assert_eq!(status.state, ConnState::Connected, "{:?}", status.error);
    assert!(!seen.lock().is_empty());
    assert_eq!(
        app.cluster_proxy_info(&second.id).unwrap().source,
        Some(kubepit_core::types::ProxySource::Kubeconfig)
    );
}

#[tokio::test]
async fn saved_forwards_start_on_connect_and_fail_visibly() {
    let server = start(router()).await;
    let dir = tempfile::tempdir().unwrap();
    let (app, _) = open(&dir);
    let config = dir.path().join("config");
    std::fs::write(&config, kubeconfig_for(&server.url)).unwrap();
    let cluster = add_file_cluster(&app, &config);

    let busy = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let busy_port = busy.local_addr().unwrap().port();
    let saved = |remote_port, local_port, start_on_connect| SavedPortForwardInput {
        cluster_id: cluster.id.clone(),
        namespace: "default".into(),
        kind: PortForwardKind::Pod,
        name: "web".into(),
        remote_port,
        local_port,
        label: Some("Web".into()),
        start_on_connect,
    };
    let ok = app.port_forward_save(saved(8080, None, true)).unwrap();
    let blocked = app
        .port_forward_save(saved(9090, Some(busy_port), true))
        .unwrap();
    let manual = app.port_forward_save(saved(7070, None, false)).unwrap();

    let status = app.cluster_connect(&cluster.id).await.unwrap();
    assert_eq!(status.state, ConnState::Connected);
    let forwards = wait_for("auto-started forwards", || {
        let list = app.port_forward_list();
        (list.len() == 2).then_some(list)
    })
    .await;
    let running = forwards
        .iter()
        .find(|f| f.saved_id.as_deref() == Some(&ok.id))
        .unwrap();
    assert_eq!(running.state, PortForwardState::Active);
    assert!(TcpStream::connect(("127.0.0.1", running.local_port))
        .await
        .is_ok());
    let failed = forwards
        .iter()
        .find(|f| f.saved_id.as_deref() == Some(&blocked.id))
        .unwrap();
    assert_eq!(failed.state, PortForwardState::Error);
    let error = failed.error.clone().unwrap();
    assert!(error.contains("already in use"), "{error}");

    // Once the port is free, a restart brings it up on the same port.
    drop(busy);
    let restarted = app.port_forward_restart(&failed.id).await.unwrap();
    assert_eq!(restarted.id, failed.id);
    assert_eq!(restarted.local_port, busy_port);
    assert_eq!(restarted.state, PortForwardState::Active);

    // A saved forward without start_on_connect starts on demand, once.
    let started = app.port_forward_saved_start(&manual.id).await.unwrap();
    let again = app.port_forward_saved_start(&manual.id).await.unwrap();
    assert_eq!(started.id, again.id);
    assert_eq!(app.port_forward_list().len(), 3);

    // Disconnecting stops them; the definitions stay.
    app.cluster_disconnect(&cluster.id);
    assert!(app.port_forward_list().is_empty());
    assert_eq!(app.port_forward_saved_list().len(), 3);

    // Unsaving a running forward keeps it running, unlinked.
    let status = app.cluster_connect(&cluster.id).await.unwrap();
    assert_eq!(status.state, ConnState::Connected);
    let live = wait_for("forwards after reconnect", || {
        let list = app.port_forward_list();
        (list.len() == 2).then_some(list)
    })
    .await;
    app.port_forward_unsave(&ok.id).unwrap();
    let list = app.port_forward_list();
    assert_eq!(list.len(), live.len());
    assert!(list.iter().all(|f| f.saved_id.as_deref() != Some(&ok.id)));
}

#[tokio::test]
async fn watching_reports_new_contexts_and_rotated_credentials() {
    let server = start(router()).await;
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let kube = home.join(".kube");
    std::fs::create_dir_all(&kube).unwrap();
    let config = kube.join("config");
    std::fs::write(&config, kubeconfig_for(&server.url)).unwrap();

    let (app, events) = open(&dir);
    let cluster = add_file_cluster(&app, &config);
    let status = app.cluster_connect(&cluster.id).await.unwrap();
    assert_eq!(status.state, ConnState::Connected);
    let roots_home = home.clone();
    app.start_kubeconfig_watch_with(move || DiscoveryRoots {
        home: Some(roots_home),
        kubeconfig_env: None,
    });
    tokio::time::sleep(Duration::from_millis(800)).await;

    // A new kubeconfig with an unregistered context appears in ~/.kube.
    let extra = kubeconfig_for("https://staging.example.test:6443")
        .replace("name: fake", "name: staging")
        .replace("cluster: fake", "cluster: staging")
        .replace("current-context: fake", "current-context: staging");
    std::fs::write(kube.join("staging.yaml"), extra).unwrap();
    let change = wait_for("the new context", || {
        events
            .changes
            .lock()
            .iter()
            .find(|c| !c.new_contexts.is_empty())
            .cloned()
    })
    .await;
    assert_eq!(change.new_contexts.len(), 1);
    assert_eq!(change.new_contexts[0].context, "staging");
    assert!(change.new_contexts[0].path.ends_with("staging.yaml"));
    assert_eq!(
        change.new_contexts[0].server.as_deref(),
        Some("https://staging.example.test:6443")
    );

    // The token of the registered cluster rotates.
    std::fs::write(
        &config,
        kubeconfig_for(&server.url).replace("test-token", "rotated-token"),
    )
    .unwrap();
    let change = wait_for("the reconnect hint", || {
        events
            .changes
            .lock()
            .iter()
            .find(|c| !c.reconnect.is_empty())
            .cloned()
    })
    .await;
    assert_eq!(change.reconnect, vec![cluster.id.clone()]);
    assert!(change.new_contexts.is_empty());
    let run = app.paths().run_kubeconfig(&cluster.id).unwrap();
    assert!(std::fs::read_to_string(run)
        .unwrap()
        .contains("rotated-token"));
    // The user's file is only read.
    assert!(std::fs::read_to_string(&config)
        .unwrap()
        .contains("rotated-token"));

    app.stop_kubeconfig_watch();
}
