//! Shared harness for the end-to-end tests: a tiny in-process fake API
//! server on 127.0.0.1 (plain HTTP) plus a `Kubepit` wired to it. No real
//! cluster is involved: every kubeconfig is generated here and points at the
//! fake server, and `KUBEPIT_HOME` is never read (paths are explicit).
//!
//! Use from a test file with `mod support;` and route requests with a
//! [`Router`] closure.
#![allow(dead_code)]

pub mod scale;
pub mod stats;

use std::sync::Arc;
use std::time::Duration;

use kubepit_core::types::{ClusterInput, ClusterStatus, PortForward, Settings};
use kubepit_core::{EventSink, Kubepit, Paths};
use parking_lot::Mutex;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

#[derive(Debug, Clone)]
pub struct Request {
    pub method: String,
    /// Path and query, as sent.
    pub path: String,
    pub body: String,
    /// Every header of the request head: lowercase names, trimmed values.
    pub headers: Vec<(String, String)>,
}

impl Request {
    /// The value of header `name` (case-insensitive).
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    /// The path without the query.
    pub fn path_only(&self) -> &str {
        self.path.split_once('?').map_or(&self.path, |(p, _)| p)
    }
}

pub enum Reply {
    Json(u16, Value),
    /// Raw `text/plain` body (pod logs).
    Text(String),
    /// Newline-delimited watch events, then the stream is held open.
    Stream(Vec<Value>),
    /// JSON with extra response headers (e.g. `Warning` from admission).
    JsonWithHeaders(u16, Value, Vec<(String, String)>),
}

pub type Router = Arc<dyn Fn(&Request, &Log) -> Reply + Send + Sync>;
pub type Log = Arc<Mutex<Vec<Request>>>;

pub struct FakeServer {
    pub url: String,
    pub log: Log,
}

pub async fn start(router: Router) -> FakeServer {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let log: Log = Arc::default();
    let server_log = log.clone();
    tokio::spawn(async move {
        loop {
            let Ok((socket, _)) = listener.accept().await else {
                return;
            };
            let router = router.clone();
            let log = server_log.clone();
            tokio::spawn(async move {
                let _ = handle(socket, router, log).await;
            });
        }
    });
    FakeServer { url, log }
}

async fn handle(mut socket: TcpStream, router: Router, log: Log) -> std::io::Result<()> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        let n = socket.read(&mut chunk).await?;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos + 4;
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let mut lines = head.lines();
    let mut request_line = lines.next().unwrap_or_default().split_whitespace();
    let method = request_line.next().unwrap_or_default().to_string();
    let path = request_line.next().unwrap_or_default().to_string();
    let headers: Vec<(String, String)> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
        .collect();
    let content_length = headers
        .iter()
        .find(|(k, _)| k == "content-length")
        .and_then(|(_, v)| v.parse::<usize>().ok())
        .unwrap_or(0);
    let mut body = buf[head_end..].to_vec();
    while body.len() < content_length {
        let n = socket.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    let request = Request {
        method,
        path,
        body: String::from_utf8_lossy(&body).to_string(),
        headers,
    };
    let reply = router(&request, &log);
    log.lock().push(request);
    match reply {
        Reply::Json(code, value) => {
            let text = value.to_string();
            let reason = match code {
                200 | 201 => "OK",
                403 => "Forbidden",
                404 => "Not Found",
                _ => "Error",
            };
            let response = format!(
                "HTTP/1.1 {code} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",
                text.len()
            );
            socket.write_all(response.as_bytes()).await?;
        }
        Reply::JsonWithHeaders(code, value, headers) => {
            write_json(&mut socket, code, &value, &headers).await?;
        }
        Reply::Text(text) => {
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",
                text.len()
            );
            socket.write_all(response.as_bytes()).await?;
        }
        Reply::Stream(events) => {
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
                )
                .await?;
            for event in events {
                let line = format!("{event}\n");
                socket
                    .write_all(format!("{:x}\r\n{line}\r\n", line.len()).as_bytes())
                    .await?;
            }
            socket.flush().await?;
            tokio::time::sleep(Duration::from_secs(30)).await;
        }
    }
    Ok(())
}

