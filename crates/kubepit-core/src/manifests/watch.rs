//! "Watch" in the Manifests tab: notice edits of a source's files with
//! `notify` instead of polling.
//!
//! A watch covers the source's folders recursively (the root of a Kustomize
//! directory or chart, the picked folders of a plain source) and, without
//! recursion, the folders of single files it depends on (picked files, Helm
//! values files). Folders are watched rather than files, because editors
//! save by writing a temp file and renaming it over the original, which ends
//! a file watch. After a burst of events has been quiet for
//! [`WATCH_DEBOUNCE`], the source's fingerprint ([`fingerprint`]) is
//! recomputed, and an event is sent only when it changed, so edits of
//! skipped files (hidden folders, `node_modules`) and repeated events for
//! the same edit stay silent. The baseline is the caller's `since`
//! fingerprint (the render it shows) when given: edits made while no watch
//! ran (a hidden tab, Watch still off) are reported as soon as it starts.
//!
//! Each watch is a task in `Kubepit::manifest_watches` under cluster id `""`
//! (it belongs to no cluster). The task owns the watcher: stopping it
//! (`manifests_unwatch`, shutdown) drops the watcher and its OS resources.
//! Nothing runs unless the UI starts a watch.
//!
//! Limitations: Kustomize bases outside the root folder are not watched,
//! and a symlinked manifest whose target lies outside the watched folders
//! counts in the fingerprint, but edits of the target send no event.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};
use notify::{EventKind, RecursiveMode, Watcher};
use tokio::sync::mpsc;

use super::discover::{fingerprint, resolve, Resolved};
use super::helm_values;
use crate::app::Kubepit;
use crate::types::{ManifestSource, ManifestSourceKind, ManifestsWatchEvent};

/// Quiet time after the last file event before the fingerprint is checked.
pub const WATCH_DEBOUNCE: Duration = Duration::from_millis(300);

/// Folders to watch, and whether recursively. Folders inside a recursively
/// watched one are left out.
fn watch_targets(resolved: &Resolved, extra: &[PathBuf]) -> Vec<(PathBuf, RecursiveMode)> {
    let mut targets: BTreeMap<PathBuf, bool> = BTreeMap::new();
    let mut add = |path: PathBuf, recursive: bool| {
        *targets.entry(path).or_insert(false) |= recursive;
    };
    match resolved.kind {
        ManifestSourceKind::Plain | ManifestSourceKind::Auto => {
            for input in &resolved.inputs {
                if input.is_dir() {
                    add(input.clone(), true);
                } else if let Some(parent) = input.parent() {
                    add(parent.to_path_buf(), false);
                }
            }
        }
        ManifestSourceKind::Kustomize | ManifestSourceKind::Helm => {
            add(resolved.root.clone(), true);
        }
    }
    for file in extra {
        if let Some(parent) = file.parent() {
            add(parent.to_path_buf(), false);
        }
    }
    let recursive: Vec<PathBuf> = targets
        .iter()
        .filter(|(_, recursive)| **recursive)
        .map(|(path, _)| path.clone())
        .collect();
    targets
        .into_iter()
        .filter(|(path, _)| !recursive.iter().any(|r| r != path && path.starts_with(r)))
        .map(|(path, recursive)| {
            let mode = if recursive {
                RecursiveMode::Recursive
            } else {
                RecursiveMode::NonRecursive
            };
            (path, mode)
        })
        .collect()
}

