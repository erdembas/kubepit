//! OpenCost (`/allocation/compute`) and Kubecost (`/model/allocation`)
//! allocation queries and their responses.
//!
//! Both answer with the same shape — one map per step, allocation name →
//! allocation:
//!
//! ```json
//! {"code":200,"data":[{"shop":{"name":"shop","properties":{"namespace":"shop"},
//!   "start":"…","end":"…","minutes":10080,"cpuCores":1.2,"cpuCoreRequestAverage":1.5,
//!   "cpuCoreUsageAverage":0.4,"cpuCost":12.3,"ramCost":4.5,"totalCost":17.9, …},
//!   "__idle__":{…}}]}
//! ```
//!
//! Costs cover the allocation's own `minutes` (less than the window when the
//! cost model has less data), so every row is turned into a monthly run rate
//! with its own duration. `__idle__` is unrequested capacity and
//! `__unallocated__` groups costs without the aggregation property. Label
//! aggregations use Prometheus-style label names (`app.kubernetes.io/name`
//! → `app_kubernetes_io_name`) and name rows `label=value`.

use std::collections::BTreeMap;

use anyhow::{bail, Result};
use serde_json::Value;

use super::types::{CostAggregate, CostItem, CostSpecial, CostTotals, CostTrendPoint, CostWindow};
use super::HOURS_PER_MONTH;

pub const IDLE: &str = "__idle__";
pub const UNALLOCATED: &str = "__unallocated__";

/// One allocation, as far as the report needs it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Allocation {
    pub name: String,
    pub namespace: String,
    pub controller_kind: String,
    pub controller: String,
    /// Epoch ms of the allocation window start (0 when missing).
    pub start: i64,
    pub minutes: f64,
    pub cpu_cost: f64,
    pub ram_cost: f64,
    pub gpu_cost: f64,
    pub pv_cost: f64,
    pub other_cost: f64,
    pub total_cost: f64,
    pub cpu_request: f64,
    pub cpu_usage: f64,
    pub ram_request: f64,
    pub ram_usage: f64,
    pub gpus: f64,
    pub pv_bytes: f64,
    pub efficiency: Option<f64>,
}

