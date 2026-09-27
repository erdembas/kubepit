//! Preset PromQL, so the UI never builds queries itself.
//!
//! The presets use the series every common Kubernetes monitoring stack
//! scrapes (kube-prometheus-stack, the prometheus-community chart,
//! VictoriaMetrics' k8s stack, OpenShift):
//!
//! - cAdvisor through the kubelet: `container_cpu_usage_seconds_total`,
//!   `container_memory_working_set_bytes`, `container_network_*`,
//!   `container_fs_usage_bytes` (pods, containers, namespaces);
//! - node-exporter: `node_cpu_seconds_total`, `node_memory_*`,
//!   `node_network_*`, `node_filesystem_*` (nodes, cluster), mapped to
//!   Kubernetes node names through `node_uname_info{nodename}`, with the
//!   cAdvisor root cgroup (`id="/"`) as a fallback where node-exporter is
//!   missing;
//! - kube-state-metrics v2: `kube_pod_container_resource_{requests,limits}`,
//!   `kube_pod_container_status_restarts_total`, `kube_pod_status_phase`;
//! - kubelet volume stats: `kubelet_volume_stats_{used,capacity}_bytes`.
//!
//! Every preset aggregates to one series with `sum(...)`. CPU is converted
//! to millicores so the charts share the metrics-server formatting.

use crate::types::{PrometheusMetric, PrometheusTarget};

/// Pod phases whose requests count (like the cluster overview).
const ACTIVE_PODS: &str = r#"* on(namespace, pod) group_left() max by (namespace, pod) (kube_pod_status_phase{phase=~"Pending|Running"} == 1)"#;
/// Physical and bonding interfaces; virtual CNI / bridge devices would count traffic twice.
const VIRTUAL_DEVICES: &str =
    "lo|veth.*|cali.*|cilium.*|lxc.*|flannel.*|cni.*|docker.*|br-.*|virbr.*|vxlan.*|tunl.*|kube-.*|genev.*|gke.*|azv.*|eni.*";
/// Real block-device filesystems (no tmpfs, overlay, …).
const REAL_FS: &str = r#"fstype=~"ext[234]|xfs|btrfs|zfs""#;
/// cAdvisor series of real containers (not the pod cgroup nor the pause container).
const CONTAINERS: &str = r#"container!="",container!="POD""#;
const NON_IDLE_CPU: &str = r#"mode!~"idle|iowait|steal""#;

/// A PromQL double-quoted string literal body.
pub fn quote(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str(r"\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str(r"\n"),
            _ => out.push(ch),
        }
    }
    out.push('"');
    out
}

