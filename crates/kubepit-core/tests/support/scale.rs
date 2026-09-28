//! Scale fixture: a deterministic synthetic cluster generated from a preset
//! in `perf/scale-presets.json` (shared with the demo backend's
//! `lib/ipc/mock/fixtures/scale.ts`, which mirrors the names and shapes),
//! served through the fake API server.
//!
//! The router answers discovery, paged lists (`limit` / `continue`, `410
//! Expired` for an unknown token), namespaced list variants, metadata-only
//! lists (`Accept: …;as=PartialObjectMetadataList`), `fieldSelector` on any
//! field path and `labelSelector` (`=`, `==` and `!=` terms; other
//! expressions answer 400), and quiet watches or a burst of MODIFIED pod
//! events. Kinds nothing generates (StatefulSets, Jobs, RBAC, networking…)
//! answer empty lists, so the alert and change-journal watchers sync.
//!
//! Nothing is committed as data: every object is generated from the preset.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Arc;

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};

use super::{status, Log, Reply, Request, Router};

/// One preset of `perf/scale-presets.json`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScalePreset {
    pub namespaces: usize,
    pub nodes: usize,
    /// May be fractional: the remainder goes to the first namespaces.
    pub deployments_per_namespace: f64,
    pub replicas: usize,
    pub old_replica_sets: usize,
    pub config_maps_per_deployment: usize,
    pub secrets_per_deployment: usize,
    pub services_per_deployment: usize,
    pub crds: usize,
    pub crs_per_crd: usize,
    pub events: usize,
    pub seed: u32,
}

/// The preset `name` (`s`, `m` or `l`).
pub fn preset(name: &str) -> ScalePreset {
    let all: HashMap<String, ScalePreset> =
        serde_json::from_str(include_str!("../../../../perf/scale-presets.json"))
            .expect("perf/scale-presets.json parses");
    all.get(name)
        .cloned()
        .unwrap_or_else(|| panic!("unknown scale preset {name:?}"))
}

/// What watches answer.
#[derive(Debug, Clone, Copy, Default)]
pub enum ScaleWatch {
    /// No events; the stream is held open.
    #[default]
    Quiet,
    /// MODIFIED events for the first `n` pods of the watched scope (each
    /// with a newer resourceVersion), once: a re-watch from the last event's
    /// resourceVersion gets none.
    PodBurst(usize),
}

#[derive(Debug, Clone, Default)]
pub struct ScaleServe {
    pub watch: ScaleWatch,
}

/// Every kind the fixture serves: (group, version, kind, plural, namespaced).
/// The generated CRDs' `Widget` kinds are added per cluster.
const KINDS: &[(&str, &str, &str, &str, bool)] = &[
    ("", "v1", "Pod", "pods", true),
    ("", "v1", "Node", "nodes", false),
    ("", "v1", "Service", "services", true),
    ("", "v1", "ConfigMap", "configmaps", true),
    ("", "v1", "Secret", "secrets", true),
    ("", "v1", "Event", "events", true),
    ("", "v1", "Namespace", "namespaces", false),
    ("", "v1", "ServiceAccount", "serviceaccounts", true),
    ("apps", "v1", "Deployment", "deployments", true),
    ("apps", "v1", "ReplicaSet", "replicasets", true),
    ("apps", "v1", "StatefulSet", "statefulsets", true),
    ("apps", "v1", "DaemonSet", "daemonsets", true),
    ("batch", "v1", "Job", "jobs", true),
    ("batch", "v1", "CronJob", "cronjobs", true),
    (
        "discovery.k8s.io",
        "v1",
        "EndpointSlice",
        "endpointslices",
        true,
    ),
    (
        "apiextensions.k8s.io",
        "v1",
        "CustomResourceDefinition",
        "customresourcedefinitions",
        false,
    ),
    ("networking.k8s.io", "v1", "Ingress", "ingresses", true),
    (
        "networking.k8s.io",
        "v1",
        "NetworkPolicy",
        "networkpolicies",
        true,
    ),
    ("rbac.authorization.k8s.io", "v1", "Role", "roles", true),
    (
        "rbac.authorization.k8s.io",
        "v1",
        "RoleBinding",
        "rolebindings",
        true,
    ),
    (
        "rbac.authorization.k8s.io",
        "v1",
        "ClusterRole",
        "clusterroles",
        false,
    ),
    (
        "rbac.authorization.k8s.io",
        "v1",
        "ClusterRoleBinding",
        "clusterrolebindings",
        false,
    ),
    (
        "autoscaling",
        "v2",
        "HorizontalPodAutoscaler",
        "horizontalpodautoscalers",
        true,
    ),
    (
        "policy",
        "v1",
        "PodDisruptionBudget",
        "poddisruptionbudgets",
        true,
    ),
    ("metrics.k8s.io", "v1beta1", "NodeMetrics", "nodes", false),
    ("metrics.k8s.io", "v1beta1", "PodMetrics", "pods", true),
];

