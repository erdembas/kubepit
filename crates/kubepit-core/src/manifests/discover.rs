//! Finding manifests on disk: resolving what the user picked into a root
//! and a kind, walking plain folders (with limits), and fingerprinting a
//! source so the UI can notice edits.
//!
//! Walks skip hidden entries (`.git`, `.github`, editor folders) and
//! `node_modules`, never follow symbolic links to folders (no cycles), and
//! stop at [`MAX_FILES`] / [`MAX_DEPTH`]. Inside a plain folder, sub-folders
//! that are Kustomize directories or Helm charts are not read as plain YAML
//! (their files are inputs to a tool, not objects); they are reported as
//! [`ManifestNested`] so the UI can open them on their own.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use anyhow::{bail, Result};

use super::parse::{Format, Parsed};
use crate::paths::expand_tilde;
use crate::types::{ManifestNested, ManifestProblem, ManifestSource, ManifestSourceKind};

/// Largest single file read as a manifest.
pub const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
/// Most bytes read over one plain render.
pub const MAX_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
/// Most files one walk visits.
pub const MAX_FILES: usize = 5000;
/// Deepest folder level a walk descends to.
pub const MAX_DEPTH: usize = 24;

const SKIP_DIRS: &[&str] = &["node_modules"];
pub const KUSTOMIZATION_FILES: &[&str] =
    &["kustomization.yaml", "kustomization.yml", "Kustomization"];
pub const CHART_FILE: &str = "Chart.yaml";

/// `.yaml` / `.yml` / `.json` (any case).
pub fn manifest_format(path: &Path) -> Option<Format> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    match ext.as_str() {
        "yaml" | "yml" => Some(Format::Yaml),
        "json" => Some(Format::Json),
        _ => None,
    }
}

/// The kustomization file of `dir`, if it is a Kustomize directory.
pub fn kustomization_file(dir: &Path) -> Option<&'static str> {
    KUSTOMIZATION_FILES
        .iter()
        .copied()
        .find(|name| dir.join(name).is_file())
}

/// What `auto` means for one folder.
pub fn detect_kind(dir: &Path) -> ManifestSourceKind {
    if kustomization_file(dir).is_some() {
        ManifestSourceKind::Kustomize
    } else if dir.join(CHART_FILE).is_file() {
        ManifestSourceKind::Helm
    } else {
        ManifestSourceKind::Plain
    }
}