async fn write_json(
    socket: &mut TcpStream,
    code: u16,
    value: &Value,
    headers: &[(String, String)],
) -> std::io::Result<()> {
    let text = value.to_string();
    let reason = match code {
        200 | 201 => "OK",
        403 => "Forbidden",
        404 => "Not Found",
        _ => "Error",
    };
    let extra: String = headers
        .iter()
        .map(|(name, value)| format!("{name}: {value}\r\n"))
        .collect();
    let response = format!(
        "HTTP/1.1 {code} {reason}\r\nContent-Type: application/json\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{text}",
        text.len()
    );
    socket.write_all(response.as_bytes()).await
}

/// A raw HTTP/1.1 GET of `path` on the fake server at `base`, read to EOF
/// (every non-stream reply is `Connection: close`): the status code and the
/// JSON body (`Null` when the body is not JSON).
pub async fn get_json(base: &str, path: &str, headers: &[(&str, &str)]) -> (u16, Value) {
    let host = base.trim_start_matches("http://").trim_end_matches('/');
    let mut socket = TcpStream::connect(host).await.unwrap();
    let extra: String = headers
        .iter()
        .map(|(name, value)| format!("{name}: {value}\r\n"))
        .collect();
    let request =
        format!("GET {path} HTTP/1.1\r\nHost: {host}\r\n{extra}Connection: close\r\n\r\n");
    socket.write_all(request.as_bytes()).await.unwrap();
    let mut raw = Vec::new();
    socket.read_to_end(&mut raw).await.unwrap();
    let head_end = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map_or(raw.len(), |pos| pos + 4);
    let code = String::from_utf8_lossy(&raw[..head_end])
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .unwrap_or(0);
    let body = serde_json::from_slice(&raw[head_end..]).unwrap_or(Value::Null);
    (code, body)
}

pub fn status(code: u16, reason: &str, message: &str) -> Value {
    json!({"kind": "Status", "apiVersion": "v1", "metadata": {}, "status": "Failure",
           "message": message, "reason": reason, "code": code})
}

/// The API server's 403 for a service-proxy `path`
/// (`/api/v1/namespaces/{ns}/services/{scheme}:{name}:{port}/proxy…`): the
/// user may not `get` `services/proxy` in that namespace.
pub fn proxy_forbidden(path: &str) -> Reply {
    let segment = |key: &str| {
        path.split(key)
            .nth(1)
            .and_then(|rest| rest.split('/').next())
            .unwrap_or_default()
            .to_string()
    };
    let (namespace, service) = (segment("/namespaces/"), segment("/services/"));
    Reply::Json(
        403,
        status(
            403,
            "Forbidden",
            &format!(
                "services \"{service}\" is forbidden: User \"dev\" cannot get resource \
                 \"services/proxy\" in API group \"\" in the namespace \"{namespace}\""
            ),
        ),
    )
}

#[derive(Default)]
pub struct Recorder {
    pub statuses: Mutex<Vec<ClusterStatus>>,
}

impl EventSink for Recorder {
    fn cluster_status(&self, status: &ClusterStatus) {
        self.statuses.lock().push(status.clone());
    }
    fn cluster_list(&self, _clusters: &[kubepit_core::types::ClusterDef]) {}
    fn port_forwards(&self, _forwards: &[PortForward]) {}
}

pub fn kubeconfig_for(server: &str) -> String {
    format!(
        r#"apiVersion: v1
kind: Config
current-context: fake
clusters:
- name: fake
  cluster:
    server: {server}
users:
- name: dev
  user:
    token: test-token
contexts:
- name: fake
  context:
    cluster: fake
    user: dev
"#
    )
}

pub fn setup(
    server: &str,
    read_only: bool,
) -> (tempfile::TempDir, Arc<Kubepit>, Arc<Recorder>, String) {
    let dir = tempfile::tempdir().unwrap();
    let recorder = Arc::new(Recorder::default());
    let app =
        Arc::new(Kubepit::open(Paths::new(dir.path().join("home")), recorder.clone()).unwrap());
    // The change journal watches cluster-wide in the background; it stays
    // off unless a test turns it on, so request logs remain deterministic.
    app.set_settings(Settings {
        change_journal: false,
        ..app.settings()
    })
    .unwrap();
    let cluster = app
        .cluster_add(vec![ClusterInput {
            name: "Fake".into(),
            context: "fake".into(),
            kubeconfig_text: Some(kubeconfig_for(server)),
            accessible_namespaces: vec!["team-a".into(), "team-b".into()],
            read_only,
            ..Default::default()
        }])
        .unwrap()
        .remove(0);
    (dir, app, recorder, cluster.id)
}
