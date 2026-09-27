//! Recently opened manifest sources, `~/.kubepit/manifests.json`.
//!
//! Backend-owned so every window shares one list and a successful render
//! records itself. Entries are keyed by their paths; reopening a source
//! moves it to the front with its latest options (kind, helm values).

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use anyhow::{Context, Result};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::paths::atomic_write;
use crate::types::{ManifestRecent, ManifestSource};

pub const RECENT_FILE: &str = "manifests.json";
pub const MAX_RECENT: usize = 12;

/// Serialises read-modify-write cycles of the file within this process.
static LOCK: LazyLock<Mutex<()>> = LazyLock::new(Default::default);

#[derive(Debug, Default, Serialize, Deserialize)]
struct RecentFile {
    #[serde(default)]
    recent: Vec<ManifestRecent>,
}

pub fn recent_path(root: &Path) -> PathBuf {
    root.join(RECENT_FILE)
}

fn same_paths(a: &[String], b: &[String]) -> bool {
    let norm = |v: &[String]| {
        let mut v: Vec<String> = v
            .iter()
            .map(|p| p.trim().trim_end_matches(['/', '\\']).to_string())
            .collect();
        v.sort();
        v
    };
    norm(a) == norm(b)
}

/// The list, newest first. A missing or unreadable file is an empty list
/// (the list is a convenience; it must never block opening manifests).
pub fn load(root: &Path) -> Vec<ManifestRecent> {
    let path = recent_path(root);
    std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<RecentFile>(&bytes).ok())
        .map(|f| f.recent)
        .unwrap_or_default()
}

fn save(root: &Path, recent: &[ManifestRecent]) -> Result<()> {
    let file = RecentFile {
        recent: recent.to_vec(),
    };
    let bytes = serde_json::to_vec_pretty(&file).context("failed to encode recent manifests")?;
    atomic_write(&recent_path(root), &bytes, false)
}

/// Move `source` to the front (replacing an entry with the same paths).
pub fn remember(root: &Path, source: &ManifestSource, now: i64) -> Result<Vec<ManifestRecent>> {
    let _guard = LOCK.lock();
    let mut recent = load(root);
    recent.retain(|r| !same_paths(&r.source.paths, &source.paths));
    recent.insert(
        0,
        ManifestRecent {
            source: source.clone(),
            opened_at: now,
        },
    );
    recent.truncate(MAX_RECENT);
    save(root, &recent)?;
    Ok(recent)
}

/// Drop the entry with these paths.
pub fn forget(root: &Path, paths: &[String]) -> Result<Vec<ManifestRecent>> {
    let _guard = LOCK.lock();
    let mut recent = load(root);
    recent.retain(|r| !same_paths(&r.source.paths, paths));
    save(root, &recent)?;
    Ok(recent)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{ManifestHelmOptions, ManifestSourceKind};

    fn source(path: &str) -> ManifestSource {
        ManifestSource {
            paths: vec![path.into()],
            kind: ManifestSourceKind::Auto,
            helm: None,
        }
    }

    #[test]
    fn recents_are_deduplicated_ordered_and_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        assert!(load(root).is_empty());
        remember(root, &source("/a"), 1).unwrap();
        remember(root, &source("/b"), 2).unwrap();
        let mut chart = source("/a/");
        chart.kind = ManifestSourceKind::Helm;
        chart.helm = Some(ManifestHelmOptions {
            release_name: "a".into(),
            ..Default::default()
        });
        let list = remember(root, &chart, 3).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].source.kind, ManifestSourceKind::Helm);
        assert_eq!(list[0].opened_at, 3);
        assert_eq!(list[1].source.paths, vec!["/b".to_string()]);
        assert_eq!(load(root), list);

        for i in 0..20 {
            remember(root, &source(&format!("/p{i}")), 10 + i).unwrap();
        }
        let list = load(root);
        assert_eq!(list.len(), MAX_RECENT);
        assert_eq!(list[0].source.paths, vec!["/p19".to_string()]);

        let list = forget(root, &["/p19".into()]).unwrap();
        assert_eq!(list[0].source.paths, vec!["/p18".to_string()]);
        assert_eq!(load(root).len(), MAX_RECENT - 1);

        std::fs::write(recent_path(root), "not json").unwrap();
        assert!(load(root).is_empty());
    }
}
