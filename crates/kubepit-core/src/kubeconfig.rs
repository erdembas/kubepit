//! Kubeconfig discovery, parsing and single-context generation.
//!
//! Kubepit never rewrites a user's kubeconfig. It reads them with
//! [`kube::config::Kubeconfig`] (which also resolves relative certificate /
//! token paths against the file's directory) and, per registered cluster,
//! writes a *derived* single-context file to `run/<id>.kubeconfig`. That file
//! is what `kubectl`, `helm` and cluster terminals get via `--kubeconfig` /
//! `KUBECONFIG`, so external tools see exactly one context and cannot
//! accidentally act on another cluster.
//!
//! Credential hygiene: nothing in this module logs file contents. Parse
//! errors are surfaced to the UI in `KubeconfigSource::error`, never traced.

use std::collections::HashSet;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use kube::config::{Kubeconfig, NamedAuthInfo, NamedCluster, NamedContext};

use crate::paths::expand_tilde;
use crate::types::{KubeconfigContext, KubeconfigSource};

/// Files found by scanning a directory are skipped above this size: real
/// kubeconfigs are a few KB, anything larger is a cache or a binary.
const SCAN_MAX_BYTES: u64 = 2 * 1024 * 1024;
/// Hard guard for files the user pointed at explicitly.
const EXPLICIT_MAX_BYTES: u64 = 16 * 1024 * 1024;

/// Read a kubeconfig from disk (multi-document files are merged, relative
/// file references become absolute).
pub fn load(path: &Path) -> Result<Kubeconfig> {
    Kubeconfig::read_from(path).map_err(|e| anyhow!("{e}"))
}

/// Parse pasted kubeconfig text.
pub fn load_text(text: &str) -> Result<Kubeconfig> {
    Kubeconfig::from_yaml(text).map_err(|e| anyhow!("{e}"))
}

/// `kubeconfig_parse_file`: never fails; problems land in `error`.
pub fn parse_file(path: &Path) -> KubeconfigSource {
    let display = canonical_or_given(path);
    let path_str = display.to_string_lossy().to_string();
    match std::fs::metadata(path) {
        Err(e) => {
            let message = format!("cannot read {path_str}: {e}");
            return source_error(path_str, message);
        }
        Ok(meta) if !meta.is_file() => {
            let message = format!("{path_str} is not a file");
            return source_error(path_str, message);
        }
        Ok(meta) if meta.len() > EXPLICIT_MAX_BYTES => {
            return source_error(path_str, "file is too large to be a kubeconfig".to_string())
        }
        Ok(_) => {}
    }
    match load(path) {
        Ok(kc) => {
            let mut source = source_from(path_str, &kc);
            if source.contexts.is_empty() {
                source.error = Some("No contexts found in this kubeconfig".to_string());
            }
            source
        }
        Err(e) => source_error(path_str, format!("{e:#}")),
    }
}

/// `kubeconfig_parse_text`: never fails; problems land in `error`.
pub fn parse_text(text: &str) -> KubeconfigSource {
    match load_text(text) {
        Ok(kc) => {
            let mut source = source_from(String::new(), &kc);
            if source.contexts.is_empty() {
                source.error = Some("No contexts found in the pasted kubeconfig".to_string());
            }
            source
        }
        Err(e) => source_error(String::new(), format!("{e:#}")),
    }
}

fn source_error(path: String, error: String) -> KubeconfigSource {
    KubeconfigSource {
        path,
        contexts: Vec::new(),
        current_context: None,
        error: Some(error),
    }
}

/// Summarise a parsed kubeconfig for the import dialog.
pub fn source_from(path: String, kc: &Kubeconfig) -> KubeconfigSource {
    let contexts = kc
        .contexts
        .iter()
        .map(|named| {
            let ctx = named.context.as_ref();
            let cluster = ctx.map(|c| c.cluster.clone()).unwrap_or_default();
            KubeconfigContext {
                name: named.name.clone(),
                server: find_cluster(kc, &cluster)
                    .and_then(|c| c.cluster.as_ref())
                    .and_then(|c| c.server.clone()),
                cluster,
                user: ctx.and_then(|c| c.user.clone()).unwrap_or_default(),
                namespace: ctx.and_then(|c| c.namespace.clone()),
            }
        })
        .collect();
    KubeconfigSource {
        path,
        contexts,
        current_context: kc.current_context.clone().filter(|c| !c.is_empty()),
        error: None,
    }
}

/// `kubeconfig_discover`: every kubeconfig on this machine Kubepit knows how
/// to find, deduplicated by canonical path.
pub fn discover(sync_paths: &[String]) -> Vec<KubeconfigSource> {
    discover_with(dirs::home_dir().as_deref(), kubeconfig_env(), sync_paths)
}

