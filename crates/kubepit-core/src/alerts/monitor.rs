//! Watch plumbing of the alert monitor: one `kube::runtime` watcher task per
//! kind (and per namespace when the cluster declares accessible namespaces),
//! folded through a [`Tracker`] into the shared [`AlertBook`].

use std::sync::Arc;

use futures::StreamExt;
use k8s_openapi::NamespaceResourceScope;
use kube::runtime::watcher;
use kube::runtime::WatchStreamExt;
use kube::{Api, Client, Resource};
use parking_lot::{Mutex, RwLock};

use super::book::AlertBook;
use super::detect::{Finding, SlimDeployment, SlimJob, SlimNode, SlimPod, Tracker, Watched};
use super::model::{AlertObjectRef, AlertSettings, WatchedKind};
use crate::error::{watcher_error_code, watcher_error_message};
use crate::events::EventSink;
use crate::objects::now_millis;
use crate::tasks::TaskRegistry;

/// What every watcher task of one cluster shares.
pub(crate) struct MonitorCtx {
    pub cluster_id: String,
    pub book: Arc<Mutex<AlertBook>>,
    pub settings: Arc<RwLock<AlertSettings>>,
    pub sink: Arc<dyn EventSink>,
}

impl MonitorCtx {
    /// Filter, record and announce one finding.
    fn raise(&self, object: AlertObjectRef, finding: Finding) {
        let recorded = self
            .settings
            .read()
            .records(finding.reason, object.namespace.as_deref());
        if !recorded {
            return;
        }
        let event = self
            .book
            .lock()
            .record(&self.cluster_id, object, finding, now_millis());
        self.sink.alert(&event);
    }
}

/// Drive one watcher until it is aborted. A kind the cluster does not serve
/// (404) or the user may not list (403) is given up after the first list
/// attempt instead of being retried forever; reconnecting tries again.
async fn run_kind<K: Watched>(ctx: Arc<MonitorCtx>, api: Api<K>) {
    let mut tracker = Tracker::<K>::default();
    let mut stream = watcher::watcher(api, watcher::Config::default().any_semantic())
        .default_backoff()
        .boxed();
    while let Some(item) = stream.next().await {
        match item {
            Ok(event) => {
                for (object, finding) in tracker.on_event(event) {
                    ctx.raise(object, finding);
                }
            }
            Err(err) => {
                let message = watcher_error_message(&err);
                if !tracker.synced() && matches!(watcher_error_code(&err), Some(403 | 404)) {
                    tracing::info!(
                        cluster = %ctx.cluster_id,
                        "alerts: not watching {}: {message}",
                        K::plural(&())
                    );
                    return;
                }
                tracing::debug!(cluster = %ctx.cluster_id, "alerts: {} watch: {message}", K::plural(&()));
            }
        }
    }
}

fn namespaced_apis<K>(client: &Client, namespaces: &[String]) -> Vec<(String, Api<K>)>
where
    K: Resource<DynamicType = (), Scope = NamespaceResourceScope>,
{
    if namespaces.is_empty() {
        return vec![("*".to_string(), Api::all(client.clone()))];
    }
    namespaces
        .iter()
        .map(|ns| (ns.clone(), Api::namespaced(client.clone(), ns)))
        .collect()
}

fn spawn_all<K: Watched>(tasks: &TaskRegistry, ctx: &Arc<MonitorCtx>, apis: Vec<(String, Api<K>)>) {
    for (scope, api) in apis {
        let id = format!("alerts:{}:{}:{scope}", ctx.cluster_id, K::plural(&()));
        tasks.spawn(&id, &ctx.cluster_id, run_kind(ctx.clone(), api));
    }
}

/// Start the watcher tasks of one cluster. `namespaces` empty = watch
/// namespaced kinds cluster-wide.
pub(crate) fn spawn_monitor(
    tasks: &TaskRegistry,
    ctx: Arc<MonitorCtx>,
    client: &Client,
    kinds: &[WatchedKind],
    namespaces: &[String],
) {
    for kind in kinds {
        match kind {
            WatchedKind::Pods => {
                spawn_all::<SlimPod>(tasks, &ctx, namespaced_apis(client, namespaces))
            }
            WatchedKind::Jobs => {
                spawn_all::<SlimJob>(tasks, &ctx, namespaced_apis(client, namespaces))
            }
            WatchedKind::Deployments => {
                spawn_all::<SlimDeployment>(tasks, &ctx, namespaced_apis(client, namespaces))
            }
            WatchedKind::Nodes => spawn_all::<SlimNode>(
                tasks,
                &ctx,
                vec![("*".to_string(), Api::all(client.clone()))],
            ),
        }
    }
}
