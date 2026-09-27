//! The notification center's memory: dedupe, burst collapse and a bounded
//! history. Pure bookkeeping with explicit timestamps, no I/O.
//!
//! - **Dedupe.** A finding for the same (cluster, object, reason[, node
//!   condition]) seen within [`COOLDOWN_MS`] of the entry's `last_seen`
//!   merges into it (`count += 1`) instead of raising a new alert, so a pod
//!   crash-looping all afternoon stays one entry.
//! - **Bursts.** Once [`BURST_THRESHOLD`] objects of one kind raised the same
//!   reason in one namespace within [`BURST_WINDOW_MS`], further ones
//!   collapse into a single group alert ("12 pods in CrashLoopBackOff in
//!   shop") that keeps merging while it is active.
//! - **History.** At most [`HISTORY_LIMIT`] entries; the oldest go first.

use std::collections::{HashMap, VecDeque};

use super::detect::Finding;
use super::model::{Alert, AlertEvent, AlertGroup, AlertObjectRef, AlertReason};

/// Entries kept in memory.
pub const HISTORY_LIMIT: usize = 500;
/// Repeats within this long after `last_seen` merge into the entry.
pub const COOLDOWN_MS: i64 = 10 * 60_000;
/// Window in which individual alerts of one bucket count towards a burst.
pub const BURST_WINDOW_MS: i64 = 60_000;
/// Individual alerts per bucket and window before the rest collapse.
pub const BURST_THRESHOLD: usize = 3;
/// Names listed on a group alert.
pub const GROUP_NAME_LIMIT: usize = 50;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ObjectKey {
    cluster: String,
    kind: String,
    namespace: Option<String>,
    name: String,
    reason: AlertReason,
    condition: Option<String>,
}

impl ObjectKey {
    fn of(alert: &Alert) -> Self {
        Self {
            cluster: alert.cluster_id.clone(),
            kind: alert.object.kind.clone(),
            namespace: alert.object.namespace.clone(),
            name: alert.object.name.clone(),
            reason: alert.reason,
            condition: alert.condition.clone(),
        }
    }
}

/// Burst bucket: one kind, one reason, one namespace (or cluster-wide).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct BucketKey {
    cluster: String,
    kind: String,
    namespace: Option<String>,
    reason: AlertReason,
    condition: Option<String>,
}

impl BucketKey {
    fn of(alert: &Alert) -> Self {
        Self {
            cluster: alert.cluster_id.clone(),
            kind: alert.object.kind.clone(),
            namespace: alert.object.namespace.clone(),
            reason: alert.reason,
            condition: alert.condition.clone(),
        }
    }
}

#[derive(Debug)]
pub struct AlertBook {
    /// Oldest first.
    alerts: VecDeque<Alert>,
    by_object: HashMap<ObjectKey, String>,
    groups: HashMap<BucketKey, String>,
    /// Individual alerts raised recently per bucket: (time, object name).
    recent: HashMap<BucketKey, VecDeque<(i64, String)>>,
    limit: usize,
}

impl Default for AlertBook {
    fn default() -> Self {
        Self::with_limit(HISTORY_LIMIT)
    }
}

fn select(ids: Option<&[String]>, alert: &Alert) -> bool {
    ids.is_none_or(|ids| ids.iter().any(|id| id == &alert.id))
}

impl AlertBook {
    pub fn with_limit(limit: usize) -> Self {
        Self {
            alerts: VecDeque::new(),
            by_object: HashMap::new(),
            groups: HashMap::new(),
            recent: HashMap::new(),
            limit: limit.max(1),
        }
    }

    pub fn len(&self) -> usize {
        self.alerts.len()
    }

    pub fn is_empty(&self) -> bool {
        self.alerts.is_empty()
    }

    fn get_mut(&mut self, id: &str) -> Option<&mut Alert> {
        self.alerts.iter_mut().find(|a| a.id == id)
    }

