use std::future::Future;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use futures::{stream, AsyncReadExt, StreamExt};
use k8s_openapi::api::{
    batch::v1::Job,
    core::v1::{Event, Pod},
};
use kube::{
    api::{ApiResource, DynamicObject, ListParams, LogParams},
    Api, Client,
};
use serde_json::{json, Value};
use tokio::time::Instant;

use super::storage::{limit_content, safe_text, safe_value};
use super::*;
use crate::{
    change_journal::ChangeFilter,
    error::{api_code, kube_error},
    types::MetricsHistoryQuery,
    Kubepit,
};

const MAX_PODS: usize = 3;
const MAX_CONTAINERS: usize = 2;
const MAX_LOG_LINES: i64 = 200;
const MAX_CAPTURE_BYTES: usize = 480 * 1024;

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 253
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value
            .as_bytes()
            .last()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
}

fn valid_request(request: &InvestigationCaptureRequest) -> Result<()> {
    let expected = match request.gvk.kind.as_str() {
        "Pod" => ("", "pods"),
        "Deployment" => ("apps", "deployments"),
        "StatefulSet" => ("apps", "statefulsets"),
        "DaemonSet" => ("apps", "daemonsets"),
        "ReplicaSet" => ("apps", "replicasets"),
        "Job" => ("batch", "jobs"),
        "CronJob" => ("batch", "cronjobs"),
        _ => bail!("investigations:unsupported-target"),
    };
    if request.gvk.group != expected.0
        || request.gvk.plural != expected.1
        || request.gvk.version != "v1"
        || !request.gvk.namespaced
        || !identifier(&request.name)
        || !identifier(&request.namespace)
        || !matches!(request.lookback_minutes, 15 | 60)
    {
        bail!("investigations:invalid-data");
    }
    validate_text(&request.title, MAX_TITLE_BYTES, true)
}

fn reason(error: &anyhow::Error) -> EvidenceReason {
    match api_code(error) {
        Some(401 | 403) => EvidenceReason::Forbidden,
        Some(404) => EvidenceReason::NotFound,
        Some(503) => EvidenceReason::NotAvailable,
        _ => EvidenceReason::RequestFailed,
    }
}

async fn bounded<T>(
    deadline: Instant,
    work: impl Future<Output = Result<T>>,
) -> Result<T, EvidenceReason> {
    match tokio::time::timeout_at(deadline.min(Instant::now() + Duration::from_secs(5)), work).await
    {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(reason(&error)),
        Err(_) => Err(EvidenceReason::Timeout),
    }
}

fn unavailable(
    id: &str,
    kind: EvidenceKind,
    label: &str,
    reason: EvidenceReason,
) -> InvestigationEvidence {
    InvestigationEvidence {
        id: id.into(),
        kind,
        label: safe_text(label),
        status: EvidenceStatus::Unavailable,
        format: EvidenceFormat::Text,
        content: String::new(),
        reason: Some(reason),
    }
}

fn evidence(
    id: &str,
    kind: EvidenceKind,
    label: &str,
    value: Value,
    empty: bool,
    truncated: bool,
) -> InvestigationEvidence {
    let mut content = if empty {
        String::new()
    } else {
        serde_yaml::to_string(&safe_value(&value)).unwrap_or_default()
    };
    let truncated = limit_content(&mut content) || truncated;
    InvestigationEvidence {
        id: id.into(),
        kind,
        label: safe_text(label),
        status: if truncated {
            EvidenceStatus::Truncated
        } else if empty {
            EvidenceStatus::Empty
        } else {
            EvidenceStatus::Captured
        },
        format: if truncated {
            EvidenceFormat::Text
        } else {
            EvidenceFormat::Yaml
        },
        content,
        reason: truncated.then_some(EvidenceReason::CaptureLimit),
    }
}

fn timestamp(value: &Value) -> Option<i64> {
    [
        "/lastTimestamp",
        "/series/lastObservedTime",
        "/eventTime",
        "/metadata/creationTimestamp",
    ]
    .iter()
    .filter_map(|path| value.pointer(path).and_then(Value::as_str))
    .find_map(|value| {
        chrono::DateTime::parse_from_rfc3339(value)
            .ok()
            .map(|date| date.timestamp_millis())
    })
}