/// `$KUBECONFIG` of this process, or — for Finder/Dock launches, which do
/// not inherit shell variables — as the user's login shell exports it.
/// The shell probe runs at most once per process.
fn kubeconfig_env() -> Option<OsString> {
    static FROM_LOGIN_SHELL: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    std::env::var_os("KUBECONFIG")
        .filter(|v| !v.is_empty())
        .or_else(|| {
            FROM_LOGIN_SHELL
                .get_or_init(|| crate::shell_env::login_shell_var("KUBECONFIG"))
                .clone()
                .map(OsString::from)
        })
}

/// Testable core of [`discover`].
///
/// Order (first occurrence of a path wins):
/// 1. every entry of `$KUBECONFIG`,
/// 2. `~/.kube/config`,
/// 3. every regular file directly inside `~/.kube/` (directories such as
///    `cache/` and `http-cache/` are skipped, as are hidden files, files over
///    2 MB and files that are not kubeconfigs with at least one context),
/// 4. `settings.kubeconfig_sync_paths` — files are explicit entries,
///    directories are scanned like `~/.kube/`.
///
/// Explicit entries (1, 2, sync files) are reported even when they fail to
/// parse, so the user sees *why*; scanned files are skipped silently.
pub fn discover_with(
    home: Option<&Path>,
    kubeconfig_env: Option<OsString>,
    sync_paths: &[String],
) -> Vec<KubeconfigSource> {
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut out = Vec::new();

    if let Some(env) = kubeconfig_env {
        for entry in std::env::split_paths(&env) {
            if !entry.as_os_str().is_empty() {
                add_explicit(&entry, &mut seen, &mut out);
            }
        }
    }
    if let Some(home) = home {
        let kube_dir = home.join(".kube");
        add_explicit(&kube_dir.join("config"), &mut seen, &mut out);
        scan_dir(&kube_dir, &mut seen, &mut out);
    }
    for raw in sync_paths {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let path = expand_tilde(trimmed);
        if path.is_dir() {
            scan_dir(&path, &mut seen, &mut out);
        } else {
            add_explicit(&path, &mut seen, &mut out);
        }
    }
    out
}

fn canonical_or_given(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn add_explicit(path: &Path, seen: &mut HashSet<PathBuf>, out: &mut Vec<KubeconfigSource>) {
    if !path.is_file() {
        return;
    }
    let canonical = canonical_or_given(path);
    if !seen.insert(canonical.clone()) {
        return;
    }
    out.push(parse_file(&canonical));
}

fn scan_dir(dir: &Path, seen: &mut HashSet<PathBuf>, out: &mut Vec<KubeconfigSource>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .filter(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
        .map(|entry| entry.path())
        .collect();
    files.sort();
    for path in files {
        // `metadata` follows symlinks, so a symlinked kubeconfig still counts.
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        if !meta.is_file() || meta.len() == 0 || meta.len() > SCAN_MAX_BYTES {
            continue;
        }
        let canonical = canonical_or_given(&path);
        if seen.contains(&canonical) {
            continue;
        }
        let Ok(kc) = load(&canonical) else {
            continue;
        };
        if kc.contexts.is_empty() {
            continue;
        }
        seen.insert(canonical.clone());
        out.push(source_from(canonical.to_string_lossy().to_string(), &kc));
    }
}

fn find_cluster<'a>(kc: &'a Kubeconfig, name: &str) -> Option<&'a NamedCluster> {
    kc.clusters.iter().find(|c| c.name == name)
}

fn find_user<'a>(kc: &'a Kubeconfig, name: &str) -> Option<&'a NamedAuthInfo> {
    kc.auth_infos.iter().find(|u| u.name == name)
}

fn find_context<'a>(kc: &'a Kubeconfig, name: &str) -> Option<&'a NamedContext> {
    kc.contexts.iter().find(|c| c.name == name)
}

/// Fail with a helpful message when `context` is not defined in `kc`.
pub fn ensure_context(kc: &Kubeconfig, context: &str) -> Result<()> {
    if find_context(kc, context).is_some() {
        return Ok(());
    }
    let available: Vec<&str> = kc.contexts.iter().map(|c| c.name.as_str()).collect();
    if available.is_empty() {
        Err(anyhow!(
            "context \"{context}\" not found: the kubeconfig defines no contexts"
        ))
    } else {
        Err(anyhow!(
            "context \"{context}\" not found (available: {})",
            available.join(", ")
        ))
    }
}

/// API server URL of `context`, if the kubeconfig defines one.
pub fn server_for_context(kc: &Kubeconfig, context: &str) -> Option<String> {
    let ctx = find_context(kc, context)?.context.as_ref()?;
    find_cluster(kc, &ctx.cluster)?
        .cluster
        .as_ref()?
        .server
        .clone()
}