/// Prometheus-style label name, as the cost models expect in `label:<name>`.
pub fn sanitize_label(key: &str) -> String {
    key.trim()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// `aggregate` parameter of a breakdown query.
pub fn aggregate_param(aggregate: CostAggregate, label: Option<&str>) -> Result<String> {
    Ok(match aggregate {
        CostAggregate::Namespace => "namespace".to_string(),
        CostAggregate::Workload => "namespace,controllerKind,controller".to_string(),
        CostAggregate::Label => {
            let label = sanitize_label(label.unwrap_or_default());
            if label.trim_matches('_').is_empty() {
                bail!("choose a label key to group costs by");
            }
            format!("label:{label}")
        }
    })
}

/// Parameters of the accumulated breakdown over `window`. OpenCost reads
/// `includeIdle`, Kubecost `idle`; both ignore the other.
pub fn breakdown_params(
    window: CostWindow,
    aggregate: CostAggregate,
    label: Option<&str>,
) -> Result<Vec<(&'static str, String)>> {
    Ok(vec![
        ("window", window.as_param().to_string()),
        ("aggregate", aggregate_param(aggregate, label)?),
        ("accumulate", "true".to_string()),
        ("includeIdle", "true".to_string()),
        ("idle", "true".to_string()),
    ])
}

/// Parameters of the daily cluster totals over `window`.
pub fn trend_params(window: CostWindow) -> Vec<(&'static str, String)> {
    vec![
        ("window", window.as_param().to_string()),
        ("aggregate", "cluster".to_string()),
        ("accumulate", "false".to_string()),
        ("step", "1d".to_string()),
        ("includeIdle", "true".to_string()),
        ("idle", "true".to_string()),
    ]
}

/// Parameters of the detection probe.
pub fn probe_params() -> Vec<(&'static str, String)> {
    vec![
        ("window", "1h".to_string()),
        ("aggregate", "cluster".to_string()),
        ("accumulate", "true".to_string()),
    ]
}

fn num(obj: &Value, key: &str) -> f64 {
    let value = match obj.get(key) {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.parse().ok(),
        _ => None,
    };
    value.filter(|v| v.is_finite()).unwrap_or(0.0)
}

fn text(obj: &Value, pointer: &str) -> String {
    obj.pointer(pointer)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn epoch_ms(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|t| t.timestamp_millis())
}

fn allocation(key: &str, obj: &Value) -> Allocation {
    let start_text = text(obj, "/start");
    let start_text = if start_text.is_empty() {
        text(obj, "/window/start")
    } else {
        start_text
    };
    let end_text = text(obj, "/end");
    let start = epoch_ms(&start_text).unwrap_or(0);
    let mut minutes = num(obj, "minutes");
    if minutes <= 0.0 {
        if let (Some(s), Some(e)) = (epoch_ms(&start_text), epoch_ms(&end_text)) {
            minutes = ((e - s) as f64 / 60_000.0).max(0.0);
        }
    }
    let adjusted = |cost: &str, adjustment: &str| num(obj, cost) + num(obj, adjustment);
    let cpu_cost = adjusted("cpuCost", "cpuCostAdjustment");
    let ram_cost = adjusted("ramCost", "ramCostAdjustment");
    let gpu_cost = adjusted("gpuCost", "gpuCostAdjustment");
    let pv_cost = adjusted("pvCost", "pvCostAdjustment");
    let other_cost = num(obj, "networkCost")
        + num(obj, "networkCostAdjustment")
        + num(obj, "loadBalancerCost")
        + num(obj, "loadBalancerCostAdjustment")
        + num(obj, "sharedCost")
        + num(obj, "externalCost");
    let mut total_cost = num(obj, "totalCost");
    if total_cost <= 0.0 {
        total_cost = cpu_cost + ram_cost + gpu_cost + pv_cost + other_cost;
    }
    let cpu_request = num(obj, "cpuCoreRequestAverage");
    let ram_request = num(obj, "ramByteRequestAverage");
    let efficiency = obj
        .get("totalEfficiency")
        .and_then(Value::as_f64)
        .filter(|e| e.is_finite() && (cpu_request > 0.0 || ram_request > 0.0));
    let name = obj
        .get("name")
        .and_then(Value::as_str)
        .filter(|n| !n.is_empty())
        .unwrap_or(key)
        .to_string();
    Allocation {
        name,
        namespace: text(obj, "/properties/namespace"),
        controller_kind: text(obj, "/properties/controllerKind"),
        controller: text(obj, "/properties/controller"),
        start,
        minutes,
        cpu_cost,
        ram_cost,
        gpu_cost,
        pv_cost,
        other_cost,
        total_cost,
        cpu_request,
        cpu_usage: num(obj, "cpuCoreUsageAverage"),
        ram_request,
        ram_usage: num(obj, "ramByteUsageAverage"),
        gpus: num(obj, "gpuCount"),
        pv_bytes: num(obj, "pvBytes"),
        efficiency,
    }
}

/// The allocation sets of a response (one per step), in order.
pub fn parse_sets(body: &Value) -> Result<Vec<Vec<Allocation>>> {
    if let Some(code) = body.get("code").and_then(Value::as_u64) {
        if code != 200 {
            let message = body
                .get("message")
                .or_else(|| body.get("error"))
                .and_then(Value::as_str)
                .unwrap_or("the cost API returned an error");
            bail!("{message} (code {code})");
        }
    }
    let data = body
        .get("data")
        .ok_or_else(|| anyhow::anyhow!("the cost API response has no data"))?;
    let sets: Vec<&Value> = match data {
        Value::Array(sets) => sets.iter().collect(),
        Value::Object(_) => vec![data],
        Value::Null => Vec::new(),
        _ => bail!("the service did not answer like a cost allocation API"),
    };
    Ok(sets
        .into_iter()
        .map(|set| {
            set.as_object()
                .map(|map| {
                    map.iter()
                        .filter(|(_, v)| v.is_object())
                        .map(|(k, v)| allocation(k, v))
                        .collect()
                })
                .unwrap_or_default()
        })
        .collect())
}

/// Kubernetes spelling of a cost model's lower-case controller kind.
pub fn controller_kind(kind: &str) -> String {
    match kind.to_ascii_lowercase().as_str() {
        "deployment" => "Deployment".into(),
        "statefulset" => "StatefulSet".into(),
        "daemonset" => "DaemonSet".into(),
        "replicaset" => "ReplicaSet".into(),
        "job" => "Job".into(),
        "cronjob" => "CronJob".into(),
        "rollout" => "Rollout".into(),
        "pod" => "Pod".into(),
        "" => String::new(),
        other => {
            let mut chars = other.chars();
            chars
                .next()
                .map(|c| c.to_ascii_uppercase().to_string() + chars.as_str())
                .unwrap_or_default()
        }
    }
}

fn is_marker(value: &str, marker: &str) -> bool {
    value == marker || value.split('/').any(|part| part == marker)
}

/// The report row of one allocation (monthly run rates).
fn item(a: &Allocation, aggregate: CostAggregate, label: Option<&str>) -> Option<CostItem> {
    if a.minutes <= 0.0 {
        return None;
    }
    let monthly = HOURS_PER_MONTH * 60.0 / a.minutes;
    let mut row = CostItem {
        cpu_request_cores: a.cpu_request,
        cpu_usage_cores: Some(a.cpu_usage),
        memory_request_bytes: a.ram_request,
        memory_usage_bytes: Some(a.ram_usage),
        gpus: a.gpus,
        storage_bytes: a.pv_bytes,
        cpu_cost: a.cpu_cost * monthly,
        memory_cost: a.ram_cost * monthly,
        gpu_cost: a.gpu_cost * monthly,
        storage_cost: a.pv_cost * monthly,
        other_cost: a.other_cost * monthly,
        total_cost: a.total_cost * monthly,
        efficiency: a.efficiency,
        ..Default::default()
    };
    if is_marker(&a.name, IDLE) {
        row.key = IDLE.into();
        row.name = IDLE.into();
        row.special = Some(CostSpecial::Idle);
        row.cpu_usage_cores = None;
        row.memory_usage_bytes = None;
        row.efficiency = None;
        return Some(row);
    }
    match aggregate {
        CostAggregate::Namespace => {
            let ns = if a.namespace.is_empty() {
                a.name.clone()
            } else {
                a.namespace.clone()
            };
            row.special = is_marker(&ns, UNALLOCATED).then_some(CostSpecial::Unallocated);
            row.key = ns.clone();
            row.name = ns.clone();
            row.namespace = row.special.is_none().then_some(ns);
        }
        CostAggregate::Workload => {
            let parts: Vec<&str> = a.name.split('/').collect();
            let namespace = if a.namespace.is_empty() {
                parts.first().copied().unwrap_or_default().to_string()
            } else {
                a.namespace.clone()
            };
            let controller = if a.controller.is_empty() {
                parts.last().copied().unwrap_or_default().to_string()
            } else {
                a.controller.clone()
            };
            let kind = if a.controller_kind.is_empty() && parts.len() == 3 {
                controller_kind(parts[1])
            } else {
                controller_kind(&a.controller_kind)
            };
            if controller.is_empty() || is_marker(&controller, UNALLOCATED) {
                row.special = Some(CostSpecial::Unallocated);
                row.name = UNALLOCATED.into();
                row.key = format!("{namespace}/{UNALLOCATED}");
            } else {
                row.key = format!("{namespace}/{kind}/{controller}");
                row.name = controller;
                row.kind = (!kind.is_empty()).then_some(kind);
            }
            row.namespace =
                (!namespace.is_empty() && !is_marker(&namespace, UNALLOCATED)).then_some(namespace);
        }
        CostAggregate::Label => {
            let prefix = format!("{}=", sanitize_label(label.unwrap_or_default()));
            let value = a
                .name
                .strip_prefix(&prefix)
                .or_else(|| a.name.split_once('=').map(|(_, v)| v))
                .unwrap_or(&a.name)
                .to_string();
            if value.is_empty() || is_marker(&value, UNALLOCATED) {
                row.special = Some(CostSpecial::Unallocated);
                row.name = UNALLOCATED.into();
                row.key = UNALLOCATED.into();
            } else {
                row.key = value.clone();
                row.name = value;
            }
        }
    }
    Some(row)
}

/// Rows with the same key (several sets, split allocations) add up.
fn merge(into: &mut CostItem, row: CostItem) {
    let weight = |i: &CostItem| i.cpu_cost + i.memory_cost;
    let efficiency = match (into.efficiency, row.efficiency) {
        (Some(a), Some(b)) => {
            let (wa, wb) = (weight(into), weight(&row));
            Some(if wa + wb > 0.0 {
                (a * wa + b * wb) / (wa + wb)
            } else {
                (a + b) / 2.0
            })
        }
        (a, b) => a.or(b),
    };
    into.cpu_request_cores += row.cpu_request_cores;
    into.memory_request_bytes += row.memory_request_bytes;
    into.cpu_usage_cores = add_opt(into.cpu_usage_cores, row.cpu_usage_cores);
    into.memory_usage_bytes = add_opt(into.memory_usage_bytes, row.memory_usage_bytes);
    into.gpus += row.gpus;
    into.storage_bytes += row.storage_bytes;
    into.cpu_cost += row.cpu_cost;
    into.memory_cost += row.memory_cost;
    into.gpu_cost += row.gpu_cost;
    into.storage_cost += row.storage_cost;
    into.other_cost += row.other_cost;
    into.total_cost += row.total_cost;
    into.efficiency = efficiency;
}

pub fn add_opt(a: Option<f64>, b: Option<f64>) -> Option<f64> {
    match (a, b) {
        (Some(a), Some(b)) => Some(a + b),
        (a, b) => a.or(b),
    }
}

/// Totals over report rows: idle rows are capacity, the rest is allocated.
pub fn totals(items: &[CostItem], idle_known: bool) -> CostTotals {
    let mut t = CostTotals::default();
    let mut idle = 0.0;
    let (mut cpu_req, mut cpu_use, mut ram_req, mut ram_use) = (0.0, 0.0, 0.0, 0.0);
    let (mut eff_weight, mut eff_sum) = (0.0, 0.0);
    let mut usage_seen = false;
    for i in items {
        t.total += i.total_cost;
        t.cpu += i.cpu_cost;
        t.memory += i.memory_cost;
        t.gpu += i.gpu_cost;
        t.storage += i.storage_cost;
        t.other += i.other_cost;
        if i.special == Some(CostSpecial::Idle) {
            idle += i.total_cost;
            continue;
        }
        if let (Some(cu), Some(mu)) = (i.cpu_usage_cores, i.memory_usage_bytes) {
            usage_seen = true;
            cpu_req += i.cpu_request_cores;
            ram_req += i.memory_request_bytes;
            cpu_use += cu;
            ram_use += mu;
        }
        if let Some(e) = i.efficiency {
            let w = i.cpu_cost + i.memory_cost;
            eff_weight += w;
            eff_sum += e * w;
        }
    }
    t.allocated = t.total - idle;
    t.idle = idle_known.then_some(idle);
    t.efficiency = (eff_weight > 0.0).then(|| eff_sum / eff_weight);
    t.cpu_efficiency = (usage_seen && cpu_req > 0.0).then(|| cpu_use / cpu_req);
    t.memory_efficiency = (usage_seen && ram_req > 0.0).then(|| ram_use / ram_req);
    t
}

/// Report rows and totals of an accumulated breakdown.
pub fn breakdown(
    sets: &[Vec<Allocation>],
    aggregate: CostAggregate,
    label: Option<&str>,
) -> (CostTotals, Vec<CostItem>) {
    let mut rows: BTreeMap<String, CostItem> = BTreeMap::new();
    let mut idle_known = false;
    for a in sets.iter().flatten() {
        let Some(row) = item(a, aggregate, label) else {
            continue;
        };
        idle_known |= row.special == Some(CostSpecial::Idle);
        match rows.get_mut(&row.key) {
            Some(existing) => merge(existing, row),
            None => {
                rows.insert(row.key.clone(), row);
            }
        }
    }
    let mut items: Vec<CostItem> = rows.into_values().collect();
    sort_items(&mut items);
    (totals(&items, idle_known), items)
}

/// Most expensive first; ties by key.
pub fn sort_items(items: &mut [CostItem]) {
    items.sort_by(|a, b| {
        b.total_cost
            .partial_cmp(&a.total_cost)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.key.cmp(&b.key))
    });
}