/// `path` relative to `root`, `/` separated; the path itself when outside.
pub fn relative(root: &Path, path: &Path) -> String {
    match path.strip_prefix(root) {
        Ok(rel) if rel.as_os_str().is_empty() => ".".to_string(),
        Ok(rel) => rel
            .components()
            .filter_map(|c| match c {
                Component::Normal(part) => Some(part.to_string_lossy().to_string()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("/"),
        Err(_) => path.to_string_lossy().to_string(),
    }
}

/// A source resolved against the filesystem.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    pub root: PathBuf,
    /// Never `Auto`.
    pub kind: ManifestSourceKind,
    pub inputs: Vec<PathBuf>,
}

fn common_ancestor(paths: &[PathBuf]) -> PathBuf {
    let mut iter = paths.iter();
    let Some(first) = iter.next() else {
        return PathBuf::new();
    };
    let mut common: PathBuf = first.clone();
    for path in iter {
        while !path.starts_with(&common) {
            if !common.pop() {
                return PathBuf::new();
            }
        }
    }
    common
}

/// Check the picked paths and settle root and kind (see [`ManifestSourceKind`]).
pub fn resolve(source: &ManifestSource) -> Result<Resolved> {
    let mut inputs = Vec::new();
    for raw in source
        .paths
        .iter()
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
    {
        let path = expand_tilde(raw);
        if !path.is_absolute() {
            bail!("{raw} is not an absolute path");
        }
        if !path.exists() {
            bail!("{raw} does not exist");
        }
        if !inputs.contains(&path) {
            inputs.push(path);
        }
    }
    if inputs.is_empty() {
        bail!("pick a folder or manifest files first");
    }
    let single_dir = match inputs.as_slice() {
        [only] if only.is_dir() => Some(only.clone()),
        _ => None,
    };
    let kind = match (source.kind, &single_dir) {
        (ManifestSourceKind::Auto, Some(dir)) => detect_kind(dir),
        (ManifestSourceKind::Auto | ManifestSourceKind::Plain, _) => ManifestSourceKind::Plain,
        (ManifestSourceKind::Kustomize, Some(dir)) => {
            if kustomization_file(dir).is_none() {
                bail!(
                    "{} has no kustomization.yaml, so it cannot be rendered with Kustomize",
                    dir.display()
                );
            }
            ManifestSourceKind::Kustomize
        }
        (ManifestSourceKind::Helm, Some(dir)) => {
            if !dir.join(CHART_FILE).is_file() {
                bail!("{} is not a Helm chart (no Chart.yaml)", dir.display());
            }
            ManifestSourceKind::Helm
        }
        (ManifestSourceKind::Kustomize | ManifestSourceKind::Helm, None) => {
            bail!("Kustomize and Helm render one folder; pick a single folder")
        }
    };
    let root = match &single_dir {
        Some(dir) => dir.clone(),
        None => {
            let bases: Vec<PathBuf> = inputs
                .iter()
                .map(|p| {
                    if p.is_dir() {
                        p.clone()
                    } else {
                        p.parent().map(Path::to_path_buf).unwrap_or_default()
                    }
                })
                .collect();
            common_ancestor(&bases)
        }
    };
    Ok(Resolved { root, kind, inputs })
}

/// What a walk found.
#[derive(Debug, Default)]
pub struct Walk {
    /// Files in visiting order (sorted by name per folder).
    pub files: Vec<PathBuf>,
    pub problems: Vec<ManifestProblem>,
    pub nested: Vec<ManifestNested>,
    truncated: bool,
}

#[derive(Debug, Clone, Copy)]
struct WalkMode {
    /// Only `.yaml` / `.yml` / `.json` files.
    manifests_only: bool,
    /// Report Kustomize / Helm sub-folders instead of descending into them.
    stop_at_nested: bool,
}

impl Walk {
    fn problem(&mut self, root: &Path, path: &Path, message: impl Into<String>) {
        self.problems.push(ManifestProblem {
            source: relative(root, path),
            line: 0,
            message: message.into(),
        });
    }

    fn push_file(&mut self, root: &Path, path: PathBuf) {
        if self.files.len() >= MAX_FILES {
            if !self.truncated {
                self.truncated = true;
                self.problem(
                    root,
                    &path,
                    format!("stopped after {MAX_FILES} files; the rest was not read"),
                );
            }
            return;
        }
        self.files.push(path);
    }

    fn dir(&mut self, root: &Path, dir: &Path, depth: usize, mode: WalkMode) {
        if self.truncated {
            return;
        }
        let mut entries: Vec<_> = match std::fs::read_dir(dir) {
            Ok(entries) => entries.flatten().collect(),
            Err(e) => {
                self.problem(root, dir, format!("cannot read folder: {e}"));
                return;
            }
        };
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let is_dir = if file_type.is_symlink() {
                match std::fs::metadata(&path) {
                    Ok(meta) if meta.is_dir() => {
                        self.problem(root, &path, "skipped: symbolic link to a folder");
                        continue;
                    }
                    Ok(meta) if meta.is_file() => false,
                    // Dangling links and special files.
                    _ => continue,
                }
            } else {
                file_type.is_dir()
            };
            if is_dir {
                if SKIP_DIRS.contains(&name.as_str()) {
                    continue;
                }
                if mode.stop_at_nested {
                    let kind = detect_kind(&path);
                    if kind != ManifestSourceKind::Plain {
                        self.nested.push(ManifestNested {
                            path: path.to_string_lossy().to_string(),
                            relative: relative(root, &path),
                            kind,
                        });
                        continue;
                    }
                }
                if depth + 1 >= MAX_DEPTH {
                    self.problem(root, &path, "skipped: folder nested too deeply");
                    continue;
                }
                self.dir(root, &path, depth + 1, mode);
            } else if !mode.manifests_only || manifest_format(&path).is_some() {
                self.push_file(root, path);
            }
        }
    }
}

/// Plain sources: every manifest file under the picked folders plus the
/// picked files themselves (whatever their extension).
pub fn walk_plain(resolved: &Resolved) -> Walk {
    let mut walk = Walk::default();
    let mode = WalkMode {
        manifests_only: true,
        stop_at_nested: true,
    };
    for input in &resolved.inputs {
        if input.is_dir() {
            walk.dir(&resolved.root, input, 0, mode);
        } else {
            walk.push_file(&resolved.root, input.clone());
        }
    }
    walk
}

/// Read and parse the files of a plain walk, within the size limits.
pub fn read_plain(root: &Path, files: &[PathBuf], parsed: &mut Parsed) -> usize {
    let mut total: u64 = 0;
    let mut read = 0;
    for path in files {
        let source = relative(root, path);
        let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        if size > MAX_FILE_BYTES {
            parsed.problem(
                &source,
                0,
                format!(
                    "skipped: larger than {} MiB",
                    MAX_FILE_BYTES / (1024 * 1024)
                ),
            );
            continue;
        }
        if total + size > MAX_TOTAL_BYTES {
            parsed.problem(
                &source,
                0,
                format!(
                    "stopped after {} MiB of manifests; the rest was not read",
                    MAX_TOTAL_BYTES / (1024 * 1024)
                ),
            );
            break;
        }
        total += size;
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(e) => {
                parsed.problem(&source, 0, format!("cannot read file: {e}"));
                continue;
            }
        };
        let Ok(text) = String::from_utf8(bytes) else {
            parsed.problem(&source, 0, "skipped: not UTF-8 text");
            continue;
        };
        read += 1;
        let format = manifest_format(path).unwrap_or(Format::Yaml);
        parsed.add_text(&text, &source, format);
    }
    read
}

