//! Pod → workload resolution from kube-state-metrics owner series.
//!
//! Three indexes, keyed by `(namespace, subject)`:
//!
//! - pods, from `kube_pod_owner` (subject label `pod`);
//! - ReplicaSets, from `kube_replicaset_owner` (`replicaset`);
//! - Jobs, from `kube_job_owner` (`job_name`).
//!
//! An owner that is empty or `<none>` (kube-state-metrics' spelling of "no
//! owner"), or that is not the controller (`owner_is_controller="false"`),
//! is dropped. [`OwnerIndex::resolve`] then follows at most one hop:
//! ReplicaSet → Deployment and Job → CronJob. StatefulSets and DaemonSets
//! own their pods directly; any other kind (`Node` for static pods,
//! `Rollout`, custom controllers) is unsupported. A pod name owned by more
//! than one owner within the window is ambiguous: its samples cannot be
//! attributed, so the caller flags every candidate instead of mixing them.
//!
//! The index also remembers which namespaces the ReplicaSet and Job owner
//! queries answered for at all (`<none>` owners included), so a missing
//! parent can be told apart from a missing answer
//! ([`OwnerIndex::missing_parent_series`]).

use std::collections::{BTreeSet, HashMap, HashSet};

use crate::prometheus::parse::PromData;

/// Who a pod name belongs to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Owner {
    /// A workload kind right-sizing knows (Deployment, StatefulSet,
    /// DaemonSet, CronJob).
    Workload { kind: String, name: String },
    /// No controller: a bare pod, an orphan ReplicaSet or a standalone Job.
    Unowned,
    /// Owned through a kind right-sizing does not handle (`Node`, `Rollout`, …).
    Unsupported(String),
    /// More than one owner: `(kind, name)` candidates, resolved one hop where
    /// possible (ReplicaSet → Deployment, Job → CronJob), sorted.
    Ambiguous(Vec<(String, String)>),
}

type Key = (String, String);
type Owners = BTreeSet<(String, String)>;

/// Owner indexes of one or more query batches.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct OwnerIndex {
    pods: HashMap<Key, Owners>,
    replicasets: HashMap<Key, Owners>,
    jobs: HashMap<Key, Owners>,
    /// Namespaces with any `kube_replicaset_owner` / `kube_job_owner` series.
    replicaset_namespaces: HashSet<String>,
    job_namespaces: HashSet<String>,
}

/// kube-state-metrics' "no owner": an empty kind or name, or `<none>`.
pub fn is_none_owner(kind: &str, name: &str) -> bool {
    let none = |value: &str| {
        let value = value.trim();
        value.is_empty() || value == "<none>"
    };
    none(kind) || none(name)
}

/// `(namespace, subject)` → controller owners of one owner series vector,
/// and the namespaces it has any series for.
fn index(data: &PromData, subject: &str) -> (HashMap<Key, Owners>, HashSet<String>) {
    let mut out: HashMap<Key, Owners> = HashMap::new();
    let mut namespaces = HashSet::new();
    for series in &data.series {
        let label = |key: &str| series.labels.get(key).map(String::as_str).unwrap_or("");
        let (namespace, name) = (label("namespace"), label(subject));
        let (kind, owner) = (label("owner_kind"), label("owner_name"));
        if namespace.is_empty() || name.is_empty() {
            continue;
        }
        namespaces.insert(namespace.to_string());
        if is_none_owner(kind, owner) || label("owner_is_controller") == "false" {
            continue;
        }
        out.entry((namespace.to_string(), name.to_string()))
            .or_default()
            .insert((kind.to_string(), owner.to_string()));
    }
    (out, namespaces)
}

impl OwnerIndex {
    /// The indexes of the `pod_owners`, `replicaset_owners` and `job_owners`
    /// answers of one batch (an empty vector for a failed query).
    pub fn from_data(pods: &PromData, replicasets: &PromData, jobs: &PromData) -> Self {
        let (replicasets, replicaset_namespaces) = index(replicasets, "replicaset");
        let (jobs, job_namespaces) = index(jobs, "job_name");
        Self {
            pods: index(pods, "pod").0,
            replicasets,
            jobs,
            replicaset_namespaces,
            job_namespaces,
        }
    }