/// Daily totals of a `step=1d` response (partial days scaled to a full day).
pub fn trend(sets: &[Vec<Allocation>]) -> Vec<CostTrendPoint> {
    let mut out: Vec<CostTrendPoint> = sets
        .iter()
        .filter_map(|set| {
            let start = set.iter().map(|a| a.start).filter(|s| *s > 0).min()?;
            let minutes = set.iter().map(|a| a.minutes).fold(0.0, f64::max);
            if minutes <= 0.0 {
                return None;
            }
            let cost: f64 = set.iter().map(|a| a.total_cost).sum();
            // A day in progress counts at its current rate.
            let scale = (24.0 * 60.0 / minutes).min(24.0 * 60.0);
            Some(CostTrendPoint {
                ts: start,
                total: cost * scale,
            })
        })
        .collect();
    out.sort_by_key(|p| p.ts);
    out.dedup_by_key(|p| p.ts);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn alloc(name: &str, ns: &str, cpu: f64, ram: f64, minutes: f64) -> Value {
        json!({
            "name": name,
            "properties": {"cluster": "default-cluster", "namespace": ns},
            "window": {"start": "2026-09-20T00:00:00Z", "end": "2026-09-27T00:00:00Z"},
            "start": "2026-09-20T00:00:00Z",
            "end": "2026-09-27T00:00:00Z",
            "minutes": minutes,
            "cpuCores": 1.0,
            "cpuCoreRequestAverage": 2.0,
            "cpuCoreUsageAverage": 0.5,
            "cpuCost": cpu,
            "cpuCostAdjustment": 0.0,
            "gpuCost": 0.0,
            "networkCost": 0.25,
            "loadBalancerCost": 0.75,
            "pvCost": 1.0,
            "pvBytes": 10737418240.0,
            "ramByteRequestAverage": 4294967296.0,
            "ramByteUsageAverage": 2147483648.0,
            "ramCost": ram,
            "sharedCost": 0.0,
            "externalCost": 0.0,
            "totalCost": cpu + ram + 1.0 + 1.0,
            "totalEfficiency": 0.4
        })
    }

    #[test]
    fn opencost_namespace_breakdown_becomes_monthly_rows() {
        let body = json!({"code": 200, "status": "success", "data": [{
            "shop": alloc("shop", "shop", 70.0, 28.0, 10080.0),
            "kube-system": alloc("kube-system", "kube-system", 7.0, 7.0, 10080.0),
            "__idle__": alloc("__idle__", "", 35.0, 14.0, 10080.0),
            "__unallocated__": alloc("__unallocated__", "", 1.0, 1.0, 10080.0),
        }]});
        let sets = parse_sets(&body).unwrap();
        assert_eq!(sets.len(), 1);
        let (totals, items) = breakdown(&sets, CostAggregate::Namespace, None);
        // One week of data → × 730 / 168.
        let factor = 730.0 / 168.0;
        let shop = items.iter().find(|i| i.key == "shop").unwrap();
        assert!((shop.cpu_cost - 70.0 * factor).abs() < 1e-6);
        assert!((shop.total_cost - 100.0 * factor).abs() < 1e-6);
        assert!((shop.other_cost - 1.0 * factor).abs() < 1e-6);
        assert_eq!(shop.namespace.as_deref(), Some("shop"));
        assert_eq!(shop.efficiency, Some(0.4));
        assert_eq!(shop.cpu_usage_cores, Some(0.5));
        assert_eq!(items[0].key, "shop", "most expensive first");
        let idle = items.iter().find(|i| i.key == IDLE).unwrap();
        assert_eq!(idle.special, Some(CostSpecial::Idle));
        assert!(idle.efficiency.is_none());
        let unallocated = items.iter().find(|i| i.key == UNALLOCATED).unwrap();
        assert_eq!(unallocated.special, Some(CostSpecial::Unallocated));
        assert!(unallocated.namespace.is_none());
        assert!((totals.idle.unwrap() - 51.0 * factor).abs() < 1e-6);
        assert!((totals.total - totals.allocated - totals.idle.unwrap()).abs() < 1e-6);
        assert!((totals.cpu_efficiency.unwrap() - 0.25).abs() < 1e-9);
        assert!((totals.memory_efficiency.unwrap() - 0.5).abs() < 1e-9);
        assert!((totals.efficiency.unwrap() - 0.4).abs() < 1e-9);
    }

    #[test]
    fn partial_windows_scale_by_their_own_minutes() {
        // Installed a day ago: 1 440 minutes of data in a 7-day window.
        let body = json!({"code": 200, "data": [{"web": alloc("web", "web", 2.0, 1.0, 1440.0)}]});
        let (_, items) = breakdown(&parse_sets(&body).unwrap(), CostAggregate::Namespace, None);
        assert!((items[0].cpu_cost - 2.0 * 730.0 / 24.0).abs() < 1e-6);
        // Rows without minutes fall back to start/end, empty ones are skipped.
        let mut no_minutes = alloc("db", "db", 7.0, 0.0, 0.0);
        no_minutes["minutes"] = json!(null);
        let empty = json!({"name": "x", "start": "", "end": ""});
        let body = json!({"data": [{"db": no_minutes, "x": empty}]});
        let (_, items) = breakdown(&parse_sets(&body).unwrap(), CostAggregate::Namespace, None);
        assert_eq!(items.len(), 1);
        assert!((items[0].cpu_cost - 7.0 * 730.0 / 168.0).abs() < 1e-6);
    }

    #[test]
    fn controllers_and_labels_are_named_like_kubernetes() {
        let mut web = alloc("shop/deployment/web", "shop", 10.0, 5.0, 10080.0);
        web["properties"]["controllerKind"] = json!("deployment");
        web["properties"]["controller"] = json!("web");
        let db = alloc("db/statefulset/pg", "db", 4.0, 8.0, 10080.0);
        let bare = alloc("shop/__unallocated__", "shop", 1.0, 1.0, 10080.0);
        let body = json!({"code": 200, "data": [{"a": web, "b": db, "c": bare}]});
        let (_, items) = breakdown(&parse_sets(&body).unwrap(), CostAggregate::Workload, None);
        let web = items.iter().find(|i| i.name == "web").unwrap();
        assert_eq!(web.kind.as_deref(), Some("Deployment"));
        assert_eq!(web.key, "shop/Deployment/web");
        let pg = items.iter().find(|i| i.name == "pg").unwrap();
        assert_eq!(pg.kind.as_deref(), Some("StatefulSet"), "from the name");
        assert_eq!(pg.namespace.as_deref(), Some("db"));
        let bare = items.iter().find(|i| i.special.is_some()).unwrap();
        assert_eq!(bare.special, Some(CostSpecial::Unallocated));
        assert_eq!(bare.namespace.as_deref(), Some("shop"));

        let body = json!({"data": [{
            "app_kubernetes_io_part_of=checkout": alloc("app_kubernetes_io_part_of=checkout", "", 3.0, 1.0, 10080.0),
            "__unallocated__": alloc("__unallocated__", "", 1.0, 1.0, 10080.0),
        }]});
        let (_, items) = breakdown(
            &parse_sets(&body).unwrap(),
            CostAggregate::Label,
            Some("app.kubernetes.io/part-of"),
        );
        assert_eq!(items[0].name, "checkout");
        assert_eq!(items[1].special, Some(CostSpecial::Unallocated));
        assert_eq!(controller_kind("argorollout"), "Argorollout");
    }

    #[test]
    fn query_parameters() {
        assert_eq!(
            sanitize_label("app.kubernetes.io/part-of"),
            "app_kubernetes_io_part_of"
        );
        let params =
            breakdown_params(CostWindow::Month, CostAggregate::Label, Some("team")).unwrap();
        assert!(params.contains(&("aggregate", "label:team".to_string())));
        assert!(params.contains(&("window", "30d".to_string())));
        assert!(breakdown_params(CostWindow::Week, CostAggregate::Label, Some(" ./ ")).is_err());
        assert!(breakdown_params(CostWindow::Week, CostAggregate::Label, None).is_err());
        let workload = breakdown_params(CostWindow::Week, CostAggregate::Workload, None).unwrap();
        assert!(workload.contains(&(
            "aggregate",
            "namespace,controllerKind,controller".to_string()
        )));
        assert!(trend_params(CostWindow::Week).contains(&("step", "1d".to_string())));
    }

    #[test]
    fn daily_trend_and_errors() {
        let day = |start: &str, cost: f64, minutes: f64| {
            json!({"cluster-one": {"name": "cluster-one", "start": start, "end": start,
                    "minutes": minutes, "totalCost": cost},
                   "__idle__": {"name": "__idle__", "start": start, "minutes": minutes, "totalCost": 1.0}})
        };
        let body = json!({"code": 200, "data": [
            day("2026-09-25T00:00:00Z", 9.0, 1440.0),
            day("2026-09-26T00:00:00Z", 11.0, 1440.0),
            day("2026-09-27T00:00:00Z", 2.0, 360.0),
            {}
        ]});
        let points = trend(&parse_sets(&body).unwrap());
        assert_eq!(points.len(), 3);
        assert_eq!(points[0].total, 10.0);
        assert_eq!(points[1].total, 12.0);
        assert_eq!(points[2].total, 12.0, "six hours scaled to a day");
        assert!(points[0].ts < points[1].ts);

        let err = parse_sets(&json!({"code": 500, "message": "boom"})).unwrap_err();
        assert!(err.to_string().contains("boom"));
        assert!(parse_sets(&json!({"code": 200})).is_err());
        assert!(parse_sets(&json!({"data": "nope"})).is_err());
        assert!(parse_sets(&json!({"data": null})).unwrap().is_empty());
    }
}