/// Default namespace configured on `context`.
pub fn namespace_for_context(kc: &Kubeconfig, context: &str) -> Option<String> {
    find_context(kc, context)?
        .context
        .as_ref()?
        .namespace
        .clone()
        .filter(|ns| !ns.is_empty())
}

/// Build a kubeconfig containing only `context`, its cluster and its user,
/// with `current-context` set. This is what external tools receive.
pub fn single_context(kc: &Kubeconfig, context: &str) -> Result<Kubeconfig> {
    ensure_context(kc, context)?;
    let named_ctx = find_context(kc, context)
        .cloned()
        .context("context disappeared while building kubeconfig")?;
    let ctx = named_ctx
        .context
        .as_ref()
        .with_context(|| format!("context \"{context}\" has no cluster/user definition"))?;
    let cluster = find_cluster(kc, &ctx.cluster).cloned().with_context(|| {
        format!(
            "cluster \"{}\" referenced by context \"{context}\" is not defined",
            ctx.cluster
        )
    })?;
    let users = match ctx.user.as_deref().filter(|u| !u.is_empty()) {
        Some(user) => vec![find_user(kc, user).cloned().with_context(|| {
            format!("user \"{user}\" referenced by context \"{context}\" is not defined")
        })?],
        None => Vec::new(),
    };
    Ok(Kubeconfig {
        preferences: None,
        clusters: vec![cluster],
        auth_infos: users,
        contexts: vec![named_ctx],
        current_context: Some(context.to_string()),
        extensions: None,
        kind: Some("Config".to_string()),
        api_version: Some("v1".to_string()),
        other: Default::default(),
    })
}

/// Serialise a kubeconfig as YAML.
pub fn to_yaml(kc: &Kubeconfig) -> Result<String> {
    serde_yaml::to_string(kc).context("failed to serialise kubeconfig")
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) const TWO_CONTEXTS: &str = r#"
apiVersion: v1
kind: Config
current-context: dev
clusters:
- name: dev-cluster
  cluster:
    server: https://dev.example.test:6443
    certificate-authority: ca.crt
- name: prod-cluster
  cluster:
    server: https://ABC.gr7.eu-west-1.eks.amazonaws.com
users:
- name: dev-user
  user:
    token: dev-token-value
- name: prod-user
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: aws
      args: ["eks", "get-token", "--cluster-name", "prod"]
contexts:
- name: dev
  context:
    cluster: dev-cluster
    user: dev-user
    namespace: team-a
- name: prod
  context:
    cluster: prod-cluster
    user: prod-user
