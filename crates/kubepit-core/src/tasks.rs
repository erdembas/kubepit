//! Registry of cancellable background tasks (watches, log streams).
//!
//! Each task is keyed by an id handed to the UI and tagged with its cluster,
//! so a disconnect can stop everything that uses the old client. A task
//! removes its own entry when it finishes (via [`TaskGuard`]'s `Drop`), so
//! the registry never accumulates dead handles.

use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;

use parking_lot::Mutex;
use tokio::task::AbortHandle;

struct Entry {
    cluster_id: String,
    abort: AbortHandle,
}

type Tasks = Arc<Mutex<HashMap<String, Entry>>>;

#[derive(Clone, Default)]
pub struct TaskRegistry {
    tasks: Tasks,
}

/// Removes the task's registry entry when the task ends for any reason
/// (completion, error, abort).
struct TaskGuard {
    tasks: Tasks,
    id: String,
}

impl Drop for TaskGuard {
    fn drop(&mut self) {
        self.tasks.lock().remove(&self.id);
    }
}

impl TaskRegistry {
    /// Spawn `fut` on the current Tokio runtime under `id`.
    ///
    /// The entry is inserted while the registry lock is held, and the task's
    /// guard needs that same lock to remove it, so even a task that finishes
    /// instantly cannot leave a stale entry behind.
    pub fn spawn<F>(&self, id: &str, cluster_id: &str, fut: F)
    where
        F: Future<Output = ()> + Send + 'static,
    {
        let guard = TaskGuard {
            tasks: self.tasks.clone(),
            id: id.to_string(),
        };
        let mut tasks = self.tasks.lock();
        let handle = tokio::spawn(async move {
            let _guard = guard;
            fut.await;
        });
        tasks.insert(
            id.to_string(),
            Entry {
                cluster_id: cluster_id.to_string(),
                abort: handle.abort_handle(),
            },
        );
    }

    /// Abort one task. Returns whether it was running.
    pub fn stop(&self, id: &str) -> bool {
        let entry = self.tasks.lock().remove(id);
        match entry {
            Some(entry) => {
                entry.abort.abort();
                true
            }
            None => false,
        }
    }

    /// Abort every task belonging to `cluster_id`.
    pub fn stop_cluster(&self, cluster_id: &str) {
        let stopped: Vec<Entry> = {
            let mut tasks = self.tasks.lock();
            let ids: Vec<String> = tasks
                .iter()
                .filter(|(_, e)| e.cluster_id == cluster_id)
                .map(|(id, _)| id.clone())
                .collect();
            ids.iter().filter_map(|id| tasks.remove(id)).collect()
        };
        for entry in stopped {
            entry.abort.abort();
        }
    }

    /// Abort everything (app shutdown).
    pub fn stop_all(&self) {
        let all: Vec<Entry> = self.tasks.lock().drain().map(|(_, e)| e).collect();
        for entry in all {
            entry.abort.abort();
        }
    }

    pub fn len(&self) -> usize {
        self.tasks.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn finished_tasks_remove_themselves() {
        let registry = TaskRegistry::default();
        registry.spawn("a", "c1", async {});
        for _ in 0..50 {
            if registry.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(registry.is_empty());
    }

    #[tokio::test]
    async fn stop_cluster_only_touches_that_cluster() {
        let registry = TaskRegistry::default();
        let pending = || futures::future::pending::<()>();
        registry.spawn("a", "c1", pending());
        registry.spawn("b", "c1", pending());
        registry.spawn("c", "c2", pending());
        assert_eq!(registry.len(), 3);
        registry.stop_cluster("c1");
        assert_eq!(registry.len(), 1);
        assert!(registry.stop("c"));
        assert!(!registry.stop("c"));
        assert!(registry.is_empty());
    }
}