/// A cheap change detector: hashes path, size and modification time of
/// every file the source depends on (for Kustomize and Helm: every file
/// under the folder, plus explicit `extra` files such as values files).
pub fn fingerprint(resolved: &Resolved, extra: &[PathBuf]) -> String {
    let files = match resolved.kind {
        ManifestSourceKind::Plain | ManifestSourceKind::Auto => walk_plain(resolved).files,
        ManifestSourceKind::Kustomize | ManifestSourceKind::Helm => {
            let mut walk = Walk::default();
            walk.dir(
                &resolved.root,
                &resolved.root,
                0,
                WalkMode {
                    manifests_only: false,
                    stop_at_nested: false,
                },
            );
            walk.files
        }
    };
    let mut hasher = DefaultHasher::new();
    for path in files.iter().chain(extra) {
        path.hash(&mut hasher);
        if let Ok(meta) = std::fs::metadata(path) {
            meta.len().hash(&mut hasher);
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            modified.hash(&mut hasher);
        }
    }
    format!("{:016x}", hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(root: &Path, rel: &str, content: &str) -> PathBuf {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, content).unwrap();
        path
    }

    fn source(paths: &[&Path], kind: ManifestSourceKind) -> ManifestSource {
        ManifestSource {
            paths: paths
                .iter()
                .map(|p| p.to_string_lossy().to_string())
                .collect(),
            kind,
            helm: None,
        }
    }

    #[test]
    fn plain_walk_skips_hidden_vendored_and_tool_folders() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(root, "b.yaml", "kind: B");
        write(root, "a.yml", "kind: A");
        write(root, "c.json", "{}");
        write(root, "README.md", "# docs");
        write(root, "apps/web/deploy.YAML", "kind: D");
        write(root, ".git/config.yaml", "x: 1");
        write(root, ".github/workflows/ci.yml", "on: push");
        write(root, "node_modules/pkg/x.yaml", "x: 1");
        write(root, "overlays/prod/kustomization.yaml", "resources: []");
        write(root, "overlays/prod/patch.yaml", "kind: P");
        write(root, "charts/shop/Chart.yaml", "name: shop");
        write(root, "charts/shop/templates/svc.yaml", "{{ .Values }}");

        let resolved = resolve(&source(&[root], ManifestSourceKind::Auto)).unwrap();
        assert_eq!(resolved.kind, ManifestSourceKind::Plain);
        assert_eq!(resolved.root, root);
        let walk = walk_plain(&resolved);
        let files: Vec<String> = walk.files.iter().map(|f| relative(root, f)).collect();
        assert_eq!(
            files,
            vec!["a.yml", "apps/web/deploy.YAML", "b.yaml", "c.json"]
        );
        let nested: Vec<(String, ManifestSourceKind)> = walk
            .nested
            .iter()
            .map(|n| (n.relative.clone(), n.kind))
            .collect();
        assert_eq!(
            nested,
            vec![
                ("charts/shop".to_string(), ManifestSourceKind::Helm),
                ("overlays/prod".to_string(), ManifestSourceKind::Kustomize),
            ]
        );
        assert!(walk.problems.is_empty(), "{:?}", walk.problems);
    }

    #[test]
    fn auto_detects_kustomize_and_helm_folders() {
        let dir = tempfile::tempdir().unwrap();
        let kustomize = dir.path().join("k");
        write(&kustomize, "kustomization.yml", "resources: []");
        let chart = dir.path().join("c");
        write(&chart, "Chart.yaml", "name: c");
        let auto = |p: &Path| resolve(&source(&[p], ManifestSourceKind::Auto)).unwrap();
        assert_eq!(auto(&kustomize).kind, ManifestSourceKind::Kustomize);
        assert_eq!(auto(&chart).kind, ManifestSourceKind::Helm);
        // Explicit plain wins over detection.
        let plain = resolve(&source(&[&chart], ManifestSourceKind::Plain)).unwrap();
        assert_eq!(plain.kind, ManifestSourceKind::Plain);
        // Explicit kinds are checked.
        let err = resolve(&source(&[&chart], ManifestSourceKind::Kustomize)).unwrap_err();
        assert!(err.to_string().contains("no kustomization.yaml"), "{err}");
        let err = resolve(&source(&[&kustomize], ManifestSourceKind::Helm)).unwrap_err();
        assert!(err.to_string().contains("not a Helm chart"), "{err}");
    }

    #[test]
    fn picked_files_share_a_root_and_paths_are_validated() {
        let dir = tempfile::tempdir().unwrap();
        let a = write(dir.path(), "team/a/app.yaml", "kind: A");
        let b = write(dir.path(), "team/b/notes.txt", "kind: B");
        let resolved = resolve(&source(&[&a, &b], ManifestSourceKind::Auto)).unwrap();
        assert_eq!(resolved.kind, ManifestSourceKind::Plain);
        assert_eq!(resolved.root, dir.path().join("team"));
        // Picked files are read whatever their extension.
        let files: Vec<String> = walk_plain(&resolved)
            .files
            .iter()
            .map(|f| relative(&resolved.root, f))
            .collect();
        assert_eq!(files, vec!["a/app.yaml", "b/notes.txt"]);

        let err = resolve(&source(&[], ManifestSourceKind::Auto)).unwrap_err();
        assert!(err.to_string().contains("pick a folder"), "{err}");
        let err = resolve(&ManifestSource {
            paths: vec!["relative/dir".into()],
            ..Default::default()
        })
        .unwrap_err();
        assert!(err.to_string().contains("not an absolute path"), "{err}");
        let missing = dir.path().join("missing");
        let err = resolve(&source(&[&missing], ManifestSourceKind::Auto)).unwrap_err();
        assert!(err.to_string().contains("does not exist"), "{err}");
        let err = resolve(&source(&[&a, &b], ManifestSourceKind::Helm)).unwrap_err();
        assert!(err.to_string().contains("single folder"), "{err}");
    }

    #[test]
    fn reading_respects_size_limits_and_reports_problems() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(
            root,
            "ok.yaml",
            "apiVersion: v1\nkind: ConfigMap\nmetadata: {name: a}\n",
        );
        let big = root.join("big.yaml");
        let file = fs::File::create(&big).unwrap();
        file.set_len(MAX_FILE_BYTES + 1).unwrap();
        fs::write(root.join("binary.yaml"), [0xff, 0xfe, 0x00]).unwrap();
        let resolved = resolve(&source(&[root], ManifestSourceKind::Plain)).unwrap();
        let walk = walk_plain(&resolved);
        let mut parsed = Parsed::default();
        let read = read_plain(root, &walk.files, &mut parsed);
        assert_eq!(read, 1);
        assert_eq!(parsed.documents.len(), 1);
        assert_eq!(parsed.documents[0].source, "ok.yaml");
        let problems: Vec<(String, bool)> = parsed
            .problems
            .iter()
            .map(|p| (p.source.clone(), p.message.contains("skipped")))
            .collect();
        assert_eq!(
            problems,
            vec![
                ("big.yaml".to_string(), true),
                ("binary.yaml".to_string(), true)
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_folders_are_not_followed() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root");
        write(&root, "a.yaml", "kind: A");
        std::os::unix::fs::symlink(&root, root.join("loop")).unwrap();
        std::os::unix::fs::symlink(root.join("a.yaml"), root.join("link.yaml")).unwrap();
        let resolved = resolve(&source(&[&root], ManifestSourceKind::Plain)).unwrap();
        let walk = walk_plain(&resolved);
        let files: Vec<String> = walk.files.iter().map(|f| relative(&root, f)).collect();
        assert_eq!(files, vec!["a.yaml", "link.yaml"]);
        assert_eq!(walk.problems.len(), 1);
        assert!(walk.problems[0].message.contains("symbolic link"));
    }

    #[test]
    fn fingerprint_changes_with_the_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let file = write(root, "a.yaml", "kind: A");
        let resolved = resolve(&source(&[root], ManifestSourceKind::Plain)).unwrap();
        let first = fingerprint(&resolved, &[]);
        assert_eq!(first, fingerprint(&resolved, &[]));
        fs::write(&file, "kind: A\nmore: true\n").unwrap();
        let second = fingerprint(&resolved, &[]);
        assert_ne!(first, second);
        write(root, "b.yaml", "kind: B");
        assert_ne!(second, fingerprint(&resolved, &[]));
        // Non-manifest files do not matter for plain folders...
        let third = fingerprint(&resolved, &[]);
        write(root, "notes.txt", "hello");
        assert_eq!(third, fingerprint(&resolved, &[]));
        // ...but every file of a chart does.
        write(root, "Chart.yaml", "name: c");
        let chart = resolve(&source(&[root], ManifestSourceKind::Auto)).unwrap();
        assert_eq!(chart.kind, ManifestSourceKind::Helm);
        let before = fingerprint(&chart, &[]);
        write(root, "templates/NOTES.txt", "thanks");
        assert_ne!(before, fingerprint(&chart, &[]));
    }
}