"#;

    #[test]
    fn parse_text_lists_contexts_with_servers() {
        let src = parse_text(TWO_CONTEXTS);
        assert_eq!(src.error, None);
        assert_eq!(src.path, "");
        assert_eq!(src.current_context.as_deref(), Some("dev"));
        assert_eq!(src.contexts.len(), 2);
        let dev = &src.contexts[0];
        assert_eq!(dev.name, "dev");
        assert_eq!(dev.cluster, "dev-cluster");
        assert_eq!(dev.user, "dev-user");
        assert_eq!(dev.namespace.as_deref(), Some("team-a"));
        assert_eq!(dev.server.as_deref(), Some("https://dev.example.test:6443"));
        assert_eq!(src.contexts[1].namespace, None);
    }

    #[test]
    fn parse_errors_are_reported_not_raised() {
        let src = parse_text("clusters: [this is: not valid");
        assert!(src.error.is_some());
        assert!(src.contexts.is_empty());
        let empty = parse_text("");
        assert!(empty.error.unwrap().contains("No contexts"));
        let missing = parse_file(Path::new("/definitely/not/here/kubeconfig"));
        assert!(missing.error.is_some());
    }

    #[test]
    fn parse_file_resolves_relative_paths() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config");
        std::fs::write(&path, TWO_CONTEXTS).unwrap();
        let src = parse_file(&path);
        assert_eq!(src.error, None);
        assert_eq!(
            PathBuf::from(&src.path),
            std::fs::canonicalize(&path).unwrap()
        );
        let kc = load(&path).unwrap();
        let ca = kc.clusters[0]
            .cluster
            .as_ref()
            .unwrap()
            .certificate_authority
            .clone()
            .unwrap();
        assert!(Path::new(&ca).is_absolute(), "{ca}");
    }

    #[test]
    fn single_context_contains_only_that_context() {
        let kc = load_text(TWO_CONTEXTS).unwrap();
        let single = single_context(&kc, "prod").unwrap();
        assert_eq!(single.current_context.as_deref(), Some("prod"));
        assert_eq!(single.contexts.len(), 1);
        assert_eq!(single.clusters.len(), 1);
        assert_eq!(single.clusters[0].name, "prod-cluster");
        assert_eq!(single.auth_infos.len(), 1);
        assert_eq!(single.auth_infos[0].name, "prod-user");

        // Round-trips through YAML as a valid kubeconfig kubectl can read.
        let yaml = to_yaml(&single).unwrap();
        assert!(yaml.contains("current-context: prod"));
        assert!(!yaml.contains("dev-token-value"));
        assert!(!yaml.contains("dev-cluster"));
        let reparsed = load_text(&yaml).unwrap();
        assert_eq!(reparsed.contexts[0].name, "prod");
        let exec = reparsed.auth_infos[0]
            .auth_info
            .as_ref()
            .unwrap()
            .exec
            .as_ref()
            .unwrap();
        assert_eq!(exec.command.as_deref(), Some("aws"));
        assert_eq!(
            server_for_context(&reparsed, "prod").unwrap(),
            "https://ABC.gr7.eu-west-1.eks.amazonaws.com"
        );
    }

    #[test]
    fn single_context_keeps_token_of_selected_user() {
        let kc = load_text(TWO_CONTEXTS).unwrap();
        let yaml = to_yaml(&single_context(&kc, "dev").unwrap()).unwrap();
        assert!(yaml.contains("dev-token-value"));
        assert!(!yaml.contains("prod-user"));
        assert_eq!(namespace_for_context(&kc, "dev").as_deref(), Some("team-a"));
    }

    #[test]
    fn missing_context_is_a_clear_error() {
        let kc = load_text(TWO_CONTEXTS).unwrap();
        let err = single_context(&kc, "staging").unwrap_err().to_string();
        assert!(err.contains("\"staging\" not found"), "{err}");
        assert!(err.contains("dev, prod"), "{err}");
    }

    #[test]
    fn discovery_scans_env_home_and_sync_paths() {
        let home = tempfile::tempdir().unwrap();
        let kube = home.path().join(".kube");
        std::fs::create_dir_all(kube.join("cache/discovery")).unwrap();
        std::fs::write(kube.join("config"), TWO_CONTEXTS).unwrap();
        std::fs::write(
            kube.join("staging.yaml"),
            TWO_CONTEXTS.replace("dev", "stg"),
        )
        .unwrap();
        // Not kubeconfigs: skipped silently.
        std::fs::write(kube.join("notes.txt"), "just some notes").unwrap();
        std::fs::write(kube.join("broken.yaml"), "contexts: [unclosed").unwrap();
        std::fs::write(kube.join(".hidden"), TWO_CONTEXTS).unwrap();
        std::fs::write(kube.join("cache/discovery/servers.json"), "{}").unwrap();
        // Too large.
        let big = format!("{TWO_CONTEXTS}\n#{}", "x".repeat(3 * 1024 * 1024));
        std::fs::write(kube.join("huge.yaml"), big).unwrap();

        let extra = tempfile::tempdir().unwrap();
        let env_file = extra.path().join("env-config");
        std::fs::write(&env_file, TWO_CONTEXTS.replace("dev", "envctx")).unwrap();
        let sync_dir = extra.path().join("synced");
        std::fs::create_dir_all(&sync_dir).unwrap();
        std::fs::write(
            sync_dir.join("a.yaml"),
            TWO_CONTEXTS.replace("dev", "synced"),
        )
        .unwrap();
        let sync_file = extra.path().join("single.yaml");
        std::fs::write(&sync_file, "not: [valid").unwrap();

        // KUBECONFIG lists the env file and (again) ~/.kube/config: deduped.
        let env = std::env::join_paths([env_file.clone(), kube.join("config")]).unwrap();
        let sources = discover_with(
            Some(home.path()),
            Some(env),
            &[
                sync_dir.to_string_lossy().to_string(),
                sync_file.to_string_lossy().to_string(),
                "   ".to_string(),
            ],
        );
        let names: Vec<String> = sources
            .iter()
            .map(|s| {
                Path::new(&s.path)
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .to_string()
            })
            .collect();
        assert_eq!(
            names,
            vec![
                "env-config",
                "config",
                "staging.yaml",
                "a.yaml",
                "single.yaml"
            ]
        );
        assert_eq!(sources[0].contexts[0].name, "envctx");
        assert!(sources[1].error.is_none());
        assert_eq!(sources[2].contexts[0].name, "stg");
        assert_eq!(sources[3].contexts[0].name, "synced");
        // Explicit sync file that fails to parse is reported with an error.
        assert!(sources[4].error.is_some());
    }

    #[test]
    fn discovery_without_anything_is_empty() {
        let home = tempfile::tempdir().unwrap();
        assert!(discover_with(Some(home.path()), None, &[]).is_empty());
    }
}