    /// Add the owners of another batch.
    pub fn merge(&mut self, other: OwnerIndex) {
        for (mine, theirs) in [
            (&mut self.pods, other.pods),
            (&mut self.replicasets, other.replicasets),
            (&mut self.jobs, other.jobs),
        ] {
            for (key, owners) in theirs {
                mine.entry(key).or_default().extend(owners);
            }
        }
        self.replicaset_namespaces
            .extend(other.replicaset_namespaces);
        self.job_namespaces.extend(other.job_namespaces);
    }

    /// No pod has an owner: kube-state-metrics is missing (or its owner
    /// series are), so pods must be matched by name instead.
    pub fn is_empty(&self) -> bool {
        self.pods.is_empty()
    }

    /// The parent kind (`Deployment` for a ReplicaSet, `CronJob` for a Job)
    /// when the pod's only owner is a ReplicaSet or Job without owner
    /// series, and the matching owner query (`replicaset_owners` /
    /// `job_owners`) answered nothing for the namespace: it failed or its
    /// metric is not collected. [`resolve`](Self::resolve) says `Unowned`,
    /// but the parent is unknown rather than absent, so the caller may match
    /// the pod by name among workloads of that kind.
    pub fn missing_parent_series(&self, namespace: &str, pod: &str) -> Option<&'static str> {
        let owners = self.pods.get(&(namespace.to_string(), pod.to_string()))?;
        let [(kind, name)] = owners.iter().collect::<Vec<_>>()[..] else {
            return None;
        };
        let (parents, answered, parent_kind) = match kind.as_str() {
            "ReplicaSet" => (&self.replicasets, &self.replicaset_namespaces, "Deployment"),
            "Job" => (&self.jobs, &self.job_namespaces, "CronJob"),
            _ => return None,
        };
        (!answered.contains(namespace)
            && !parents.contains_key(&(namespace.to_string(), name.clone())))
        .then_some(parent_kind)
    }

    /// The owner of pod name `pod` in `namespace`.
    pub fn resolve(&self, namespace: &str, pod: &str) -> Owner {
        let owners = match self.pods.get(&(namespace.to_string(), pod.to_string())) {
            Some(owners) if !owners.is_empty() => owners,
            _ => return Owner::Unowned,
        };
        if owners.len() > 1 {
            let resolved: Vec<(&(String, String), Owner)> = owners
                .iter()
                .map(|owner @ (kind, name)| (owner, self.resolve_owner(namespace, kind, name)))
                .collect();
            // Several owners of one workload (two ReplicaSets of one
            // Deployment) are no ambiguity.
            if let [(_, first @ Owner::Workload { .. }), rest @ ..] = &resolved[..] {
                if rest.iter().all(|(_, other)| other == first) {
                    return first.clone();
                }
            }
            let candidates: BTreeSet<(String, String)> = resolved
                .into_iter()
                .map(|((kind, name), owner)| match owner {
                    Owner::Workload { kind, name } => (kind, name),
                    _ => (kind.clone(), name.clone()),
                })
                .collect();
            return Owner::Ambiguous(candidates.into_iter().collect());
        }
        let (kind, name) = owners.iter().next().expect("one owner");
        self.resolve_owner(namespace, kind, name)
    }

    /// The workload behind a pod's single owner.
    fn resolve_owner(&self, namespace: &str, kind: &str, name: &str) -> Owner {
        match kind {
            "ReplicaSet" => parent(&self.replicasets, namespace, name, "Deployment"),
            "Job" => parent(&self.jobs, namespace, name, "CronJob"),
            "StatefulSet" | "DaemonSet" => Owner::Workload {
                kind: kind.to_string(),
                name: name.to_string(),
            },
            other => Owner::Unsupported(other.to_string()),
        }
    }
}