    /// Record one finding observed at `now` (epoch ms).
    pub fn record(
        &mut self,
        cluster_id: &str,
        object: AlertObjectRef,
        finding: Finding,
        now: i64,
    ) -> AlertEvent {
        let key = ObjectKey {
            cluster: cluster_id.to_string(),
            kind: object.kind.clone(),
            namespace: object.namespace.clone(),
            name: object.name.clone(),
            reason: finding.reason,
            condition: finding.condition.clone(),
        };
        let bucket = BucketKey {
            cluster: cluster_id.to_string(),
            kind: object.kind.clone(),
            namespace: object.namespace.clone(),
            reason: finding.reason,
            condition: finding.condition.clone(),
        };

        // 1. A repeat of an active entry.
        if let Some(id) = self.by_object.get(&key).cloned() {
            if let Some(alert) = self
                .get_mut(&id)
                .filter(|a| now - a.last_seen < COOLDOWN_MS)
            {
                alert.count += 1;
                alert.last_seen = now;
                alert.message = finding.message;
                if finding.container.is_some() {
                    alert.container = finding.container;
                }
                return AlertEvent {
                    alert: alert.clone(),
                    fresh: false,
                };
            }
        }

        // 2. Part of an active burst.
        if let Some(id) = self.groups.get(&bucket).cloned() {
            if let Some(alert) = self
                .get_mut(&id)
                .filter(|a| now - a.last_seen < COOLDOWN_MS)
            {
                alert.count += 1;
                alert.last_seen = now;
                alert.message = finding.message;
                if let Some(group) = alert.group.as_mut() {
                    if !group.names.contains(&object.name) {
                        group.total += 1;
                        if group.names.len() < GROUP_NAME_LIMIT {
                            group.names.push(object.name.clone());
                        }
                    }
                }
                return AlertEvent {
                    alert: alert.clone(),
                    fresh: false,
                };
            }
        }

        // 3. A new burst, or a new individual alert.
        self.recent
            .retain(|_, q| q.back().is_some_and(|(t, _)| now - t < BURST_WINDOW_MS));
        let recent = self.recent.entry(bucket.clone()).or_default();
        while recent
            .front()
            .is_some_and(|(t, _)| now - t >= BURST_WINDOW_MS)
        {
            recent.pop_front();
        }
        let alert = if recent.len() >= BURST_THRESHOLD {
            let mut names: Vec<String> = recent.iter().map(|(_, n)| n.clone()).collect();
            if !names.contains(&object.name) {
                names.push(object.name.clone());
            }
            let total = names.len() as u32;
            names.truncate(GROUP_NAME_LIMIT);
            let alert = new_alert(
                cluster_id,
                AlertObjectRef {
                    name: String::new(),
                    ..object
                },
                Finding {
                    container: None,
                    ..finding
                },
                now,
                Some(AlertGroup { total, names }),
            );
            self.groups.insert(bucket, alert.id.clone());
            alert
        } else {
            recent.push_back((now, object.name.clone()));
            let alert = new_alert(cluster_id, object, finding, now, None);
            self.by_object.insert(key, alert.id.clone());
            alert
        };
        self.alerts.push_back(alert.clone());
        while self.alerts.len() > self.limit {
            if let Some(old) = self.alerts.pop_front() {
                self.unindex(&old);
            }
        }
        AlertEvent { alert, fresh: true }
    }

    /// Forget the index entry pointing at `alert` (not a newer one).
    fn unindex(&mut self, alert: &Alert) {
        if alert.group.is_some() {
            let key = BucketKey::of(alert);
            if self.groups.get(&key) == Some(&alert.id) {
                self.groups.remove(&key);
            }
        } else {
            let key = ObjectKey::of(alert);
            if self.by_object.get(&key) == Some(&alert.id) {
                self.by_object.remove(&key);
            }
        }
    }

    /// Newest activity first.
    pub fn list(&self) -> Vec<Alert> {
        let mut out: Vec<Alert> = self.alerts.iter().cloned().collect();
        out.sort_by(|a, b| {
            b.last_seen
                .cmp(&a.last_seen)
                .then_with(|| b.first_seen.cmp(&a.first_seen))
        });
        out
    }

    /// Mark `ids` (all when `None`) read; returns how many changed.
    pub fn mark_read(&mut self, ids: Option<&[String]>) -> usize {
        let mut changed = 0;
        for alert in self.alerts.iter_mut().filter(|a| select(ids, a)) {
            if !alert.read {
                alert.read = true;
                changed += 1;
            }
        }
        changed
    }

    /// Remove `ids` (all when `None`); returns how many were removed. A
    /// cleared problem that recurs raises a fresh alert.
    pub fn clear(&mut self, ids: Option<&[String]>) -> usize {
        self.remove_where(|a| select(ids, a))
    }

    /// Drop every alert of a removed cluster.
    pub fn remove_cluster(&mut self, cluster_id: &str) -> usize {
        self.recent.retain(|k, _| k.cluster != cluster_id);
        self.remove_where(|a| a.cluster_id == cluster_id)
    }

    fn remove_where(&mut self, pred: impl Fn(&Alert) -> bool) -> usize {
        let (gone, kept): (Vec<Alert>, Vec<Alert>) = self.alerts.drain(..).partition(pred);
        self.alerts = kept.into();
        for alert in &gone {
            self.unindex(alert);
        }
        gone.len()
    }
}