// Shared with `scale.ts`: names, labels and timestamps must stay identical.
const TEAMS: [&str; 8] = [
    "payments", "search", "identity", "catalog", "growth", "pricing", "shipping", "platform",
];
const ROLES: [&str; 5] = ["api", "web", "worker", "cache", "gateway"];
const ZONES: [&str; 3] = ["zone-a", "zone-b", "zone-c"];
const ALPHABET: &[u8] = b"bcdfghjklmnpqrstvwxz2456789";
const CLUSTER_BORN: &str = "2026-06-01T00:00:00Z";
const APP_BORN: &str = "2026-08-01T00:00:00Z";
const ROLLOUT: &str = "2026-08-30T00:00:00Z";
const METRICS_AT: &str = "2026-09-01T00:00:00Z";
const EVENT_REASONS: [(&str, &str); 4] = [
    ("Scheduled", "Successfully assigned {ns}/{pod} to {node}"),
    (
        "Pulled",
        "Container image \"{image}\" already present on machine",
    ),
    ("Created", "Created container {container}"),
    ("Started", "Started container {container}"),
];

// uid tags per kind (second uuid group).
const TAG_NAMESPACE: u32 = 0x1;
const TAG_NODE: u32 = 0x2;
const TAG_SERVICE_ACCOUNT: u32 = 0x3;
const TAG_DEPLOYMENT: u32 = 0x4;
const TAG_REPLICA_SET: u32 = 0x5;
const TAG_POD: u32 = 0x6;
const TAG_SERVICE: u32 = 0x7;
const TAG_ENDPOINT_SLICE: u32 = 0x8;
const TAG_CONFIG_MAP: u32 = 0x9;
const TAG_SECRET: u32 = 0xa;
const TAG_CRD: u32 = 0xb;
const TAG_CUSTOM_RESOURCE: u32 = 0xc;
const TAG_EVENT: u32 = 0xd;

/// Seeded xorshift32, one stream per generated object (seed, tag, index), so
/// the TS mirror reproduces every name without replaying a global stream.
struct Rng(u32);

impl Rng {
    fn for_object(seed: u32, tag: u32, index: usize) -> Self {
        let mut h = seed ^ tag.wrapping_mul(0x9E37_79B1) ^ (index as u32).wrapping_mul(0x85EB_CA77);
        h ^= h >> 16;
        h = h.wrapping_mul(0x85EB_CA6B);
        h ^= h >> 13;
        h = h.wrapping_mul(0xC2B2_AE35);
        h ^= h >> 16;
        Rng(if h == 0 { 0x6D2B_79F5 } else { h })
    }

    fn next(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        x
    }

    fn name(&mut self, len: usize) -> String {
        (0..len)
            .map(|_| ALPHABET[(self.next() % ALPHABET.len() as u32) as usize] as char)
            .collect()
    }
}

fn uid(seed: u32, tag: u32, index: usize) -> String {
    format!("{seed:08x}-{tag:04x}-4000-8000-{index:012x}")
}

fn metadata(name: &str, namespace: Option<&str>, uid: String, created: &str) -> Value {
    let mut meta = json!({"name": name, "uid": uid, "creationTimestamp": created});
    if let Some(namespace) = namespace {
        meta["namespace"] = json!(namespace);
    }
    meta
}

fn owner(api_version: &str, kind: &str, obj: &Value) -> Value {
    json!([{"apiVersion": api_version, "kind": kind,
            "name": obj["metadata"]["name"], "uid": obj["metadata"]["uid"],
            "controller": true, "blockOwnerDeletion": true}])
}

fn node_ip(index: usize) -> String {
    format!("10.0.{}.{}", index / 200, index % 200 + 10)
}

fn pod_ip(index: usize) -> String {
    format!(
        "10.{}.{}.{}",
        128 + index / 62_500,
        (index / 250) % 250,
        index % 250 + 2
    )
}

fn event_time(index: usize) -> String {
    let secs = index % 86_400;
    format!(
        "2026-08-31T{:02}:{:02}:{:02}Z",
        secs / 3600,
        secs / 60 % 60,
        secs % 60
    )
}

fn container(role: &str, image: &str) -> Value {
    json!({
        "name": role,
        "image": image,
        "ports": [{"name": "http", "containerPort": 8080, "protocol": "TCP"}],
        "resources": {
            "requests": {"cpu": "100m", "memory": "128Mi"},
            "limits": {"cpu": "500m", "memory": "256Mi"}
        }
    })
}

fn template(app: &str, team: &str, hash: Option<&str>, role: &str, image: &str) -> Value {
    let mut labels = json!({"app": app, "team": team});
    if let Some(hash) = hash {
        labels["pod-template-hash"] = json!(hash);
    }
    json!({
        "metadata": {"labels": labels},
        "spec": {"serviceAccountName": "default", "containers": [container(role, image)]}
    })
}

struct Collection {
    kind: &'static str,
    api_version: String,
    namespaced: bool,
    /// Sorted by (namespace, name).
    items: Vec<Value>,
}

/// A generated cluster: every collection, keyed by its cluster-wide path.
pub struct ScaleCluster {
    collections: BTreeMap<String, Collection>,
    /// (group, version) of every API group, in discovery order.
    groups: BTreeSet<(String, String)>,
    /// resourceVersion of every list (newer than every object).
    rv: u64,
    custom_resources: usize,
}

fn collection_path(group: &str, version: &str, plural: &str) -> String {
    if group.is_empty() {
        format!("/api/{version}/{plural}")
    } else {
        format!("/apis/{group}/{version}/{plural}")
    }
}

fn namespace_of(obj: &Value) -> &str {
    obj["metadata"]["namespace"].as_str().unwrap_or("")
}