/// Escape RE2 metacharacters so `value` matches literally inside `=~`.
pub fn regex_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        if r"\.+*?()|[]{}^$".contains(ch) {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// Pod-name regex of the pods a workload of `kind` named `name` creates.
/// Segment counts keep `web` from matching the pods of `web-api`.
pub fn workload_pod_regex(kind: &str, name: &str) -> String {
    let name = regex_escape(name);
    let suffix = match kind {
        // <deployment>-<pod-template-hash>-<5 chars>
        "Deployment" | "Rollout" => "-[a-z0-9]+-[a-z0-9]+",
        // <statefulset>-<ordinal>
        "StatefulSet" => "-[0-9]+",
        // <cronjob>-<scheduled time>-<5 chars>
        "CronJob" => "-[0-9]+-[a-z0-9]+",
        // <owner>-<5 chars>
        "ReplicaSet" | "DaemonSet" | "Job" | "ReplicationController" => "-[a-z0-9]+",
        _ => "-.+",
    };
    format!("{name}{suffix}")
}

/// Label matchers selecting the target's containers / pods (without braces).
fn pod_selector(target: &PrometheusTarget) -> String {
    match target {
        PrometheusTarget::Cluster | PrometheusTarget::Pvc { .. } => String::new(),
        PrometheusTarget::Node { name } => format!("node={}", quote(name)),
        PrometheusTarget::Namespace { namespace } => format!("namespace={}", quote(namespace)),
        PrometheusTarget::Workload {
            namespace,
            workload_kind,
            name,
        } => format!(
            "namespace={},pod=~{}",
            quote(namespace),
            quote(&workload_pod_regex(workload_kind, name))
        ),
        PrometheusTarget::Pod { namespace, name } => {
            format!("namespace={},pod={}", quote(namespace), quote(name))
        }
        PrometheusTarget::Container {
            namespace,
            pod,
            container,
        } => format!(
            "namespace={},pod={},container={}",
            quote(namespace),
            quote(pod),
            quote(container)
        ),
    }
}

fn join(parts: &[&str]) -> String {
    parts
        .iter()
        .filter(|p| !p.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join(",")
}

/// `* on(instance, job) group_left(nodename) node_uname_info{nodename="n"}`:
/// keeps node-exporter series of one Kubernetes node.
fn on_node(name: &str) -> String {
    format!(
        "* on(instance, job) group_left(nodename) node_uname_info{{nodename={}}}",
        quote(name)
    )
}

fn requests(resource: &str, kind: &str, target: &PrometheusTarget) -> Option<String> {
    let scale = if resource == "cpu" { " * 1000" } else { "" };
    let selector = join(&[
        &format!("resource={}", quote(resource)),
        &pod_selector(target),
    ]);
    let series = format!("kube_pod_container_resource_{kind}{{{selector}}}");
    // Finished pods keep their series; one pod (or container) needs no filter.
    let inner = match target {
        PrometheusTarget::Pod { .. } | PrometheusTarget::Container { .. } => series,
        _ => format!("{series} {ACTIVE_PODS}"),
    };
    Some(format!("sum({inner}){scale}"))
}

/// The PromQL of `metric` for `target`, or `None` where it does not apply
/// (no network for a single container, no volume stats for a node, …).
/// `window` is the `rate()` range in seconds.
pub fn preset(target: &PrometheusTarget, metric: PrometheusMetric, window: u64) -> Option<String> {
    use PrometheusMetric as M;
    use PrometheusTarget as T;
    let w = format!("{window}s");
    let pods = pod_selector(target);
    let containers = join(&[CONTAINERS, &pods]);
    let per_pod = matches!(
        target,
        T::Namespace { .. } | T::Workload { .. } | T::Pod { .. } | T::Container { .. }
    );
    let query = match (metric, target) {
        (M::CpuUsage, T::Cluster) => format!(
            "sum(rate(node_cpu_seconds_total{{{NON_IDLE_CPU}}}[{w}])) * 1000 \
             or sum(rate(container_cpu_usage_seconds_total{{id=\"/\"}}[{w}])) * 1000 \
             or sum(rate(container_cpu_usage_seconds_total{{{CONTAINERS}}}[{w}])) * 1000"
        ),
        (M::CpuUsage, T::Node { name }) => format!(
            "sum(rate(node_cpu_seconds_total{{{NON_IDLE_CPU}}}[{w}]) {}) * 1000 \
             or sum(rate(container_cpu_usage_seconds_total{{id=\"/\",node={}}}[{w}])) * 1000",
            on_node(name),
            quote(name)
        ),
        (M::CpuUsage, _) if per_pod => {
            format!("sum(rate(container_cpu_usage_seconds_total{{{containers}}}[{w}])) * 1000")
        }

        (M::MemoryUsage, T::Cluster) => format!(
            "sum(node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes) \
             or sum(container_memory_working_set_bytes{{id=\"/\"}}) \
             or sum(container_memory_working_set_bytes{{{CONTAINERS}}})"
        ),
        (M::MemoryUsage, T::Node { name }) => format!(
            "sum((node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes) {}) \
             or sum(container_memory_working_set_bytes{{id=\"/\",node={}}})",
            on_node(name),
            quote(name)
        ),
        (M::MemoryUsage, _) if per_pod => {
            format!("sum(container_memory_working_set_bytes{{{containers}}})")
        }

        (M::CpuRequests, T::Pvc { .. }) | (M::CpuLimits, T::Pvc { .. }) => return None,
        (M::MemoryRequests, T::Pvc { .. }) | (M::MemoryLimits, T::Pvc { .. }) => return None,
        (M::CpuRequests, _) => return requests("cpu", "requests", target),
        (M::CpuLimits, _) => return requests("cpu", "limits", target),
        (M::MemoryRequests, _) => return requests("memory", "requests", target),
        (M::MemoryLimits, _) => return requests("memory", "limits", target),

        (M::NetworkRx | M::NetworkTx, T::Cluster) => {
            let dir = direction(metric);
            format!(
                "sum(rate(node_network_{dir}_bytes_total{{device!~\"{VIRTUAL_DEVICES}\"}}[{w}])) \
                 or sum(rate(container_network_{dir}_bytes_total{{id=\"/\"}}[{w}]))"
            )
        }
        (M::NetworkRx | M::NetworkTx, T::Node { name }) => {
            let dir = direction(metric);
            format!(
                "sum(rate(node_network_{dir}_bytes_total{{device!~\"{VIRTUAL_DEVICES}\"}}[{w}]) {}) \
                 or sum(rate(container_network_{dir}_bytes_total{{id=\"/\",node={}}}[{w}]))",
                on_node(name),
                quote(name)
            )
        }
        // Network is accounted per pod (sandbox), not per container.
        (M::NetworkRx | M::NetworkTx, T::Namespace { .. } | T::Workload { .. } | T::Pod { .. }) => {
            format!(
                "sum(rate(container_network_{}_bytes_total{{{pods}}}[{w}]))",
                direction(metric)
            )
        }

        (M::FsUsage, T::Cluster) => format!(
            "sum(max by (instance, device) (node_filesystem_size_bytes{{{REAL_FS}}} \
             - node_filesystem_avail_bytes{{{REAL_FS}}}))"
        ),
        (M::FsCapacity, T::Cluster) => {
            format!("sum(max by (instance, device) (node_filesystem_size_bytes{{{REAL_FS}}}))")
        }
        (M::FsUsage, T::Node { name }) => format!(
            "sum(max by (instance, job, device) (node_filesystem_size_bytes{{{REAL_FS}}} \
             - node_filesystem_avail_bytes{{{REAL_FS}}}) {})",
            on_node(name)
        ),
        (M::FsCapacity, T::Node { name }) => format!(
            "sum(max by (instance, job, device) (node_filesystem_size_bytes{{{REAL_FS}}}) {})",
            on_node(name)
        ),
        // Writable layers and logs of the containers (ephemeral storage).
        (M::FsUsage, _) if per_pod => format!("sum(container_fs_usage_bytes{{{containers}}})"),

        (M::VolumeUsage | M::VolumeCapacity, T::Pvc { namespace, name }) => format!(
            "sum(kubelet_volume_stats_{}_bytes{{namespace={},persistentvolumeclaim={}}})",
            volume_stat(metric),
            quote(namespace),
            quote(name)
        ),
        // Volumes of the pods: claims they mount, through kube-state-metrics.
        (M::VolumeUsage | M::VolumeCapacity, T::Namespace { namespace }) => format!(
            "sum(kubelet_volume_stats_{}_bytes{{namespace={}}})",
            volume_stat(metric),
            quote(namespace)
        ),
        (M::VolumeUsage | M::VolumeCapacity, T::Workload { .. } | T::Pod { .. }) => format!(
            "sum(kubelet_volume_stats_{}_bytes * on(namespace, persistentvolumeclaim) group_left() \
             max by (namespace, persistentvolumeclaim) (kube_pod_spec_volumes_persistentvolumeclaims_info{{{pods}}}))",
            volume_stat(metric)
        ),

        (M::Restarts, T::Pvc { .. }) => return None,
        (M::Restarts, T::Node { name }) => format!(
            "sum(increase(kube_pod_container_status_restarts_total[{w}]) \
             * on(namespace, pod) group_left() max by (namespace, pod) (kube_pod_info{{node={}}}))",
            quote(name)
        ),
        (M::Restarts, _) => {
            let selector = pods;
            format!("sum(increase(kube_pod_container_status_restarts_total{{{selector}}}[{w}]))")
        }

        _ => return None,
    };
    Some(query.replace("{}", ""))
}

fn direction(metric: PrometheusMetric) -> &'static str {
    match metric {
        PrometheusMetric::NetworkTx => "transmit",
        _ => "receive",
    }
}

fn volume_stat(metric: PrometheusMetric) -> &'static str {
    match metric {
        PrometheusMetric::VolumeCapacity => "capacity",
        _ => "used",
    }
}

