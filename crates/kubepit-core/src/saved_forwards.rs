//! Saved port forwards (`~/.kubepit/port_forwards.json`, backend-owned).
//!
//! A saved forward is a target (cluster, namespace, pod or service, remote
//! port) plus a local port, an optional label and `start_on_connect`. It is
//! unique per target: saving the same target again updates it. Live forwards
//! carry the id of their definition in `saved_id`, which is how the UI shows
//! saved-but-stopped rows next to running ones.
//!
//! Definitions with `start_on_connect` start in the background whenever
//! their cluster connects. A start that fails (busy local port, missing pod
//! or service) is listed as a forward in the `error` state with the reason,
//! so it can be restarted once the cause is fixed.
//!
//! Every change emits the full list on `portforward://saved`.

use std::path::PathBuf;

use anyhow::{anyhow, Result};
use parking_lot::RwLock;

use crate::app::Kubepit;
use crate::objects::now_millis;
use crate::portforward::{validate_request, Launcher};
use crate::store::{load_json_or_default, write_json};
use crate::types::{
    PortForward, PortForwardRequest, PortForwardState, SavedPortForward, SavedPortForwardInput,
};

/// The persisted definitions, cached in memory and written through.
pub struct SavedForwards {
    path: PathBuf,
    list: RwLock<Vec<SavedPortForward>>,
}

fn same_target(saved: &SavedPortForward, request: &PortForwardRequest) -> bool {
    saved.cluster_id == request.cluster_id
        && saved.namespace == request.namespace
        && saved.kind == request.kind
        && saved.name == request.name
        && saved.remote_port == request.remote_port
}

/// The request a saved forward starts with.
pub fn request_of(saved: &SavedPortForward) -> PortForwardRequest {
    PortForwardRequest {
        cluster_id: saved.cluster_id.clone(),
        namespace: saved.namespace.clone(),
        kind: saved.kind,
        name: saved.name.clone(),
        remote_port: saved.remote_port,
        local_port: saved.local_port,
    }
}

fn clean_label(label: Option<String>) -> Option<String> {
    label
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
}

impl SavedForwards {
    pub fn open(path: PathBuf) -> Result<Self> {
        let list: Vec<SavedPortForward> = load_json_or_default(&path)?;
        Ok(Self {
            path,
            list: RwLock::new(list),
        })
    }

    pub fn list(&self) -> Vec<SavedPortForward> {
        self.list.read().clone()
    }

    pub fn get(&self, id: &str) -> Option<SavedPortForward> {
        self.list.read().iter().find(|s| s.id == id).cloned()
    }

    /// The definition of the target `request` points at.
    pub fn find_target(&self, request: &PortForwardRequest) -> Option<SavedPortForward> {
        self.list
            .read()
            .iter()
            .find(|s| same_target(s, request))
            .cloned()
    }

    /// Mutate and persist under the write lock; nothing changes when `f` or
    /// the write fails.
    pub fn update<R>(
        &self,
        f: impl FnOnce(&mut Vec<SavedPortForward>) -> Result<R>,
    ) -> Result<(R, Vec<SavedPortForward>)> {
        let mut guard = self.list.write();
        let mut next = guard.clone();
        let out = f(&mut next)?;
        write_json(&self.path, &next, false)?;
        *guard = next;
        Ok((out, guard.clone()))
    }
}

impl Kubepit {
    fn emit_saved(&self, list: &[SavedPortForward]) {
        self.sink.saved_port_forwards(list);
    }

    /// `port_forward_saved_list`.
    pub fn port_forward_saved_list(&self) -> Vec<SavedPortForward> {
        self.saved_forwards.list()
    }