fn name_of(obj: &Value) -> &str {
    obj["metadata"]["name"].as_str().unwrap_or("")
}

#[derive(Default)]
struct Generated {
    items: BTreeMap<&'static str, Vec<Value>>,
    custom: BTreeMap<usize, Vec<Value>>,
}

impl Generated {
    fn push(&mut self, plural: &'static str, obj: Value) {
        self.items.entry(plural).or_default().push(obj);
    }
}

impl ScaleCluster {
    pub fn generate(p: &ScalePreset) -> Self {
        let mut generated = generate_objects(p);
        let mut collections = BTreeMap::new();
        let mut groups = BTreeSet::new();
        for &(group, version, kind, plural, namespaced) in KINDS {
            // Core `pods`/`nodes` and the metrics.k8s.io ones share plurals.
            let key = if group == "metrics.k8s.io" {
                format!("metrics:{plural}")
            } else {
                plural.to_string()
            };
            let items = generated.items.remove(key.as_str()).unwrap_or_default();
            if !group.is_empty() {
                groups.insert((group.to_string(), version.to_string()));
            }
            let api_version = if group.is_empty() {
                version.to_string()
            } else {
                format!("{group}/{version}")
            };
            collections.insert(
                collection_path(group, version, plural),
                Collection {
                    kind,
                    api_version,
                    namespaced,
                    items,
                },
            );
        }
        let mut custom_resources = 0;
        for i in 1..=p.crds {
            let group = format!("scale{i}.example.com");
            groups.insert((group.clone(), "v1".into()));
            let items = generated.custom.remove(&i).unwrap_or_default();
            custom_resources += items.len();
            collections.insert(
                collection_path(&group, "v1", "widgets"),
                Collection {
                    kind: "Widget",
                    api_version: format!("{group}/v1"),
                    namespaced: true,
                    items,
                },
            );
        }
        let mut rv = 0u64;
        for collection in collections.values_mut() {
            collection
                .items
                .sort_by(|a, b| (namespace_of(a), name_of(a)).cmp(&(namespace_of(b), name_of(b))));
            for item in &mut collection.items {
                rv += 1;
                item["metadata"]["resourceVersion"] = json!(rv.to_string());
            }
        }
        ScaleCluster {
            collections,
            groups,
            rv: rv + 1,
            custom_resources,
        }
    }

    /// Objects in the cluster-wide `collection_path` (`None` if not served).
    pub fn count(&self, collection_path: &str) -> Option<usize> {
        self.collections.get(collection_path).map(|c| c.items.len())
    }

    /// Every generated custom resource (all `widgets` collections).
    pub fn custom_resources(&self) -> usize {
        self.custom_resources
    }

    /// The objects of `collection_path`, sorted by (namespace, name).
    pub fn objects(&self, collection_path: &str) -> &[Value] {
        self.collections
            .get(collection_path)
            .map_or(&[], |c| c.items.as_slice())
    }

    /// Every served cluster-wide collection path, including empty ones.
    pub fn collections(&self) -> Vec<String> {
        self.collections.keys().cloned().collect()
    }

    pub fn router(self: Arc<Self>, serve: ScaleServe) -> Router {
        Arc::new(move |req: &Request, _log: &Log| self.reply(req, &serve))
    }

    fn reply(&self, req: &Request, serve: &ScaleServe) -> Reply {
        if req.method != "GET" {
            return Reply::Json(
                405,
                status(405, "MethodNotAllowed", "the scale fixture is read-only"),
            );
        }
        let path = req.path_only();
        if let Some(reply) = self.discovery(path) {
            return reply;
        }
        let Some((key, namespace)) = resolve(path) else {
            return not_found(path);
        };
        let Some(collection) = self.collections.get(&key) else {
            return not_found(path);
        };
        if namespace.is_some() && !collection.namespaced {
            return not_found(path);
        }
        let query = Query::parse(&req.path);
        let watch = query.get("watch") == Some("true");
        if watch && matches!(serve.watch, ScaleWatch::Quiet) {
            return Reply::Stream(Vec::new());
        }
        let filter = match Filter::parse(&query) {
            Ok(filter) => filter,
            Err(message) => return Reply::Json(400, status(400, "BadRequest", &message)),
        };
        let scoped = match namespace.as_deref() {
            Some(ns) => {
                let items = &collection.items;
                let lo = items.partition_point(|o| namespace_of(o) < ns);
                let hi = items.partition_point(|o| namespace_of(o) <= ns);
                &items[lo..hi]
            }
            None => collection.items.as_slice(),
        };
        let matched: Vec<&Value> = scoped.iter().filter(|o| filter.matches(o)).collect();
        let metadata_only = req
            .header("accept")
            .is_some_and(|a| a.contains("as=PartialObjectMetadata"));
        if watch {
            return self.watch(&key, &matched, &query, serve, metadata_only);
        }
        self.list(collection, &matched, &query, metadata_only)
    }