/// The metrics a target's charts use, in display order.
pub fn default_metrics(target: &PrometheusTarget) -> Vec<PrometheusMetric> {
    use PrometheusMetric as M;
    let all = [
        M::CpuUsage,
        M::CpuRequests,
        M::CpuLimits,
        M::MemoryUsage,
        M::MemoryRequests,
        M::MemoryLimits,
        M::NetworkRx,
        M::NetworkTx,
        M::FsUsage,
        M::FsCapacity,
        M::VolumeUsage,
        M::VolumeCapacity,
        M::Restarts,
    ];
    all.into_iter()
        .filter(|&m| preset(target, m, 60).is_some())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use PrometheusMetric as M;

    fn pod() -> PrometheusTarget {
        PrometheusTarget::Pod {
            namespace: "shop".into(),
            name: "web-7d9f8-abcde".into(),
        }
    }

    fn balanced(q: &str) -> bool {
        let mut depth = 0i32;
        let mut in_string = false;
        let mut prev = ' ';
        for ch in q.chars() {
            match ch {
                '"' if prev != '\\' => in_string = !in_string,
                '(' | '{' | '[' if !in_string => depth += 1,
                ')' | '}' | ']' if !in_string => depth -= 1,
                _ => {}
            }
            if depth < 0 {
                return false;
            }
            prev = ch;
        }
        depth == 0 && !in_string
    }

    #[test]
    fn quoting_and_regex_escaping() {
        assert_eq!(quote(r#"a"b\c"#), r#""a\"b\\c""#);
        assert_eq!(regex_escape("web.v2"), r"web\.v2");
        // `.` in a name is escaped twice: once for RE2, once for the PromQL string.
        assert_eq!(quote(&regex_escape("a.b")), r#""a\\.b""#);
    }

    #[test]
    fn workload_regexes_count_segments() {
        let re = |kind: &str, name: &str| {
            regex::Regex::new(&format!("^(?:{})$", workload_pod_regex(kind, name))).unwrap()
        };
        let deploy = re("Deployment", "web");
        assert!(deploy.is_match("web-7d9f8c6b5-x2x9z"));
        assert!(
            !deploy.is_match("web-api-7d9f8c6b5-x2x9z"),
            "another deployment"
        );
        assert!(!deploy.is_match("web-x2x9z"));
        let sts = re("StatefulSet", "db");
        assert!(sts.is_match("db-0") && sts.is_match("db-12"));
        assert!(!sts.is_match("db-backup-0"));
        let ds = re("DaemonSet", "node-exporter");
        assert!(ds.is_match("node-exporter-x2x9z"));
        let cron = re("CronJob", "report");
        assert!(cron.is_match("report-28730160-x2x9z"));
        let dotted = re("Job", "a.b");
        assert!(dotted.is_match("a.b-x2x9z"));
        assert!(!dotted.is_match("axb-x2x9z"), "dots are literal");
        assert!(re("Something", "x").is_match("x-anything-here"));
    }

    #[test]
    fn pod_presets_select_the_pod_containers() {
        let cpu = preset(&pod(), M::CpuUsage, 120).unwrap();
        assert_eq!(
            cpu,
            r#"sum(rate(container_cpu_usage_seconds_total{container!="",container!="POD",namespace="shop",pod="web-7d9f8-abcde"}[120s])) * 1000"#
        );
        let mem = preset(&pod(), M::MemoryRequests, 120).unwrap();
        assert_eq!(
            mem,
            r#"sum(kube_pod_container_resource_requests{resource="memory",namespace="shop",pod="web-7d9f8-abcde"})"#
        );
        let rx = preset(&pod(), M::NetworkRx, 150).unwrap();
        assert_eq!(
            rx,
            r#"sum(rate(container_network_receive_bytes_total{namespace="shop",pod="web-7d9f8-abcde"}[150s]))"#
        );
        let restarts = preset(&pod(), M::Restarts, 120).unwrap();
        assert!(restarts.starts_with(
            "sum(increase(kube_pod_container_status_restarts_total{namespace=\"shop\""
        ));
    }

    #[test]
    fn cluster_and_node_presets() {
        let cpu = preset(&PrometheusTarget::Cluster, M::CpuUsage, 120).unwrap();
        assert!(cpu.contains(r#"node_cpu_seconds_total{mode!~"idle|iowait|steal"}[120s]"#));
        assert!(cpu.contains(" or "), "falls back to cAdvisor");
        let req = preset(&PrometheusTarget::Cluster, M::CpuRequests, 120).unwrap();
        assert!(req.starts_with(
            r#"sum(kube_pod_container_resource_requests{resource="cpu"} * on(namespace, pod)"#
        ));
        assert!(req.ends_with(") * 1000"));
        let node = PrometheusTarget::Node {
            name: "ip-10-0-1-2.ec2.internal".into(),
        };
        let mem = preset(&node, M::MemoryUsage, 120).unwrap();
        assert!(mem.contains(r#"node_uname_info{nodename="ip-10-0-1-2.ec2.internal"}"#));
        let req = preset(&node, M::CpuRequests, 120).unwrap();
        assert!(req.contains(r#"{resource="cpu",node="ip-10-0-1-2.ec2.internal"}"#));
        let fs = preset(&node, M::FsCapacity, 120).unwrap();
        assert!(fs.contains("node_filesystem_size_bytes"));
        assert!(preset(&node, M::VolumeUsage, 120).is_none());
    }

    #[test]
    fn workload_and_pvc_presets() {
        let web = PrometheusTarget::Workload {
            namespace: "shop".into(),
            workload_kind: "Deployment".into(),
            name: "web".into(),
        };
        let cpu = preset(&web, M::CpuUsage, 120).unwrap();
        assert!(cpu.contains(r#"namespace="shop",pod=~"web-[a-z0-9]+-[a-z0-9]+""#));
        let vol = preset(&web, M::VolumeUsage, 120).unwrap();
        assert!(vol.contains(
            "kube_pod_spec_volumes_persistentvolumeclaims_info{namespace=\"shop\",pod=~"
        ));

        let pvc = PrometheusTarget::Pvc {
            namespace: "db".into(),
            name: "data-pg-0".into(),
        };
        assert_eq!(
            preset(&pvc, M::VolumeCapacity, 120).unwrap(),
            r#"sum(kubelet_volume_stats_capacity_bytes{namespace="db",persistentvolumeclaim="data-pg-0"})"#
        );
        assert_eq!(
            default_metrics(&pvc),
            vec![M::VolumeUsage, M::VolumeCapacity]
        );
        let container = PrometheusTarget::Container {
            namespace: "shop".into(),
            pod: "web-1".into(),
            container: "app".into(),
        };
        assert!(preset(&container, M::NetworkRx, 120).is_none());
        assert!(preset(&container, M::CpuLimits, 120)
            .unwrap()
            .contains(r#"container="app""#));
    }

    #[test]
    fn every_preset_is_balanced_and_braces_are_never_empty() {
        let targets = [
            PrometheusTarget::Cluster,
            PrometheusTarget::Node { name: "n1".into() },
            PrometheusTarget::Namespace {
                namespace: "shop".into(),
            },
            PrometheusTarget::Workload {
                namespace: "shop".into(),
                workload_kind: "StatefulSet".into(),
                name: "db".into(),
            },
            pod(),
            PrometheusTarget::Container {
                namespace: "shop".into(),
                pod: "web-1".into(),
                container: "app".into(),
            },
            PrometheusTarget::Pvc {
                namespace: "db".into(),
                name: "data".into(),
            },
        ];
        for target in &targets {
            let metrics = default_metrics(target);
            assert!(!metrics.is_empty(), "{target:?}");
            for metric in metrics {
                let q = preset(target, metric, 120).unwrap();
                assert!(balanced(&q), "{target:?} {metric:?}: {q}");
                assert!(!q.contains("{}"), "{q}");
                assert!(!q.contains(",,") && !q.contains("{,"), "{q}");
                assert!(!q.contains("  "), "{q}");
            }
        }
    }
}