    /// `port_forward_save`: create the definition of a target, or update the
    /// existing one. A running forward to that target is linked to it.
    pub fn port_forward_save(&self, input: SavedPortForwardInput) -> Result<SavedPortForward> {
        let request = PortForwardRequest {
            cluster_id: input.cluster_id.clone(),
            namespace: input.namespace.trim().to_string(),
            kind: input.kind,
            name: input.name.trim().to_string(),
            remote_port: input.remote_port,
            local_port: input.local_port.filter(|p| *p != 0),
        };
        validate_request(&request)?;
        self.cluster_def(&request.cluster_id)?;
        let label = clean_label(input.label);
        let start_on_connect = input.start_on_connect;
        let target = request.clone();
        let (saved, list) = self.saved_forwards.update(move |list| {
            if let Some(existing) = list.iter_mut().find(|s| same_target(s, &target)) {
                existing.local_port = target.local_port;
                existing.label = label;
                existing.start_on_connect = start_on_connect;
                return Ok(existing.clone());
            }
            let saved = SavedPortForward {
                id: uuid::Uuid::new_v4().to_string(),
                cluster_id: target.cluster_id.clone(),
                namespace: target.namespace.clone(),
                kind: target.kind,
                name: target.name.clone(),
                remote_port: target.remote_port,
                local_port: target.local_port,
                label,
                start_on_connect,
                created_at: now_millis(),
            };
            list.push(saved.clone());
            Ok(saved)
        })?;
        if self.forwards.by_saved(&saved.id).is_none() {
            // Link one running forward to the new definition.
            let linked = std::cell::Cell::new(false);
            let changed = self.forwards.relink(
                |f| {
                    f.saved_id.is_none()
                        && same_target(&saved, &forward_request(f))
                        && !linked.replace(true)
                },
                Some(&saved.id),
            );
            if changed {
                self.forwards.emit(self.sink.as_ref());
            }
        }
        self.emit_saved(&list);
        Ok(saved)
    }

    /// `port_forward_saved_update`: change the label, local port or
    /// `start_on_connect` of a definition (the target is fixed).
    pub fn port_forward_saved_update(&self, saved: SavedPortForward) -> Result<SavedPortForward> {
        let label = clean_label(saved.label);
        let local_port = saved.local_port.filter(|p| *p != 0);
        let id = saved.id.clone();
        let (updated, list) = self.saved_forwards.update(move |list| {
            let slot = list
                .iter_mut()
                .find(|s| s.id == id)
                .ok_or_else(|| anyhow!("saved port forward {id} does not exist"))?;
            slot.label = label;
            slot.local_port = local_port;
            slot.start_on_connect = saved.start_on_connect;
            Ok(slot.clone())
        })?;
        self.emit_saved(&list);
        Ok(updated)
    }

    /// `port_forward_unsave`: forget a definition. A running forward keeps
    /// running, unlinked. Unknown ids are ignored.
    pub fn port_forward_unsave(&self, id: &str) -> Result<()> {
        let target = id.to_string();
        let (removed, list) = self.saved_forwards.update(move |list| {
            let before = list.len();
            list.retain(|s| s.id != target);
            Ok(list.len() != before)
        })?;
        if !removed {
            return Ok(());
        }
        if self
            .forwards
            .relink(|f| f.saved_id.as_deref() == Some(id), None)
        {
            self.forwards.emit(self.sink.as_ref());
        }
        self.emit_saved(&list);
        Ok(())
    }

    /// `port_forward_saved_start`: start a saved forward (connecting its
    /// cluster if needed). Returns the running forward when it already runs.
    pub async fn port_forward_saved_start(&self, id: &str) -> Result<PortForward> {
        let saved = self
            .saved_forwards
            .get(id)
            .ok_or_else(|| anyhow!("saved port forward {id} does not exist"))?;
        if let Some(live) = self.forwards.by_saved(id) {
            if live.state != PortForwardState::Error {
                return Ok(live);
            }
            return self.port_forward_restart(&live.id).await;
        }
        let launcher = self.launcher(&saved.cluster_id).await?;
        let forward_id = uuid::Uuid::new_v4().to_string();
        launcher
            .launch(forward_id, request_of(&saved), Some(saved.id), None)
            .await
    }

    /// Start the `start_on_connect` forwards of a cluster that just
    /// connected, in the background.
    pub(crate) fn autostart_saved_forwards(&self, cluster_id: &str, client: kube::Client) {
        let saved: Vec<SavedPortForward> = self
            .saved_forwards
            .list()
            .into_iter()
            .filter(|s| s.cluster_id == cluster_id && s.start_on_connect)
            .collect();
        if saved.is_empty() {
            return;
        }
        let launcher = Launcher {
            client,
            forwards: self.forwards.clone(),
            sink: self.sink.clone(),
        };
        let generation = self.forwards.cluster_generation(cluster_id);
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        runtime.spawn(async move {
            for def in saved {
                if launcher.forwards.by_saved(&def.id).is_some() {
                    continue;
                }
                let id = uuid::Uuid::new_v4().to_string();
                let request = request_of(&def);
                let result = launcher
                    .launch(
                        id.clone(),
                        request.clone(),
                        Some(def.id.clone()),
                        Some(generation),
                    )
                    .await;
                if let Err(e) = result {
                    if launcher.forwards.cluster_generation(&def.cluster_id) != generation {
                        return;
                    }
                    tracing::debug!("saved port forward {} did not start: {e:#}", def.id);
                    launcher.forwards.insert_failed(
                        PortForward {
                            id,
                            cluster_id: request.cluster_id,
                            namespace: request.namespace,
                            kind: request.kind,
                            name: request.name,
                            remote_port: request.remote_port,
                            local_port: request.local_port.unwrap_or(0),
                            state: PortForwardState::Error,
                            error: Some(format!("{e:#}")),
                            created_at: now_millis(),
                            saved_id: Some(def.id),
                        },
                        Some(generation),
                        launcher.sink.as_ref(),
                    );
                }
            }
        });
    }