    fn list(
        &self,
        collection: &Collection,
        matched: &[&Value],
        query: &Query,
        metadata_only: bool,
    ) -> Reply {
        let offset = match query.get("continue").filter(|t| !t.is_empty()) {
            None => 0,
            Some(token) => match decode_token(token) {
                Some((offset, rv)) if rv == self.rv && offset <= matched.len() => offset,
                _ => {
                    return Reply::Json(
                        410,
                        status(
                            410,
                            "Expired",
                            "The provided continue parameter is too old to display a \
                             consistent list result. You can start a new list without the \
                             continue parameter.",
                        ),
                    )
                }
            },
        };
        let limit = query
            .get("limit")
            .and_then(|l| l.parse::<usize>().ok())
            .filter(|l| *l > 0);
        let end = limit.map_or(matched.len(), |l| (offset + l).min(matched.len()));
        let items: Vec<Value> = matched[offset..end]
            .iter()
            .map(|o| shape(o, metadata_only))
            .collect();
        let mut meta = json!({"resourceVersion": self.rv.to_string()});
        if end < matched.len() {
            meta["continue"] = json!(encode_token(end, self.rv));
            meta["remainingItemCount"] = json!(matched.len() - end);
        }
        let (kind, api_version) = if metadata_only {
            ("PartialObjectMetadataList".to_string(), "meta.k8s.io/v1")
        } else {
            (
                format!("{}List", collection.kind),
                collection.api_version.as_str(),
            )
        };
        Reply::Json(
            200,
            json!({"kind": kind, "apiVersion": api_version, "metadata": meta, "items": items}),
        )
    }

    fn watch(
        &self,
        key: &str,
        matched: &[&Value],
        query: &Query,
        serve: &ScaleServe,
        metadata_only: bool,
    ) -> Reply {
        let ScaleWatch::PodBurst(n) = serve.watch else {
            return Reply::Stream(Vec::new());
        };
        if key != "/api/v1/pods" {
            return Reply::Stream(Vec::new());
        }
        let since = query
            .get("resourceVersion")
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);
        let events = matched
            .iter()
            .take(n)
            .enumerate()
            .filter_map(|(i, obj)| {
                let rv = self.rv + 1 + i as u64;
                (rv > since).then(|| {
                    let mut obj = (*obj).clone();
                    obj["metadata"]["resourceVersion"] = json!(rv.to_string());
                    json!({"type": "MODIFIED", "object": shape(&obj, metadata_only)})
                })
            })
            .collect();
        Reply::Stream(events)
    }

    fn discovery(&self, path: &str) -> Option<Reply> {
        let reply = match path {
            "/version" => json!({"major": "1", "minor": "31", "gitVersion": "v1.31.0",
                "gitCommit": "scale", "gitTreeState": "clean",
                "buildDate": "2026-01-01T00:00:00Z", "goVersion": "go1.23",
                "compiler": "gc", "platform": "linux/amd64"}),
            "/api" => {
                json!({"kind": "APIVersions", "versions": ["v1"], "serverAddressByClientCIDRs": []})
            }
            "/apis" => {
                let groups: Vec<Value> = self
                    .groups
                    .iter()
                    .map(|(group, version)| {
                        let gv = format!("{group}/{version}");
                        json!({"name": group,
                               "versions": [{"groupVersion": gv, "version": version}],
                               "preferredVersion": {"groupVersion": gv, "version": version}})
                    })
                    .collect();
                json!({"kind": "APIGroupList", "apiVersion": "v1", "groups": groups})
            }
            _ => {
                let group_version = if path == "/api/v1" {
                    "v1".to_string()
                } else {
                    let rest = path.strip_prefix("/apis/")?;
                    let (group, version) = rest.split_once('/')?;
                    if version.contains('/')
                        || !self
                            .groups
                            .contains(&(group.to_string(), version.to_string()))
                    {
                        return None;
                    }
                    rest.to_string()
                };
                let resources: Vec<Value> = self
                    .collections
                    .iter()
                    .filter(|(_, c)| c.api_version == group_version)
                    .map(|(key, c)| {
                        let plural = key.rsplit('/').next().unwrap_or_default();
                        let verbs = if group_version.starts_with("metrics.k8s.io/") {
                            json!(["get", "list"])
                        } else {
                            json!(["get", "list", "watch"])
                        };
                        json!({"name": plural, "singularName": "", "namespaced": c.namespaced,
                               "kind": c.kind, "verbs": verbs})
                    })
                    .collect();
                json!({"kind": "APIResourceList", "groupVersion": group_version,
                       "resources": resources})
            }
        };
        Some(Reply::Json(200, reply))
    }
}

fn not_found(path: &str) -> Reply {
    Reply::Json(
        404,
        status(
            404,
            "NotFound",
            &format!("the server could not find the requested resource ({path})"),
        ),
    )
}

/// Whether `path` (without its query) has the shape of a list or watch
/// request (`/api/{v}/{plural}`, `/apis/{g}/{v}/{plural}` or their
/// `namespaces/{ns}/…` variants), whether or not the fixture serves it.
pub fn is_list_path(path: &str) -> bool {
    resolve(path).is_some()
}

/// A list/watch path → (cluster-wide collection path, namespace).
fn resolve(path: &str) -> Option<(String, Option<String>)> {
    let segments: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    match segments.as_slice() {
        ["api", version, plural] => Some((collection_path("", version, plural), None)),
        ["api", version, "namespaces", ns, plural] => {
            Some((collection_path("", version, plural), Some(ns.to_string())))
        }
        ["apis", group, version, plural] => Some((collection_path(group, version, plural), None)),
        ["apis", group, version, "namespaces", ns, plural] => Some((
            collection_path(group, version, plural),
            Some(ns.to_string()),
        )),
        _ => None,
    }
}