impl Kubepit {
    /// `manifests_watch`: watch the files of `source` and call `on_event`
    /// whenever their fingerprint changes (see the module docs). `since` is
    /// the fingerprint the caller last rendered; when the files already
    /// differ from it, an event is sent right away. Returns the watch id;
    /// the watch ends on [`Self::manifests_unwatch`], at shutdown, or when
    /// `on_event` returns false. The watcher and the baseline fingerprint are
    /// set up before this returns, so no later edit is missed. Must be called
    /// inside a Tokio runtime.
    pub fn manifests_watch<F>(
        &self,
        source: &ManifestSource,
        since: Option<&str>,
        on_event: F,
    ) -> Result<String>
    where
        F: Fn(ManifestsWatchEvent) -> bool + Send + Sync + 'static,
    {
        let resolved = resolve(source)?;
        let extra = helm_values(&resolved, source);
        let (tx, mut rx) = mpsc::unbounded_channel::<()>();
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                // Reads never change a fingerprint (and our own walks cause them).
                // Errors, such as a rescan request, count as a possible edit.
                if !matches!(&event, Ok(e) if matches!(e.kind, EventKind::Access(_))) {
                    let _ = tx.send(());
                }
            })
            .context("could not start watching the manifest files")?;
        for (path, mode) in watch_targets(&resolved, &extra) {
            watcher
                .watch(&path, mode)
                .with_context(|| format!("could not watch {}", path.display()))?;
        }
        let mut last = fingerprint(&resolved, &extra);
        // The caller shows an older state: report the difference at once.
        let changed_since = since.is_some_and(|since| since != last);
        let watch_id = uuid::Uuid::new_v4().to_string();
        let id = watch_id.clone();
        self.manifest_watches.spawn(&watch_id, "", async move {
            // Owned by the task: aborting it drops the watcher.
            let _watcher = watcher;
            if changed_since {
                let event = ManifestsWatchEvent {
                    watch_id: id.clone(),
                    fingerprint: last.clone(),
                };
                if !on_event(event) {
                    return;
                }
            }
            while rx.recv().await.is_some() {
                // Wait until the burst has been quiet for the debounce time.
                loop {
                    match tokio::time::timeout(WATCH_DEBOUNCE, rx.recv()).await {
                        Ok(Some(())) => {}
                        Ok(None) => return,
                        Err(_) => break,
                    }
                }
                let (resolved, extra) = (resolved.clone(), extra.clone());
                let Ok(current) =
                    tokio::task::spawn_blocking(move || fingerprint(&resolved, &extra)).await
                else {
                    return;
                };
                if current == last {
                    continue;
                }
                last = current.clone();
                let event = ManifestsWatchEvent {
                    watch_id: id.clone(),
                    fingerprint: current,
                };
                if !on_event(event) {
                    return;
                }
            }
        });
        Ok(watch_id)
    }

    /// `manifests_unwatch`. Unknown or finished ids are ignored.
    pub fn manifests_unwatch(&self, watch_id: &str) {
        self.manifest_watches.stop(watch_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resolved(kind: ManifestSourceKind, root: &str, inputs: &[&str]) -> Resolved {
        Resolved {
            root: PathBuf::from(root),
            kind,
            inputs: inputs.iter().map(PathBuf::from).collect(),
        }
    }

    #[test]
    fn charts_watch_the_root_and_the_folders_of_outside_values_files() {
        let chart = resolved(ManifestSourceKind::Helm, "/src/chart", &["/src/chart"]);
        let extra = [
            PathBuf::from("/src/chart/values-prod.yaml"),
            PathBuf::from("/src/env/values.yaml"),
        ];
        assert_eq!(
            watch_targets(&chart, &extra),
            vec![
                (PathBuf::from("/src/chart"), RecursiveMode::Recursive),
                (PathBuf::from("/src/env"), RecursiveMode::NonRecursive),
            ]
        );
    }

    #[test]
    fn plain_sources_watch_picked_folders_and_the_folders_of_picked_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("a")).unwrap();
        std::fs::create_dir_all(root.join("b/manifests/extra")).unwrap();
        std::fs::write(root.join("a/app.yaml"), "").unwrap();
        std::fs::write(root.join("b/manifests/extra/x.yaml"), "").unwrap();
        // Picked files never widen the watch to their common ancestor.
        let plain = Resolved {
            root: root.to_path_buf(),
            kind: ManifestSourceKind::Plain,
            inputs: vec![
                root.join("a/app.yaml"),
                root.join("b/manifests"),
                root.join("b/manifests/extra/x.yaml"),
            ],
        };
        assert_eq!(
            watch_targets(&plain, &[]),
            vec![
                (root.join("a"), RecursiveMode::NonRecursive),
                (root.join("b/manifests"), RecursiveMode::Recursive),
            ]
        );
    }
}
