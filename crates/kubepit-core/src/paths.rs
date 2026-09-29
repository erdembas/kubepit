//! Filesystem layout of the Kubepit data directory.
//!
//! Everything lives under `~/.kubepit/` (overridable with `KUBEPIT_HOME`,
//! which tests always set to a temp dir):
//!
//! | Path                    | Content                                           |
//! |-------------------------|---------------------------------------------------|
//! | `clusters.json`         | registered clusters (`ClusterDef[]`)              |
//! | `settings.json`         | user preferences                                  |
//! | `workspace.json`        | opaque UI snapshot owned by the frontend          |
//! | `kubeconfigs/<storage-id>.yaml` | imported/pasted kubeconfigs, mode 0600    |
//! | `run/<id>.kubeconfig`   | generated single-context kubeconfig, mode 0600    |
//! | `port_forwards.json`    | saved port forwards (`SavedPortForward[]`)        |
//! | `history.db`            | audit log, persisted events / changes (SQLite)    |
//! | `actions.json`          | custom actions (`CustomActionsFile`)              |
//!
//! All writes go through [`atomic_write`] so a crash mid-write can never leave
//! a truncated `clusters.json` behind.

use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};

/// Environment variable that relocates the data directory.
pub const HOME_ENV: &str = "KUBEPIT_HOME";

/// Resolve the data directory: `$KUBEPIT_HOME` when non-empty, else `~/.kubepit`.
pub fn kubepit_home() -> Result<PathBuf> {
    if let Some(custom) = std::env::var_os(HOME_ENV) {
        if !custom.is_empty() {
            return Ok(PathBuf::from(custom));
        }
    }
    let home = dirs::home_dir().context("could not determine the user home directory")?;
    Ok(home.join(".kubepit"))
}

/// Typed accessors for every file Kubepit owns.
#[derive(Debug, Clone)]
pub struct Paths {
    root: PathBuf,
}

impl Paths {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// Paths rooted at [`kubepit_home`].
    pub fn from_env() -> Result<Self> {
        Ok(Self::new(kubepit_home()?))
    }

    /// Create the data directory tree. Idempotent.
    pub fn ensure_dirs(&self) -> Result<()> {
        for dir in [self.root.clone(), self.kubeconfigs_dir(), self.run_dir()] {
            std::fs::create_dir_all(&dir)
                .with_context(|| format!("failed to create {}", dir.display()))?;
        }
        // Generated kubeconfigs carry credentials; keep the folders private too.
        set_private_dir(&self.kubeconfigs_dir());
        set_private_dir(&self.run_dir());
        Ok(())
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn clusters_file(&self) -> PathBuf {
        self.root.join("clusters.json")
    }

    pub fn settings_file(&self) -> PathBuf {
        self.root.join("settings.json")
    }

    pub fn workspace_file(&self) -> PathBuf {
        self.root.join("workspace.json")
    }

    /// Saved port forwards (connectivity).
    pub fn port_forwards_file(&self) -> PathBuf {
        self.root.join("port_forwards.json")
    }

    /// Persistent history (SQLite, WAL mode; `-wal` / `-shm` next to it).
    pub fn history_db(&self) -> PathBuf {
        self.root.join("history.db")
    }

    /// Custom actions (power user).
    pub fn custom_actions_file(&self) -> PathBuf {
        self.root.join("actions.json")
    }

    pub fn kubeconfigs_dir(&self) -> PathBuf {
        self.root.join("kubeconfigs")
    }

    pub fn run_dir(&self) -> PathBuf {
        self.root.join("run")
    }

    /// Where the managed kubeconfig for storage `id` is stored.
    pub fn managed_kubeconfig(&self, id: &str) -> Result<PathBuf> {
        validate_id(id)?;
        Ok(self.kubeconfigs_dir().join(format!("{id}.yaml")))
    }

    /// The generated single-context kubeconfig for cluster `id`.
    pub fn run_kubeconfig(&self, id: &str) -> Result<PathBuf> {
        validate_id(id)?;
        Ok(self.run_dir().join(format!("{id}.kubeconfig")))
    }

    /// True when `path` is a file Kubepit manages (inside `kubeconfigs/`).
    /// Guards deletes so a hand-edited `clusters.json` can never make us
    /// remove a user's own kubeconfig.
    pub fn is_managed_path(&self, path: &Path) -> bool {
        let dir = self.kubeconfigs_dir();
        match (dir.canonicalize(), path.canonicalize()) {
            (Ok(dir), Ok(path)) => path.starts_with(dir),
            _ => path.starts_with(&dir),
        }
    }
}

/// Ids become file names; accept only the characters uuids use so a crafted
/// id can never escape the data directory.
pub fn validate_id(id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        bail!("invalid id {id:?}");
    }
    Ok(())
}

/// Write `bytes` to `path` atomically: write a sibling temp file, fsync,
/// then rename over the target. With `private`, the file is created with
/// mode 0600 (Unix) *before* any byte is written, so credentials are never
/// world-readable, not even briefly.
pub fn atomic_write(path: &Path, bytes: &[u8], private: bool) -> Result<()> {
    let dir = path
        .parent()
        .with_context(|| format!("{} has no parent directory", path.display()))?;
    std::fs::create_dir_all(dir).with_context(|| format!("failed to create {}", dir.display()))?;
    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let tmp = dir.join(format!(
        ".{file_name}.{}.tmp",
        uuid::Uuid::new_v4().simple()
    ));

    let result = (|| -> Result<()> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(if private { 0o600 } else { 0o644 });
        }
        let mut file = options
            .open(&tmp)
            .with_context(|| format!("failed to create {}", tmp.display()))?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&tmp, path)
            .with_context(|| format!("failed to replace {}", path.display()))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

fn set_private_dir(dir: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
    }
}

/// Expand a leading `~` / `~/` to the home directory. Everything else is
/// returned unchanged.
pub fn expand_tilde(path: &str) -> PathBuf {
    if path == "~" {
        if let Some(home) = dirs::home_dir() {
            return home;
        }
    }
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_cannot_escape_the_data_dir() {
        let paths = Paths::new("/tmp/kp");
        assert!(paths.run_kubeconfig("../../etc/passwd").is_err());
        assert!(paths.managed_kubeconfig("a/b").is_err());
        assert!(paths.managed_kubeconfig("").is_err());
        assert_eq!(
            paths
                .run_kubeconfig("0b8f5a1e-3c55-4f0e-9a51-6c6f7f1c2d3e")
                .unwrap(),
            PathBuf::from("/tmp/kp/run/0b8f5a1e-3c55-4f0e-9a51-6c6f7f1c2d3e.kubeconfig")
        );
    }

    #[test]
    fn atomic_write_replaces_and_sets_private_mode() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("nested/secret.yaml");
        atomic_write(&target, b"one", true).unwrap();
        atomic_write(&target, b"two", true).unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "two");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&target).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        // No temp files are left behind.
        let leftovers: Vec<_> = std::fs::read_dir(target.parent().unwrap())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn managed_path_detection() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path());
        paths.ensure_dirs().unwrap();
        let inside = paths.managed_kubeconfig("abc").unwrap();
        std::fs::write(&inside, "x").unwrap();
        assert!(paths.is_managed_path(&inside));
        let outside = dir.path().join("other.yaml");
        std::fs::write(&outside, "x").unwrap();
        assert!(!paths.is_managed_path(&outside));
    }
}