/// Only request a bounded first page. The UI calls this a sample, never
/// a complete inventory. CronJobs use their latest owned Job, not labels
/// shared with unrelated scheduled jobs.
async fn pods_for(
    client: Client,
    request: &InvestigationCaptureRequest,
    object: &Value,
) -> Result<(Vec<Value>, bool), EvidenceReason> {
    if request.gvk.kind == "Pod" {
        return Ok((vec![object.clone()], false));
    }
    let mut sampled = false;
    let selector = if request.gvk.kind == "CronJob" {
        let uid = object
            .pointer("/metadata/uid")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let api: Api<Job> = Api::namespaced(client.clone(), &request.namespace);
        let list = api
            .list(&ListParams::default().limit(100))
            .await
            .map_err(|error| reason(&kube_error(error)))?;
        sampled = list
            .metadata
            .continue_
            .as_deref()
            .is_some_and(|value| !value.is_empty());
        let mut jobs: Vec<_> = list
            .items
            .into_iter()
            .filter(|job| {
                job.metadata
                    .owner_references
                    .as_ref()
                    .is_some_and(|refs| refs.iter().any(|owner| owner.uid == uid))
            })
            .collect();
        jobs.sort_by(|a, b| {
            b.metadata
                .creation_timestamp
                .cmp(&a.metadata.creation_timestamp)
        });
        sampled |= jobs.len() > 1;
        let Some(job) = jobs.first() else {
            return Ok((Vec::new(), sampled));
        };
        job.spec
            .as_ref()
            .and_then(|spec| spec.selector.as_ref())
            .and_then(|selector| serde_json::to_value(selector).ok())
            .and_then(|value| crate::rollout::label_selector(&value))
    } else {
        object
            .pointer("/spec/selector")
            .and_then(crate::rollout::label_selector)
    };
    let Some(selector) = selector else {
        return Err(EvidenceReason::NoSelector);
    };
    let api: Api<Pod> = Api::namespaced(client, &request.namespace);
    let list = api
        .list(
            &ListParams::default()
                .labels(&selector)
                .limit((MAX_PODS + 1) as u32),
        )
        .await
        .map_err(|error| reason(&kube_error(error)))?;
    sampled |= list.items.len() > MAX_PODS
        || list
            .metadata
            .continue_
            .as_deref()
            .is_some_and(|value| !value.is_empty());
    let pods = list
        .items
        .into_iter()
        .take(MAX_PODS)
        .map(serde_json::to_value)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| EvidenceReason::RequestFailed)?;
    Ok((pods, sampled))
}