    /// Drop the definitions of a removed cluster.
    pub(crate) fn forget_saved_forwards(&self, cluster_id: &str) {
        let target = cluster_id.to_string();
        match self.saved_forwards.update(move |list| {
            let before = list.len();
            list.retain(|s| s.cluster_id != target);
            Ok(list.len() != before)
        }) {
            Ok((true, list)) => self.emit_saved(&list),
            Ok((false, _)) => {}
            Err(e) => tracing::warn!("could not update saved port forwards: {e:#}"),
        }
    }
}

fn forward_request(forward: &PortForward) -> PortForwardRequest {
    PortForwardRequest {
        cluster_id: forward.cluster_id.clone(),
        namespace: forward.namespace.clone(),
        kind: forward.kind,
        name: forward.name.clone(),
        remote_port: forward.remote_port,
        local_port: Some(forward.local_port),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::cluster::tests_support::app_with_cluster;
    use crate::types::PortForwardKind;

    fn input(cluster_id: &str) -> SavedPortForwardInput {
        SavedPortForwardInput {
            cluster_id: cluster_id.into(),
            namespace: " db ".into(),
            kind: PortForwardKind::Service,
            name: "postgres".into(),
            remote_port: 5432,
            local_port: Some(15432),
            label: Some("  ".into()),
            start_on_connect: true,
        }
    }

    #[test]
    fn saving_is_unique_per_target_and_persisted() {
        let (dir, app, cluster) = app_with_cluster(false);
        let first = app.port_forward_save(input(&cluster.id)).unwrap();
        assert_eq!(first.namespace, "db");
        assert_eq!(first.label, None);
        let again = app
            .port_forward_save(SavedPortForwardInput {
                label: Some("Postgres".into()),
                start_on_connect: false,
                local_port: Some(0),
                ..input(&cluster.id)
            })
            .unwrap();
        assert_eq!(again.id, first.id);
        assert_eq!(again.label.as_deref(), Some("Postgres"));
        assert_eq!(again.local_port, None);
        assert_eq!(app.port_forward_saved_list().len(), 1);

        let mut edited = again.clone();
        edited.start_on_connect = true;
        edited.local_port = Some(25432);
        edited.name = "ignored".into();
        let updated = app.port_forward_saved_update(edited).unwrap();
        assert!(updated.start_on_connect);
        assert_eq!(updated.local_port, Some(25432));
        assert_eq!(updated.name, "postgres");

        // Reloaded from disk.
        let reopened = SavedForwards::open(app.paths().port_forwards_file()).unwrap();
        assert_eq!(reopened.list(), app.port_forward_saved_list());

        app.port_forward_unsave(&first.id).unwrap();
        app.port_forward_unsave(&first.id).unwrap();
        assert!(app.port_forward_saved_list().is_empty());
        drop(dir);
    }

    #[test]
    fn invalid_definitions_are_rejected() {
        let (_dir, app, cluster) = app_with_cluster(false);
        let mut bad = input(&cluster.id);
        bad.remote_port = 0;
        assert!(app.port_forward_save(bad).is_err());
        assert!(app.port_forward_save(input("no-such-cluster")).is_err());
        assert!(app
            .port_forward_saved_update(SavedPortForward {
                id: "missing".into(),
                cluster_id: cluster.id.clone(),
                namespace: "db".into(),
                kind: PortForwardKind::Pod,
                name: "p".into(),
                remote_port: 1,
                local_port: None,
                label: None,
                start_on_connect: false,
                created_at: 0,
            })
            .is_err());
        assert!(app.port_forward_saved_list().is_empty());
    }

    #[tokio::test]
    async fn removing_a_cluster_forgets_its_forwards() {
        let (_dir, app, cluster) = app_with_cluster(false);
        app.port_forward_save(input(&cluster.id)).unwrap();
        let app = Arc::new(app);
        app.cluster_remove(&cluster.id).await.unwrap();
        assert!(app.port_forward_saved_list().is_empty());
    }
}