/// One hop up from a ReplicaSet or Job: `expected` is the only parent kind
/// right-sizing handles.
fn parent(index: &HashMap<Key, Owners>, namespace: &str, name: &str, expected: &str) -> Owner {
    let parents = match index.get(&(namespace.to_string(), name.to_string())) {
        Some(parents) if !parents.is_empty() => parents,
        _ => return Owner::Unowned,
    };
    if parents.len() > 1 {
        return Owner::Ambiguous(parents.iter().cloned().collect());
    }
    let (kind, name) = parents.iter().next().expect("one parent");
    if kind == expected {
        Owner::Workload {
            kind: kind.clone(),
            name: name.clone(),
        }
    } else {
        Owner::Unsupported(kind.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::PromQuerySeries;

    fn series(labels: &[(&str, &str)]) -> PromQuerySeries {
        PromQuerySeries {
            labels: labels
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            points: vec![(1_700_000_000_000, 1.0)],
        }
    }

    fn data(series: Vec<PromQuerySeries>) -> PromData {
        PromData {
            result_type: "vector".into(),
            series,
            warnings: Vec::new(),
        }
    }

    fn owned(subject: &str, ns: &str, name: &str, kind: &str, owner: &str) -> PromQuerySeries {
        series(&[
            ("namespace", ns),
            (subject, name),
            ("owner_kind", kind),
            ("owner_name", owner),
        ])
    }

    fn pod(ns: &str, name: &str, kind: &str, owner: &str) -> PromQuerySeries {
        owned("pod", ns, name, kind, owner)
    }

    fn rs(ns: &str, name: &str, kind: &str, owner: &str) -> PromQuerySeries {
        owned("replicaset", ns, name, kind, owner)
    }

    fn job(ns: &str, name: &str, kind: &str, owner: &str) -> PromQuerySeries {
        owned("job_name", ns, name, kind, owner)
    }

    fn workload(kind: &str, name: &str) -> Owner {
        Owner::Workload {
            kind: kind.into(),
            name: name.into(),
        }
    }

    fn index() -> OwnerIndex {
        let mut not_controller = pod("apps", "x", "ReplicaSet", "x-rs");
        not_controller
            .labels
            .insert("owner_is_controller".into(), "false".into());
        OwnerIndex::from_data(
            &data(vec![
                pod("apps", "bare", "<none>", "<none>"),
                not_controller,
                pod("apps", "api-old", "ReplicaSet", "api-5d8f7"),
                pod("apps", "api-new", "ReplicaSet", "api-6c9d4"),
                pod("apps", "nightly-28765432-abcde", "Job", "nightly-28765432"),
                pod("apps", "db-0", "StatefulSet", "db"),
                // Duplicate scrapes of the same owner stay one owner.
                pod("apps", "db-0", "StatefulSet", "db"),
                pod("apps", "agent-x7k2p", "DaemonSet", "agent"),
                pod("apps", "orphan-abc12-xyz12", "ReplicaSet", "orphan-abc12"),
                pod("apps", "loose-rs-q1w2e", "ReplicaSet", "loose-rs"),
                pod("apps", "manual-kq8xz", "Job", "manual"),
                pod("apps", "web-0", "StatefulSet", "web"),
                pod("apps", "web-0", "ReplicaSet", "web-7f9c8"),
                pod("apps", "canary-abc-12345", "ReplicaSet", "canary-abc"),
                pod("apps", "twin-7c8d9-aaaaa", "ReplicaSet", "twin-7c8d9"),
                pod("apps", "etl-1-zzzzz", "Job", "etl-1"),
                pod("kube-system", "etcd-node1", "Node", "node1"),
                pod("", "nameless", "StatefulSet", "x"),
                series(&[("namespace", "apps"), ("owner_kind", "StatefulSet")]),
            ]),
            &data(vec![
                rs("apps", "api-5d8f7", "Deployment", "api"),
                rs("apps", "api-6c9d4", "Deployment", "api"),
                rs("apps", "loose-rs", "<none>", "<none>"),
                rs("apps", "web-7f9c8", "Deployment", "web"),
                rs("apps", "canary-abc", "Rollout", "canary"),
                rs("apps", "twin-7c8d9", "Deployment", "twin-a"),
                rs("apps", "twin-7c8d9", "Deployment", "twin-b"),
            ]),
            &data(vec![
                job("apps", "nightly-28765432", "CronJob", "nightly"),
                job("apps", "manual", "", ""),
                job("apps", "etl-1", "Workflow", "etl"),
            ]),
        )
    }

    #[test]
    fn none_and_non_controller_owners_are_ignored() {
        let index = index();
        assert_eq!(index.resolve("apps", "bare"), Owner::Unowned);
        assert_eq!(index.resolve("apps", "x"), Owner::Unowned);
        assert_eq!(index.resolve("", "nameless"), Owner::Unowned);
        assert!(is_none_owner("<none>", "x"));
        assert!(is_none_owner("ReplicaSet", ""));
        assert!(is_none_owner(" ", "web"));
        assert!(!is_none_owner("ReplicaSet", "web-7f9c8"));
    }

    #[test]
    fn replicasets_and_jobs_resolve_one_hop() {
        let index = index();
        assert_eq!(
            index.resolve("apps", "api-old"),
            workload("Deployment", "api")
        );
        assert_eq!(
            index.resolve("apps", "api-new"),
            workload("Deployment", "api")
        );
        assert_eq!(
            index.resolve("apps", "nightly-28765432-abcde"),
            workload("CronJob", "nightly")
        );
        assert_eq!(index.resolve("apps", "db-0"), workload("StatefulSet", "db"));
        assert_eq!(
            index.resolve("apps", "agent-x7k2p"),
            workload("DaemonSet", "agent")
        );
        assert_eq!(
            index.resolve("other", "db-0"),
            Owner::Unowned,
            "per namespace"
        );
    }

    #[test]
    fn orphans_standalone_jobs_and_bare_pods_are_unowned() {
        let index = index();
        assert_eq!(
            index.resolve("apps", "orphan-abc12-xyz12"),
            Owner::Unowned,
            "ReplicaSet without an owner series"
        );
        assert_eq!(
            index.resolve("apps", "loose-rs-q1w2e"),
            Owner::Unowned,
            "ReplicaSet owned by <none>"
        );
        assert_eq!(index.resolve("apps", "manual-kq8xz"), Owner::Unowned);
        assert_eq!(index.resolve("apps", "never-seen"), Owner::Unowned);
    }

    #[test]
    fn two_owners_for_one_pod_name_are_ambiguous() {
        let index = index();
        assert!(matches!(index.resolve("apps", "web-0"), Owner::Ambiguous(c) if c.len() == 2));
        // Candidates are resolved one hop and sorted.
        assert_eq!(
            index.resolve("apps", "web-0"),
            Owner::Ambiguous(vec![
                ("Deployment".into(), "web".into()),
                ("StatefulSet".into(), "web".into()),
            ])
        );
        assert_eq!(
            index.resolve("apps", "twin-7c8d9-aaaaa"),
            Owner::Ambiguous(vec![
                ("Deployment".into(), "twin-a".into()),
                ("Deployment".into(), "twin-b".into()),
            ]),
            "a ReplicaSet with two parents"
        );
    }

    #[test]
    fn unsupported_parents_are_reported() {
        let index = index();
        assert_eq!(
            index.resolve("apps", "canary-abc-12345"),
            Owner::Unsupported("Rollout".into())
        );
        assert_eq!(
            index.resolve("kube-system", "etcd-node1"),
            Owner::Unsupported("Node".into())
        );
        assert_eq!(
            index.resolve("apps", "etl-1-zzzzz"),
            Owner::Unsupported("Workflow".into())
        );
    }

    #[test]
    fn indexes_merge_and_know_when_they_are_empty() {
        let empty = OwnerIndex::from_data(&data(vec![]), &data(vec![]), &data(vec![]));
        assert!(empty.is_empty());
        let only_none = OwnerIndex::from_data(
            &data(vec![pod("apps", "bare", "<none>", "<none>")]),
            &data(vec![rs("apps", "api-5d8f7", "Deployment", "api")]),
            &data(vec![]),
        );
        assert!(only_none.is_empty(), "no pod owner at all");

        let mut merged = OwnerIndex::from_data(
            &data(vec![pod("a", "api-1-x", "ReplicaSet", "api-1")]),
            &data(vec![]),
            &data(vec![]),
        );
        merged.merge(OwnerIndex::from_data(
            &data(vec![pod("b", "db-0", "StatefulSet", "db")]),
            &data(vec![rs("a", "api-1", "Deployment", "api")]),
            &data(vec![]),
        ));
        assert!(!merged.is_empty());
        assert_eq!(
            merged.resolve("a", "api-1-x"),
            workload("Deployment", "api")
        );
        assert_eq!(merged.resolve("b", "db-0"), workload("StatefulSet", "db"));
    }

    #[test]
    fn parent_series_are_missing_only_where_their_query_answered_nothing() {
        let pods = || {
            data(vec![
                pod("apps", "api-5d8f7-aaaaa", "ReplicaSet", "api-5d8f7"),
                pod("apps", "nightly-28765432-abcde", "Job", "nightly-28765432"),
                pod("apps", "db-0", "StatefulSet", "db"),
                pod("apps", "bare", "<none>", "<none>"),
            ])
        };
        // replicaset_owners and job_owners failed or were dropped (an allowlist).
        let none = OwnerIndex::from_data(&pods(), &data(vec![]), &data(vec![]));
        assert_eq!(none.resolve("apps", "api-5d8f7-aaaaa"), Owner::Unowned);
        assert_eq!(
            none.missing_parent_series("apps", "api-5d8f7-aaaaa"),
            Some("Deployment")
        );
        assert_eq!(
            none.missing_parent_series("apps", "nightly-28765432-abcde"),
            Some("CronJob")
        );
        assert!(
            none.missing_parent_series("apps", "db-0").is_none(),
            "no parent needed"
        );
        assert!(none.missing_parent_series("apps", "bare").is_none());
        assert!(none.missing_parent_series("apps", "never-seen").is_none());

        // The queries answered for the namespace, if only with `<none>` owners:
        // a missing parent is a real orphan.
        let orphans = OwnerIndex::from_data(
            &pods(),
            &data(vec![rs("apps", "other-rs", "<none>", "<none>")]),
            &data(vec![job("apps", "other-job", "<none>", "<none>")]),
        );
        assert!(orphans
            .missing_parent_series("apps", "api-5d8f7-aaaaa")
            .is_none());
        assert!(orphans
            .missing_parent_series("apps", "nightly-28765432-abcde")
            .is_none());

        // Answers for other namespaces say nothing about this one.
        let elsewhere = OwnerIndex::from_data(
            &pods(),
            &data(vec![rs("shop", "web-5d8f7", "Deployment", "web")]),
            &data(vec![]),
        );
        assert!(elsewhere
            .missing_parent_series("apps", "api-5d8f7-aaaaa")
            .is_some());
        let mut merged = elsewhere.clone();
        merged.merge(orphans);
        assert!(merged
            .missing_parent_series("apps", "api-5d8f7-aaaaa")
            .is_none());
    }

    #[test]
    fn owners_that_collapse_to_one_workload_are_not_ambiguous() {
        let index = OwnerIndex::from_data(
            &data(vec![
                pod("apps", "web-x", "ReplicaSet", "web-5d8f7"),
                pod("apps", "web-x", "ReplicaSet", "web-6c9d4"),
            ]),
            &data(vec![
                rs("apps", "web-5d8f7", "Deployment", "web"),
                rs("apps", "web-6c9d4", "Deployment", "web"),
            ]),
            &data(vec![]),
        );
        assert_eq!(
            index.resolve("apps", "web-x"),
            workload("Deployment", "web")
        );
    }
}