/// A list item as served: in full, or as `PartialObjectMetadata`.
fn shape(obj: &Value, metadata_only: bool) -> Value {
    if metadata_only {
        json!({"kind": "PartialObjectMetadata", "apiVersion": "meta.k8s.io/v1",
               "metadata": obj["metadata"]})
    } else {
        obj.clone()
    }
}

fn encode_token(offset: usize, rv: u64) -> String {
    URL_SAFE_NO_PAD.encode(format!("{offset}:{rv}"))
}

fn decode_token(token: &str) -> Option<(usize, u64)> {
    let raw = String::from_utf8(URL_SAFE_NO_PAD.decode(token).ok()?).ok()?;
    let (offset, rv) = raw.split_once(':')?;
    Some((offset.parse().ok()?, rv.parse().ok()?))
}

/// Decoded query parameters.
struct Query(Vec<(String, String)>);

impl Query {
    fn parse(path: &str) -> Self {
        let query = path.split_once('?').map_or("", |(_, q)| q);
        Query(
            query
                .split('&')
                .filter(|p| !p.is_empty())
                .map(|pair| {
                    let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
                    (percent_decode(k), percent_decode(v))
                })
                .collect(),
        )
    }

    fn get(&self, name: &str) -> Option<&str> {
        self.0
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }
}