impl Kubepit {
    /// One user-initiated snapshot. Reads remain allowed for read-only
    /// clusters; captures never exec, create helper pods or start watchers.
    pub async fn investigation_capture(
        &self,
        cluster_id: &str,
        request: InvestigationCaptureRequest,
    ) -> Result<Investigation> {
        valid_request(&request)?;
        let deadline = Instant::now() + Duration::from_secs(25);
        let cluster = self.cluster_def(cluster_id)?;
        let client = self
            .pool
            .connected_client(cluster_id)
            .context("investigations:disconnected")?;
        let captured_at = now();
        let since = captured_at - i64::from(request.lookback_minutes) * 60_000;
        let label = format!("{}/{}", request.gvk.kind, request.name);
        let ar = crate::objects::api_resource(&request.gvk);
        let object_api: Api<DynamicObject> =
            Api::namespaced_with(client.clone(), &request.namespace, &ar);
        let object = bounded(deadline, async {
            object_api
                .get(&request.name)
                .await
                .map(|object| crate::objects::to_kube_object(object, &ar))
                .map_err(kube_error)
        })
        .await;
        let mut all = Vec::new();
        let mut pods = Vec::new();
        match &object {
            Ok(object) => {
                all.push(evidence(
                    "object",
                    EvidenceKind::Object,
                    &label,
                    object.clone(),
                    false,
                    false,
                ));
                let selected = tokio::time::timeout_at(
                    deadline.min(Instant::now() + Duration::from_secs(5)),
                    pods_for(client.clone(), &request, object),
                )
                .await;
                match selected {
                    Ok(Ok((selected, truncated))) => {
                        all.push(evidence(
                            "pods",
                            EvidenceKind::Pods,
                            &request.namespace,
                            json!(selected),
                            selected.is_empty(),
                            truncated,
                        ));
                        pods = selected;
                    }
                    result => {
                        let why = match result {
                            Ok(Err(why)) => why,
                            _ => EvidenceReason::Timeout,
                        };
                        all.push(unavailable(
                            "pods",
                            EvidenceKind::Pods,
                            &request.namespace,
                            why,
                        ));
                    }
                }
            }
            Err(why) => {
                all.push(unavailable(
                    "object",
                    EvidenceKind::Object,
                    &label,
                    why.clone(),
                ));
                all.push(unavailable(
                    "pods",
                    EvidenceKind::Pods,
                    &request.namespace,
                    why.clone(),
                ));
            }
        }

        // Events for the chosen object and the sampled pods, deduplicated
        // by UID. Capturing a deleted/forbidden object still saves a useful
        // record with explicit gaps rather than inventing an empty result.
        let mut targets = Vec::new();
        if let Ok(object) = &object {
            targets.push(object.clone());
        }
        for pod in &pods {
            if !targets
                .iter()
                .any(|value| value.pointer("/metadata/uid") == pod.pointer("/metadata/uid"))
            {
                targets.push(pod.clone());
            }
        }
        if targets.is_empty() {
            all.push(unavailable(
                "events",
                EvidenceKind::Events,
                &label,
                EvidenceReason::NotAvailable,
            ));
        } else {
            let event_results =
                stream::iter(targets.into_iter().enumerate().map(|(index, target)| {
                    let api: Api<Event> = Api::namespaced(client.clone(), &request.namespace);
                    let uid = target
                        .pointer("/metadata/uid")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let name = target
                        .pointer("/metadata/name")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    async move {
                        let id = format!("events-{index}");
                        if !identifier(&uid) {
                            return unavailable(
                                &id,
                                EvidenceKind::Events,
                                &name,
                                EvidenceReason::NotAvailable,
                            );
                        }
                        let result = bounded(deadline, async {
                            api.list(
                                &ListParams::default()
                                    .fields(&format!("involvedObject.uid={uid}"))
                                    .limit(100),
                            )
                            .await
                            .map_err(kube_error)
                        })
                        .await;
                        match result {
                            Ok(list) => {
                                let mut events: Vec<Value> = list
                                    .items
                                    .into_iter()
                                    .filter_map(|value| serde_json::to_value(value).ok())
                                    .filter(|value| {
                                        timestamp(value)
                                            .is_none_or(|ts| ts >= since && ts <= captured_at)
                                    })
                                    .collect();
                                events.sort_by_key(|value| std::cmp::Reverse(timestamp(value)));
                                let truncated = events.len() > 50
                                    || list
                                        .metadata
                                        .continue_
                                        .as_deref()
                                        .is_some_and(|value| !value.is_empty());
                                events.truncate(50);
                                evidence(
                                    &id,
                                    EvidenceKind::Events,
                                    &name,
                                    json!(events),
                                    events.is_empty(),
                                    truncated,
                                )
                            }
                            Err(why) => unavailable(&id, EvidenceKind::Events, &name, why),
                        }
                    }
                }))
                .buffered(4)
                .collect::<Vec<_>>()
                .await;
            all.extend(event_results);
        }

        let mut log_targets = Vec::new();
        for pod in &pods {
            let name = pod
                .pointer("/metadata/name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            for container in pod
                .pointer("/spec/containers")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .take(MAX_CONTAINERS)
            {
                let container = container
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if !identifier(name) || !identifier(container) {
                    continue;
                }
                log_targets.push((name.to_string(), container.to_string(), false));
                if pod
                    .pointer("/status/containerStatuses")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .any(|status| {
                        status.get("name").and_then(Value::as_str) == Some(container)
                            && status
                                .get("restartCount")
                                .and_then(Value::as_u64)
                                .unwrap_or(0)
                                > 0
                    })
                {
                    log_targets.push((name.to_string(), container.to_string(), true));
                }
            }
        }
        if log_targets.is_empty() {
            all.push(unavailable(
                "logs",
                EvidenceKind::Logs,
                &label,
                EvidenceReason::NoPods,
            ));
        } else {
            let results = stream::iter(log_targets.into_iter().enumerate().map(
                |(index, (pod, container, previous))| {
                    let namespace = request.namespace.clone();
                    let api: Api<Pod> = Api::namespaced(client.clone(), &namespace);
                    let lookback = request.lookback_minutes;
                    async move {
                        let id = format!("logs-{index}");
                        let label = format!(
                            "{pod}/{container}{}",
                            if previous { "#previous" } else { "" }
                        );
                        match bounded(
                            deadline,
                            log_tail(&api, &pod, &container, previous, lookback),
                        )
                        .await
                        {
                            Ok(tail) => {
                                let filtered = filter_logs(&tail.text, since, captured_at);
                                let mut content = safe_text(&filtered);
                                let truncated = limit_content(&mut content)
                                    || tail.cut
                                    || tail.text.lines().count() >= MAX_LOG_LINES as usize;
                                InvestigationEvidence {
                                    id,
                                    kind: EvidenceKind::Logs,
                                    label,
                                    status: if truncated {
                                        EvidenceStatus::Truncated
                                    } else if content.is_empty() {
                                        EvidenceStatus::Empty
                                    } else {
                                        EvidenceStatus::Captured
                                    },
                                    format: EvidenceFormat::Text,
                                    content,
                                    reason: truncated.then_some(EvidenceReason::CaptureLimit),
                                }
                            }
                            Err(why) => unavailable(&id, EvidenceKind::Logs, &label, why),
                        }
                    }
                },
            ))
            .buffered(4)
            .collect::<Vec<_>>()
            .await;
            all.extend(results);
            if pods.iter().any(|pod| {
                pod.pointer("/spec/containers")
                    .and_then(Value::as_array)
                    .is_some_and(|containers| containers.len() > MAX_CONTAINERS)
                    || pod
                        .pointer("/spec/initContainers")
                        .and_then(Value::as_array)
                        .is_some_and(|containers| !containers.is_empty())
            }) {
                all.push(unavailable(
                    "logs-other-containers",
                    EvidenceKind::Logs,
                    &label,
                    EvidenceReason::CaptureLimit,
                ));
            }
        }

        let filter = ChangeFilter {
            namespaces: vec![request.namespace.clone()],
            kinds: vec![request.gvk.kind.clone()],
            name: Some(request.name.clone()),
            since: Some(since),
            until: Some(captured_at),
            limit: 10,
            ..Default::default()
        };
        match self.changes_list(cluster_id, &filter) {
            Ok(page) if page.status.recording => {
                // Before/after objects are re-redacted as structured values;
                // never store arbitrary journal path snippets as credentials.
                let changes: Vec<_> = page.entries.iter().map(|entry| {
                    let detail = self.changes_get(cluster_id, entry.id).ok();
                    let yaml_value = |text: Option<String>| text.and_then(|text| serde_yaml::from_str::<Value>(&text).ok()).map(|value| safe_value(&value));
                    json!({"ts":entry.ts,"operation":entry.op,"actor":entry.actor,"before":detail.as_ref().and_then(|d| yaml_value(d.before_yaml.clone())),"after":detail.as_ref().and_then(|d| yaml_value(d.after_yaml.clone()))})
                }).collect();
                let incomplete = page.next_cursor.is_some()
                    || !page.status.synced
                    || page.status.started_at.is_some_and(|ts| ts > since);
                all.push(evidence(
                    "changes",
                    EvidenceKind::Changes,
                    &label,
                    json!(changes),
                    changes.is_empty(),
                    incomplete,
                ));
            }
            Ok(_) => all.push(unavailable(
                "changes",
                EvidenceKind::Changes,
                &label,
                EvidenceReason::NotRecording,
            )),
            Err(error) => all.push(unavailable(
                "changes",
                EvidenceKind::Changes,
                &label,
                reason(&error),
            )),
        }

        let names: Vec<_> = pods
            .iter()
            .filter_map(|pod| {
                pod.pointer("/metadata/name")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .collect();
        if names.is_empty() {
            all.push(unavailable(
                "metrics",
                EvidenceKind::Metrics,
                &label,
                EvidenceReason::NoPods,
            ));
        } else {
            let history = self
                .metrics_history(
                    cluster_id,
                    &MetricsHistoryQuery::Pods {
                        namespace: request.namespace.clone(),
                        names: names.clone(),
                    },
                )
                .ok();
            let points: Vec<_> = history
                .into_iter()
                .flat_map(|series| series.points)
                .filter(|point| point.ts >= since && point.ts <= captured_at)
                .collect();
            if !points.is_empty() {
                all.push(evidence(
                    "metrics",
                    EvidenceKind::Metrics,
                    &label,
                    json!({"source":"metrics-server/history","pods":names,"points":points}),
                    false,
                    false,
                ));
            } else {
                let ar = ApiResource {
                    group: "metrics.k8s.io".into(),
                    version: "v1beta1".into(),
                    api_version: "metrics.k8s.io/v1beta1".into(),
                    kind: "PodMetrics".into(),
                    plural: "pods".into(),
                };
                let api: Api<DynamicObject> =
                    Api::namespaced_with(client.clone(), &request.namespace, &ar);
                let results = stream::iter(names.clone().into_iter().map(|name| {
                    let api = api.clone();
                    bounded(
                        deadline,
                        async move { api.get(&name).await.map_err(kube_error) },
                    )
                }))
                .buffered(3)
                .collect::<Vec<_>>()
                .await;
                let mut values = Vec::new();
                let mut missing = None;
                for result in results {
                    match result {
                        Ok(value) => values.push(serde_json::to_value(value)?),
                        Err(why) => missing = Some(why),
                    }
                }
                if values.is_empty() {
                    all.push(unavailable(
                        "metrics",
                        EvidenceKind::Metrics,
                        &label,
                        missing.unwrap_or(EvidenceReason::NotAvailable),
                    ));
                } else {
                    all.push(evidence(
                        "metrics",
                        EvidenceKind::Metrics,
                        &label,
                        json!({"source":"metrics-server/current","pods":values}),
                        false,
                        missing.is_some(),
                    ));
                }
            }
        }

        let mut bytes = 0;
        for evidence in &mut all {
            // Includes JSON escaping overhead in the actual bundle budget.
            let size = serde_json::to_vec(evidence)?.len();
            if bytes + size > MAX_CAPTURE_BYTES {
                evidence.content.clear();
                evidence.status = EvidenceStatus::Unavailable;
                evidence.reason = Some(EvidenceReason::CaptureLimit);
            } else {
                bytes += size;
            }
        }
        let mut record = Investigation {
            version: 1,
            id: uuid::Uuid::new_v4().to_string(),
            title: request.title.trim().into(),
            cluster_id: Some(cluster_id.into()),
            cluster_name: safe_text(&cluster.name),
            target: InvestigationTarget {
                api_version: request.gvk.api_version(),
                kind: request.gvk.kind,
                namespace: request.namespace,
                name: request.name,
            },
            captured_at,
            updated_at: now(),
            imported: false,
            evidence_count: 0,
            incomplete_count: 0,
            notes: String::new(),
            lookback_minutes: request.lookback_minutes,
            evidence: all,
        };
        record.refresh_counts();
        self.save_investigation(record)
    }
}

async fn log_tail(
    api: &Api<Pod>,
    pod: &str,
    container: &str,
    previous: bool,
    lookback: u32,
) -> Result<crate::logs::LogTail> {
    let params = LogParams {
        container: Some(container.into()),
        follow: false,
        previous,
        timestamps: true,
        tail_lines: Some(MAX_LOG_LINES),
        since_seconds: Some(i64::from(lookback) * 60),
        limit_bytes: Some(MAX_EVIDENCE_BYTES as i64),
        ..Default::default()
    };
    let reader = api.log_stream(pod, &params).await.map_err(kube_error)?;
    let mut bytes = Vec::new();
    Box::pin(reader)
        .take(MAX_EVIDENCE_BYTES as u64)
        .read_to_end(&mut bytes)
        .await?;
    let cut = bytes.len() >= MAX_EVIDENCE_BYTES;
    let mut utf8 = crate::logs::Utf8Accumulator::default();
    utf8.push(&bytes);
    Ok(crate::logs::LogTail {
        text: utf8.take_complete(),
        tail_lines: MAX_LOG_LINES,
        cut,
    })
}

fn filter_logs(text: &str, since: i64, until: i64) -> String {
    let mut include = true;
    text.lines()
        .filter(|line| {
            if let Some(ts) = line
                .split_whitespace()
                .next()
                .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
            {
                include = ts.timestamp_millis() >= since && ts.timestamp_millis() <= until;
            }
            include
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn log_window_keeps_unstamped_continuations_and_excludes_other_times() {
        let since = chrono::DateTime::parse_from_rfc3339("2026-10-01T12:00:00Z")
            .unwrap()
            .timestamp_millis();
        let result = filter_logs("2026-10-01T11:00:00Z old\n  old stack frame\n2026-10-01T12:00:01Z new\n  at foo\n2026-10-01T13:00:00Z future", since, since + 60_000);
        assert_eq!(result, "2026-10-01T12:00:01Z new\n  at foo");
    }
    #[test]
    fn request_rejects_secret_targets_and_path_injection() {
        let mut request = InvestigationCaptureRequest {
            gvk: Gvk {
                group: "".into(),
                version: "v1".into(),
                kind: "Pod".into(),
                plural: "pods".into(),
                namespaced: true,
            },
            namespace: "default".into(),
            name: "api".into(),
            title: "Check".into(),
            lookback_minutes: 15,
        };
        assert!(valid_request(&request).is_ok());
        request.name = "..".into();
        assert!(valid_request(&request).is_err());
        request.name = "api".into();
        request.gvk.plural = "pods/../../secrets".into();
        assert!(valid_request(&request).is_err());
        request.gvk.kind = "Secret".into();
        assert!(valid_request(&request).is_err());
    }
}