fn new_alert(
    cluster_id: &str,
    object: AlertObjectRef,
    finding: Finding,
    now: i64,
    group: Option<AlertGroup>,
) -> Alert {
    let count = group.as_ref().map_or(1, |g| g.total.max(1));
    Alert {
        id: uuid::Uuid::new_v4().to_string(),
        cluster_id: cluster_id.to_string(),
        severity: finding.reason.severity(),
        reason: finding.reason,
        object,
        container: finding.container,
        condition: finding.condition,
        message: finding.message,
        first_seen: now,
        last_seen: now,
        count,
        read: false,
        group,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::alerts::model::AlertSeverity;

    const T0: i64 = 1_700_000_000_000;

    fn pod(ns: &str, name: &str) -> AlertObjectRef {
        AlertObjectRef {
            group: String::new(),
            version: "v1".into(),
            kind: "Pod".into(),
            namespace: Some(ns.into()),
            name: name.into(),
        }
    }

    fn crash(message: &str) -> Finding {
        Finding {
            reason: AlertReason::CrashLoopBackOff,
            container: Some("app".into()),
            condition: None,
            message: message.into(),
        }
    }

    #[test]
    fn repeats_within_the_cooldown_merge() {
        let mut book = AlertBook::default();
        let first = book.record("c1", pod("shop", "web-1"), crash("back-off 10s"), T0);
        assert!(first.fresh);
        assert_eq!(first.alert.count, 1);
        assert_eq!(first.alert.severity, AlertSeverity::Critical);
        assert!(!first.alert.read);

        let again = book.record(
            "c1",
            pod("shop", "web-1"),
            crash("back-off 20s"),
            T0 + 60_000,
        );
        assert!(!again.fresh, "no second notification within the cooldown");
        assert_eq!(again.alert.id, first.alert.id);
        assert_eq!(again.alert.count, 2);
        assert_eq!(again.alert.first_seen, T0);
        assert_eq!(again.alert.last_seen, T0 + 60_000);
        assert_eq!(again.alert.message, "back-off 20s");
        assert_eq!(book.len(), 1);

        // The cooldown slides with last_seen.
        let later = book.record(
            "c1",
            pod("shop", "web-1"),
            crash("x"),
            T0 + 60_000 + COOLDOWN_MS - 1,
        );
        assert!(!later.fresh);
        // Quiet for a whole cooldown: a new entry.
        let fresh = book.record(
            "c1",
            pod("shop", "web-1"),
            crash("x"),
            T0 + 60_000 + 2 * COOLDOWN_MS,
        );
        assert!(fresh.fresh);
        assert_ne!(fresh.alert.id, first.alert.id);
        assert_eq!(book.len(), 2);
    }

    #[test]
    fn keys_separate_cluster_object_reason_and_condition() {
        let mut book = AlertBook::default();
        assert!(book.record("c1", pod("shop", "web-1"), crash(""), T0).fresh);
        assert!(book.record("c2", pod("shop", "web-1"), crash(""), T0).fresh);
        let oom = Finding {
            reason: AlertReason::OomKilled,
            ..crash("")
        };
        assert!(book.record("c1", pod("shop", "web-1"), oom, T0).fresh);
        let node = AlertObjectRef {
            group: String::new(),
            version: "v1".into(),
            kind: "Node".into(),
            namespace: None,
            name: "n1".into(),
        };
        let pressure = |c: &str| Finding {
            reason: AlertReason::NodePressure,
            container: None,
            condition: Some(c.into()),
            message: String::new(),
        };
        assert!(
            book.record("c1", node.clone(), pressure("DiskPressure"), T0)
                .fresh
        );
        assert!(
            book.record("c1", node.clone(), pressure("MemoryPressure"), T0)
                .fresh
        );
        assert!(
            !book
                .record("c1", node, pressure("DiskPressure"), T0 + 1)
                .fresh
        );
        assert_eq!(book.len(), 5);
    }

    #[test]
    fn bursts_collapse_into_one_group_alert() {
        let mut book = AlertBook::default();
        let mut fresh = Vec::new();
        for i in 0..12 {
            let event = book.record(
                "c1",
                pod("shop", &format!("web-{i}")),
                crash(""),
                T0 + i * 1_000,
            );
            if event.fresh {
                fresh.push(event.alert.clone());
            }
        }
        // Three individual alerts, then one group alert for the rest.
        assert_eq!(fresh.len(), BURST_THRESHOLD + 1);
        let group = fresh.last().unwrap();
        assert_eq!(group.object.name, "", "a group names no single object");
        assert_eq!(group.object.namespace.as_deref(), Some("shop"));
        assert_eq!(group.container, None);
        let alerts = book.list();
        assert_eq!(alerts.len(), BURST_THRESHOLD + 1);
        let group = alerts.iter().find(|a| a.group.is_some()).unwrap();
        let info = group.group.as_ref().unwrap();
        assert_eq!(info.total, 12, "every pod of the burst is counted");
        assert_eq!(info.names.len(), 12);
        assert_eq!(info.names[0], "web-0");
        assert_eq!(group.count, 12);

        // The same pod crashing again merges into the group, not a new entry.
        let repeat = book.record("c1", pod("shop", "web-7"), crash(""), T0 + 20_000);
        assert!(!repeat.fresh);
        assert_eq!(repeat.alert.id, group.id);
        assert_eq!(repeat.alert.group.as_ref().unwrap().total, 12);
        // And an individual pod of the burst merges into its own entry.
        let own = book.record("c1", pod("shop", "web-0"), crash(""), T0 + 20_000);
        assert!(!own.fresh);
        assert!(own.alert.group.is_none());

        // Other namespaces are separate buckets.
        assert!(
            book.record("c1", pod("db", "pg-0"), crash(""), T0 + 20_000)
                .fresh
        );
    }

    #[test]
    fn slow_trickles_do_not_count_as_bursts() {
        let mut book = AlertBook::default();
        for i in 0..6 {
            let event = book.record(
                "c1",
                pod("shop", &format!("web-{i}")),
                crash(""),
                T0 + i * BURST_WINDOW_MS,
            );
            assert!(event.fresh && event.alert.group.is_none(), "pod {i}");
        }
    }

    #[test]
    fn group_names_are_capped() {
        let mut book = AlertBook::default();
        for i in 0..(GROUP_NAME_LIMIT as i64 + 20) {
            book.record("c1", pod("shop", &format!("p-{i}")), crash(""), T0 + i);
        }
        let group = book.list().into_iter().find(|a| a.group.is_some()).unwrap();
        let info = group.group.unwrap();
        assert_eq!(info.names.len(), GROUP_NAME_LIMIT);
        assert_eq!(info.total, GROUP_NAME_LIMIT as u32 + 20);
    }

    #[test]
    fn history_is_bounded_and_evicts_oldest() {
        let mut book = AlertBook::with_limit(5);
        let mut ids = Vec::new();
        for i in 0..8 {
            // Spread out so nothing collapses into a burst.
            let e = book.record(
                "c1",
                pod(&format!("ns-{i}"), "web"),
                crash(""),
                T0 + i * BURST_WINDOW_MS,
            );
            ids.push(e.alert.id);
        }
        assert_eq!(book.len(), 5);
        let kept: Vec<String> = book.list().into_iter().map(|a| a.id).collect();
        assert_eq!(kept, ids[3..].iter().rev().cloned().collect::<Vec<_>>());
        // An evicted entry's object raises a fresh alert again.
        let again = book.record(
            "c1",
            pod("ns-0", "web"),
            crash(""),
            T0 + 8 * BURST_WINDOW_MS,
        );
        assert!(again.fresh);
        assert_eq!(book.len(), 5);
        assert_eq!(HISTORY_LIMIT, 500);
    }

    #[test]
    fn mark_read_clear_and_remove_cluster() {
        let mut book = AlertBook::default();
        let a = book.record("c1", pod("a", "x"), crash(""), T0).alert;
        let b = book.record("c1", pod("b", "x"), crash(""), T0 + 1).alert;
        let _c = book.record("c2", pod("c", "x"), crash(""), T0 + 2).alert;

        assert_eq!(book.mark_read(Some(std::slice::from_ref(&a.id))), 1);
        assert_eq!(book.mark_read(Some(std::slice::from_ref(&a.id))), 0);
        let list = book.list();
        assert_eq!(list[0].cluster_id, "c2", "newest first");
        assert!(list.iter().find(|x| x.id == a.id).unwrap().read);
        assert!(!list.iter().find(|x| x.id == b.id).unwrap().read);
        // A merged repeat keeps the read flag.
        let repeat = book.record("c1", pod("a", "x"), crash(""), T0 + 10);
        assert!(repeat.alert.read && !repeat.fresh);

        assert_eq!(book.mark_read(None), 2);
        assert_eq!(book.clear(Some(std::slice::from_ref(&b.id))), 1);
        assert_eq!(book.len(), 2);
        // Cleared: the same problem is fresh again.
        assert!(book.record("c1", pod("b", "x"), crash(""), T0 + 20).fresh);

        assert_eq!(book.remove_cluster("c1"), 2);
        assert_eq!(book.len(), 1);
        assert_eq!(book.clear(None), 1);
        assert!(book.is_empty());
        assert!(book.record("c1", pod("a", "x"), crash(""), T0 + 30).fresh);
    }
}