/// `%XX` escapes (`%3D`, `%2C`, `%2F`…) and `+` for a space, like Go's
/// `url.ParseQuery`.
fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let hex = |i: usize| {
        let pair = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
        u8::from_str_radix(pair, 16).ok()
    };
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match (bytes[i], hex(i)) {
            (b'%', Some(byte)) => {
                out.push(byte);
                i += 3;
                continue;
            }
            (b'+', _) => out.push(b' '),
            (byte, _) => out.push(byte),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// One `key=value`, `key==value` or `key!=value` term.
struct Term {
    key: String,
    value: String,
    equal: bool,
}

fn parse_terms(selector: &str) -> Result<Vec<Term>, String> {
    selector
        .split(',')
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(|term| {
            let (key, value, equal) = if let Some((k, v)) = term.split_once("!=") {
                (k, v, false)
            } else if let Some((k, v)) = term.split_once("==") {
                (k, v, true)
            } else if let Some((k, v)) = term.split_once('=') {
                (k, v, true)
            } else {
                return Err(format!("unsupported selector term {term:?}"));
            };
            Ok(Term {
                key: key.trim().to_string(),
                value: value.trim().to_string(),
                equal,
            })
        })
        .collect()
}

struct Filter {
    /// JSON pointer (from the field path) and term.
    fields: Vec<(String, Term)>,
    labels: Vec<Term>,
}

impl Filter {
    /// Any field path matches by equality on the object's value there
    /// (`spec.nodeName`, `metadata.namespace`, `involvedObject.uid`, `type`,
    /// `status.phase`…); a missing field is the empty string.
    fn parse(query: &Query) -> Result<Self, String> {
        let fields = parse_terms(query.get("fieldSelector").unwrap_or(""))?
            .into_iter()
            .map(|term| (format!("/{}", term.key.replace('.', "/")), term))
            .collect();
        let labels = parse_terms(query.get("labelSelector").unwrap_or(""))?;
        Ok(Filter { fields, labels })
    }

    fn matches(&self, obj: &Value) -> bool {
        self.fields.iter().all(|(pointer, term)| {
            let value = match obj.pointer(pointer) {
                Some(Value::String(s)) => s.clone(),
                Some(Value::Null) | None => String::new(),
                Some(other) => other.to_string(),
            };
            (value == term.value) == term.equal
        }) && self.labels.iter().all(|term| {
            let value = obj["metadata"]["labels"][&term.key].as_str();
            (value == Some(term.value.as_str())) == term.equal
        })
    }
}

/// Every object of preset `p`, by plural (metrics under `metrics:{plural}`)
/// and custom resources by CRD index. Mirrored by `generateScaleObjects`.
fn generate_objects(p: &ScalePreset) -> Generated {
    let seed = p.seed;
    let mut out = Generated::default();
    // Namespaces, each with its `default` ServiceAccount.
    for i in 1..=p.namespaces {
        let name = format!("ns-{i:04}");
        let team = TEAMS[(i - 1) % TEAMS.len()];
        let mut meta = metadata(&name, None, uid(seed, TAG_NAMESPACE, i), CLUSTER_BORN);
        meta["labels"] = json!({"kubernetes.io/metadata.name": name, "team": team});
        out.push(
            "namespaces",
            json!({"apiVersion": "v1", "kind": "Namespace", "metadata": meta,
                   "spec": {"finalizers": ["kubernetes"]}, "status": {"phase": "Active"}}),
        );
        let meta = metadata(
            "default",
            Some(&name),
            uid(seed, TAG_SERVICE_ACCOUNT, i),
            CLUSTER_BORN,
        );
        out.push(
            "serviceaccounts",
            json!({"apiVersion": "v1", "kind": "ServiceAccount", "metadata": meta}),
        );
    }
    // Nodes and their NodeMetrics.
    for i in 1..=p.nodes {
        let name = format!("node-{i:04}");
        let zone = ZONES[(i - 1) % ZONES.len()];
        let mut meta = metadata(&name, None, uid(seed, TAG_NODE, i), CLUSTER_BORN);
        meta["labels"] = json!({
            "kubernetes.io/hostname": name, "kubernetes.io/os": "linux",
            "kubernetes.io/arch": "amd64", "topology.kubernetes.io/zone": zone
        });
        out.push(
            "nodes",
            json!({
                "apiVersion": "v1", "kind": "Node", "metadata": meta,
                "spec": {"podCIDR": format!("10.244.{}.0/24", i - 1)},
                "status": {
                    "capacity": {"cpu": "8", "memory": "32Gi", "pods": "110"},
                    "allocatable": {"cpu": "7910m", "memory": "31Gi", "pods": "110"},
                    "conditions": [{"type": "Ready", "status": "True", "reason": "KubeletReady",
                                    "lastTransitionTime": CLUSTER_BORN}],
                    "addresses": [{"type": "InternalIP", "address": node_ip(i - 1)},
                                  {"type": "Hostname", "address": name}],
                    "nodeInfo": {"kubeletVersion": "v1.31.0", "kubeProxyVersion": "v1.31.0",
                                 "osImage": "Ubuntu 24.04 LTS", "operatingSystem": "linux",
                                 "architecture": "amd64",
                                 "containerRuntimeVersion": "containerd://1.7.22"}
                }
            }),
        );
        out.push(
            "metrics:nodes",
            json!({
                "apiVersion": "metrics.k8s.io/v1beta1", "kind": "NodeMetrics",
                "metadata": {"name": name, "creationTimestamp": METRICS_AT},
                "timestamp": METRICS_AT, "window": "15s",
                "usage": {"cpu": format!("{}m", 400 + (i * 37) % 3000),
                          "memory": format!("{}Mi", 4096 + (i * 53) % 16384)}
            }),
        );
    }

    // Apps: `deploymentsPerNamespace` Deployments per namespace (the remainder
    // of a fractional value goes to the first namespaces), each with its old
    // and current ReplicaSets, pods (round-robin over nodes), Services with
    // one EndpointSlice each, ConfigMaps and Secrets. One xorshift stream per
    // Deployment draws, in order: the current and old pod-template hashes,
    // the pod suffixes, then the EndpointSlice suffixes.
    let total = (p.namespaces as f64 * p.deployments_per_namespace).round() as usize;
    let base = p.deployments_per_namespace.floor() as usize;
    let extra = total.saturating_sub(base * p.namespaces);
    let (mut d, mut pod_index, mut service_index) = (0usize, 0usize, 0usize);
    let (mut rs_index, mut cm_index, mut secret_index) = (0usize, 0usize, 0usize);
    let mut pods_for_events: Vec<(String, String, String, String, String)> = Vec::new();
    for ns_index in 1..=p.namespaces {
        let ns = format!("ns-{ns_index:04}");
        let team = TEAMS[(ns_index - 1) % TEAMS.len()];
        let count = base + usize::from(ns_index <= extra);
        for _ in 0..count {
            d += 1;
            let role = ROLES[(d - 1) % ROLES.len()];
            let app = format!("app-{d:04}-{role}");
            let image = format!("registry.example.com/{role}:1.{}.0", d % 20);
            let mut rng = Rng::for_object(seed, TAG_DEPLOYMENT, d);
            let hash = rng.name(10);
            let old_hashes: Vec<String> = (0..p.old_replica_sets).map(|_| rng.name(10)).collect();
            let revision = p.old_replica_sets + 1;

            let mut meta = metadata(&app, Some(&ns), uid(seed, TAG_DEPLOYMENT, d), APP_BORN);
            meta["labels"] = json!({"app": app, "team": team});
            meta["annotations"] =
                json!({"deployment.kubernetes.io/revision": revision.to_string()});
            meta["generation"] = json!(revision);
            let deployment = json!({
                "apiVersion": "apps/v1", "kind": "Deployment", "metadata": meta,
                "spec": {
                    "replicas": p.replicas,
                    "selector": {"matchLabels": {"app": app}},
                    "strategy": {"type": "RollingUpdate",
                                 "rollingUpdate": {"maxSurge": "25%", "maxUnavailable": "25%"}},
                    "template": template(&app, team, None, role, &image)
                },
                "status": {
                    "observedGeneration": revision, "replicas": p.replicas,
                    "updatedReplicas": p.replicas, "readyReplicas": p.replicas,
                    "availableReplicas": p.replicas,
                    "conditions": [
                        {"type": "Available", "status": "True",
                         "reason": "MinimumReplicasAvailable", "lastTransitionTime": ROLLOUT},
                        {"type": "Progressing", "status": "True",
                         "reason": "NewReplicaSetAvailable", "lastTransitionTime": ROLLOUT}
                    ]
                }
            });

            let replica_set = |name: &str,
                               hash: &str,
                               rev: usize,
                               replicas: usize,
                               created: &str,
                               index: usize| {
                let mut meta =
                    metadata(name, Some(&ns), uid(seed, TAG_REPLICA_SET, index), created);
                meta["labels"] = json!({"app": app, "team": team, "pod-template-hash": hash});
                meta["annotations"] = json!({
                    "deployment.kubernetes.io/revision": rev.to_string(),
                    "deployment.kubernetes.io/desired-replicas": p.replicas.to_string()
                });
                meta["ownerReferences"] = owner("apps/v1", "Deployment", &deployment);
                json!({
                    "apiVersion": "apps/v1", "kind": "ReplicaSet", "metadata": meta,
                    "spec": {
                        "replicas": replicas,
                        "selector": {"matchLabels": {"app": app, "pod-template-hash": hash}},
                        "template": template(&app, team, Some(hash), role, &image)
                    },
                    "status": {"replicas": replicas, "fullyLabeledReplicas": replicas,
                               "readyReplicas": replicas, "availableReplicas": replicas,
                               "observedGeneration": 1}
                })
            };
            for (k, old) in old_hashes.iter().enumerate() {
                rs_index += 1;
                let name = format!("{app}-{old}");
                out.push(
                    "replicasets",
                    replica_set(&name, old, k + 1, 0, APP_BORN, rs_index),
                );
            }
            rs_index += 1;
            let rs_name = format!("{app}-{hash}");
            let current = replica_set(&rs_name, &hash, revision, p.replicas, ROLLOUT, rs_index);

            let mut pods = Vec::with_capacity(p.replicas);
            for _ in 0..p.replicas {
                let name = format!("{rs_name}-{}", rng.name(5));
                let node = format!("node-{:04}", pod_index % p.nodes.max(1) + 1);
                let host_ip = node_ip(pod_index % p.nodes.max(1));
                let mut meta =
                    metadata(&name, Some(&ns), uid(seed, TAG_POD, pod_index + 1), ROLLOUT);
                meta["labels"] = json!({"app": app, "team": team, "pod-template-hash": hash});
                meta["ownerReferences"] = owner("apps/v1", "ReplicaSet", &current);
                let mut spec = template(&app, team, Some(&hash), role, &image)["spec"].clone();
                spec["nodeName"] = json!(node);
                spec["restartPolicy"] = json!("Always");
                let pod = json!({
                    "apiVersion": "v1", "kind": "Pod", "metadata": meta, "spec": spec,
                    "status": {
                        "phase": "Running", "podIP": pod_ip(pod_index), "hostIP": host_ip,
                        "startTime": ROLLOUT, "qosClass": "Burstable",
                        "conditions": [
                            {"type": "Initialized", "status": "True",
                             "lastTransitionTime": ROLLOUT},
                            {"type": "Ready", "status": "True", "lastTransitionTime": ROLLOUT},
                            {"type": "ContainersReady", "status": "True",
                             "lastTransitionTime": ROLLOUT},
                            {"type": "PodScheduled", "status": "True",
                             "lastTransitionTime": ROLLOUT}
                        ],
                        "containerStatuses": [{
                            "name": role, "image": image, "ready": true, "started": true,
                            "restartCount": 0, "state": {"running": {"startedAt": ROLLOUT}}
                        }]
                    }
                });
                out.push(
                    "metrics:pods",
                    json!({
                        "apiVersion": "metrics.k8s.io/v1beta1", "kind": "PodMetrics",
                        "metadata": {"name": name, "namespace": ns,
                                     "creationTimestamp": METRICS_AT},
                        "timestamp": METRICS_AT, "window": "15s",
                        "containers": [{"name": role, "usage": {
                            "cpu": format!("{}m", 5 + (pod_index * 13) % 200),
                            "memory": format!("{}Mi", 64 + (pod_index * 7) % 128)
                        }}]
                    }),
                );
                pods_for_events.push((name, ns.clone(), node, role.to_string(), image.clone()));
                pods.push(pod);
                pod_index += 1;
            }

            for k in 1..=p.services_per_deployment {
                service_index += 1;
                let name = if k == 1 {
                    app.clone()
                } else {
                    format!("{app}-{k}")
                };
                let mut meta = metadata(
                    &name,
                    Some(&ns),
                    uid(seed, TAG_SERVICE, service_index),
                    APP_BORN,
                );
                meta["labels"] = json!({"app": app, "team": team});
                let service = json!({
                    "apiVersion": "v1", "kind": "Service", "metadata": meta,
                    "spec": {
                        "type": "ClusterIP",
                        "clusterIP": format!("10.96.{}.{}", (service_index - 1) / 250,
                                             (service_index - 1) % 250 + 2),
                        "selector": {"app": app},
                        "ports": [{"name": "http", "port": 80, "targetPort": 8080,
                                   "protocol": "TCP"}]
                    }
                });
                let slice_name = format!("{name}-{}", rng.name(5));
                let mut meta = metadata(
                    &slice_name,
                    Some(&ns),
                    uid(seed, TAG_ENDPOINT_SLICE, service_index),
                    ROLLOUT,
                );
                meta["labels"] = json!({
                    "kubernetes.io/service-name": name,
                    "endpointslice.kubernetes.io/managed-by": "endpointslice-controller.k8s.io"
                });
                meta["ownerReferences"] = owner("v1", "Service", &service);
                let endpoints: Vec<Value> = pods
                    .iter()
                    .map(|pod| {
                        json!({
                            "addresses": [pod["status"]["podIP"]],
                            "conditions": {"ready": true, "serving": true, "terminating": false},
                            "nodeName": pod["spec"]["nodeName"],
                            "targetRef": {"kind": "Pod", "namespace": ns,
                                          "name": pod["metadata"]["name"],
                                          "uid": pod["metadata"]["uid"]}
                        })
                    })
                    .collect();
                out.push(
                    "endpointslices",
                    json!({"apiVersion": "discovery.k8s.io/v1", "kind": "EndpointSlice",
                           "metadata": meta, "addressType": "IPv4", "endpoints": endpoints,
                           "ports": [{"name": "http", "port": 8080, "protocol": "TCP"}]}),
                );
                out.push("services", service);
            }
            for k in 1..=p.config_maps_per_deployment {
                cm_index += 1;
                let name = format!("{app}-config-{k}");
                let mut meta = metadata(
                    &name,
                    Some(&ns),
                    uid(seed, TAG_CONFIG_MAP, cm_index),
                    APP_BORN,
                );
                meta["labels"] = json!({"app": app, "team": team});
                out.push(
                    "configmaps",
                    json!({"apiVersion": "v1", "kind": "ConfigMap", "metadata": meta,
                    "data": {
                        "LOG_LEVEL": "info",
                        "app.properties": format!("service.name={app}\nservice.port=8080\n")
                    }}),
                );
            }
            for k in 1..=p.secrets_per_deployment {
                secret_index += 1;
                let name = format!("{app}-secret-{k}");
                let mut meta = metadata(
                    &name,
                    Some(&ns),
                    uid(seed, TAG_SECRET, secret_index),
                    APP_BORN,
                );
                meta["labels"] = json!({"app": app, "team": team});
                out.push(
                    "secrets",
                    json!({"apiVersion": "v1", "kind": "Secret", "metadata": meta,
                    "type": "Opaque",
                    "data": {
                        "username": STANDARD.encode(&app),
                        "password": STANDARD.encode(format!("scale-secret-{secret_index}"))
                    }}),
                );
            }
            out.push("deployments", deployment);
            out.push("replicasets", current);
            for pod in pods {
                out.push("pods", pod);
            }
        }
    }

    // CRDs `widgets.scale{i}.example.com`, their Widgets spread round-robin
    // over the namespaces.
    for i in 1..=p.crds {
        let group = format!("scale{i}.example.com");
        let name = format!("widgets.{group}");
        let meta = metadata(&name, None, uid(seed, TAG_CRD, i), CLUSTER_BORN);
        let names = json!({"kind": "Widget", "listKind": "WidgetList", "plural": "widgets",
                           "singular": "widget"});
        out.push(
            "customresourcedefinitions",
            json!({
                "apiVersion": "apiextensions.k8s.io/v1", "kind": "CustomResourceDefinition",
                "metadata": meta,
                "spec": {
                    "group": group, "names": names, "scope": "Namespaced",
                    "versions": [{"name": "v1", "served": true, "storage": true,
                                  "schema": {"openAPIV3Schema": {"type": "object",
                                             "x-kubernetes-preserve-unknown-fields": true}}}]
                },
                "status": {
                    "acceptedNames": names, "storedVersions": ["v1"],
                    "conditions": [{"type": "Established", "status": "True",
                                    "reason": "InitialNamesAccepted",
                                    "lastTransitionTime": CLUSTER_BORN}]
                }
            }),
        );
        for j in 1..=p.crs_per_crd {
            let index = (i - 1) * p.crs_per_crd + j;
            let ns = format!("ns-{:04}", (index - 1) % p.namespaces.max(1) + 1);
            let name = format!("widget-{j:04}");
            let mut meta = metadata(
                &name,
                Some(&ns),
                uid(seed, TAG_CUSTOM_RESOURCE, index),
                APP_BORN,
            );
            meta["generation"] = json!(1);
            out.custom.entry(i).or_default().push(json!({
                "apiVersion": format!("{group}/v1"), "kind": "Widget", "metadata": meta,
                "spec": {"size": (i * j) % 10 + 1, "color": ZONES[j % ZONES.len()]},
                "status": {"ready": true, "observedGeneration": 1}
            }));
        }
    }

    // Events: round-robin over the pods, reasons in lifecycle order.
    if !pods_for_events.is_empty() {
        for k in 0..p.events {
            let (pod, ns, node, container, image) = &pods_for_events[k % pods_for_events.len()];
            let (reason, template) =
                EVENT_REASONS[(k / pods_for_events.len()) % EVENT_REASONS.len()];
            let message = template
                .replace("{ns}", ns)
                .replace("{pod}", pod)
                .replace("{node}", node)
                .replace("{image}", image)
                .replace("{container}", container);
            let mut rng = Rng::for_object(seed, TAG_EVENT, k);
            let name = format!("{pod}.{:08x}{:08x}", rng.next(), rng.next());
            let at = event_time(k);
            let meta = metadata(&name, Some(ns), uid(seed, TAG_EVENT, k + 1), &at);
            let pod_uid = uid(seed, TAG_POD, k % pods_for_events.len() + 1);
            out.push(
                "events",
                json!({
                    "apiVersion": "v1", "kind": "Event", "metadata": meta,
                    "involvedObject": {"apiVersion": "v1", "kind": "Pod", "namespace": ns,
                                       "name": pod, "uid": pod_uid},
                    "reason": reason, "message": message, "type": "Normal", "count": 1,
                    "firstTimestamp": at, "lastTimestamp": at,
                    "source": {"component": "kubelet", "host": node},
                    "reportingComponent": "kubelet", "reportingInstance": node
                }),
            );
        }
    }
    out
}
