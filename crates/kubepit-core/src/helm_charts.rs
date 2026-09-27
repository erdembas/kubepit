//! Helm charts: repositories, the chart catalog, chart details, installs
//! and upgrades, plus reading one stored revision of a release.
//!
//! Repositories and the catalog *are* the user's helm configuration
//! (`helm repo …`, `helm search repo`), so Kubepit and the CLI always agree
//! on what is installable. Those commands are local and never touch a
//! cluster; `helm search hub` is the only one that leaves the machine
//! (artifacthub.io) and runs only when the user asks for it.
//!
//! Installs and upgrades use `--output json`, which prints the whole release
//! object — the same JSON helm stores in its release secrets — so the
//! decoding helpers of [`crate::helm`] apply unchanged. Dry runs use
//! `--dry-run=server` (plain `--dry-run` before helm 3.13), cannot change
//! the cluster and are therefore allowed on read-only clusters; everything
//! else goes through [`Kubepit::helm_exec`] and its read-only guard.
//!
//! User values reach helm through a private temp file (mode 0600, deleted
//! afterwards) and repository passwords through `--password-stdin`, so
//! neither ever appears on a command line or in an error message.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use k8s_openapi::api::core::v1::Secret;
use kube::api::Api;
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::Value;

use crate::app::Kubepit;
use crate::error::{is_not_found, kube_error};
use crate::helm::{decode_release, release_detail};
use crate::paths::atomic_write;
use crate::tools::{self, CommandOutput};
use crate::types::{
    ClusterDef, HelmChartDependency, HelmChartDetail, HelmChartMaintainer, HelmChartMetadata,
    HelmChartSummary, HelmChartVersion, HelmHubChart, HelmInstallRequest, HelmInstallResult,
    HelmRepo, HelmRepoAddOptions, HelmRepoUpdateResult, HelmRevisionDetail, HelmSearchOptions,
    HelmUpgradeRequest,
};

/// Local bookkeeping: `repo list/remove`, `search repo`.
const HELM_LOCAL_TIMEOUT: Duration = Duration::from_secs(30);
/// Downloads a repository index or a chart: `repo add`, `show`, `search hub`.
const HELM_NETWORK_TIMEOUT: Duration = Duration::from_secs(120);
const HELM_REPO_UPDATE_TIMEOUT: Duration = Duration::from_secs(300);
/// Floor for installs/upgrades; hooks and `--wait` may need longer.
const HELM_DEPLOY_TIMEOUT: Duration = Duration::from_secs(600);
/// Helm's own `--timeout` default.
const DEFAULT_WAIT_SECS: u64 = 300;
const CHART_CACHE_TTL: Duration = Duration::from_secs(300);
const CHART_CACHE_CAPACITY: usize = 32;
/// Helm's limit (release names end up in label values and secret names).
const MAX_RELEASE_NAME: usize = 53;
const UPDATE_NOT_REPORTED: &str = "helm did not report an update for this repository";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

fn is_dns1123_label(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 63
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !s.starts_with('-')
        && !s.ends_with('-')
}

/// Helm's rule for release names: a DNS-1123 subdomain of at most 53 characters.
pub fn validate_release_name(name: &str) -> Result<()> {
    if name.is_empty() {
        bail!("a release name is required");
    }
    if name.len() > MAX_RELEASE_NAME {
        bail!("release name \"{name}\" is longer than {MAX_RELEASE_NAME} characters");
    }
    if !name.split('.').all(is_dns1123_label) {
        bail!(
            "invalid release name \"{name}\": use lowercase letters, digits, '-' and '.', \
             starting and ending with a letter or digit"
        );
    }
    Ok(())
}

pub fn validate_namespace(namespace: &str) -> Result<()> {
    if !is_dns1123_label(namespace) {
        bail!("invalid namespace \"{namespace}\"");
    }
    Ok(())
}

/// Anything helm could mistake for a flag or that would not survive as one argument.
fn is_plain_arg(s: &str) -> bool {
    !s.is_empty() && !s.starts_with('-') && !s.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// `repo/chart` (a configured repository) or `oci://registry/path`.
pub fn validate_chart_ref(chart_ref: &str) -> Result<()> {
    let valid = is_plain_arg(chart_ref)
        && match chart_ref.strip_prefix("oci://") {
            Some(rest) => !rest.is_empty() && !rest.starts_with('/'),
            None => matches!(
                chart_ref.split_once('/'),
                Some((repo, chart)) if !repo.is_empty() && !chart.is_empty() && !chart.contains('/')
            ),
        };
    if !valid {
        bail!("invalid chart reference \"{chart_ref}\": use repo/chart or oci://registry/chart");
    }
    Ok(())
}

/// A chart version (or constraint) as `--version` takes it; blank means latest.
pub fn normalize_version(version: Option<&str>) -> Result<Option<String>> {
    match version.map(str::trim).filter(|v| !v.is_empty()) {
        None => Ok(None),
        Some(v) if is_plain_arg(v) && v.len() <= 128 => Ok(Some(v.to_string())),
        Some(v) => bail!("invalid chart version \"{v}\""),
    }
}

pub fn validate_repo_name(name: &str) -> Result<()> {
    let valid = is_plain_arg(name)
        && name.len() <= 100
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if !valid {
        bail!("invalid repository name \"{name}\": use letters, digits, '-', '_' and '.' (no '/')");
    }
    Ok(())
}

pub fn validate_repo_url(url: &str) -> Result<()> {
    if url.starts_with("oci://") {
        bail!(
            "OCI registries are not chart repositories; install their charts with an \
             oci:// reference instead"
        );
    }
    if !is_plain_arg(url) || !(url.starts_with("https://") || url.starts_with("http://")) {
        bail!("invalid repository URL \"{url}\": use an http(s):// address");
    }
    Ok(())
}

/// User values must be a YAML mapping (or empty).
pub fn validate_values(values: &str) -> Result<()> {
    if values.trim().is_empty() {
        return Ok(());
    }
    let parsed: serde_yaml::Value =
        serde_yaml::from_str(values).context("values are not valid YAML")?;
    if !matches!(
        parsed,
        serde_yaml::Value::Mapping(_) | serde_yaml::Value::Null
    ) {
        bail!("values must be a YAML mapping");
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

struct Version<'a> {
    core: Vec<u64>,
    pre: Option<&'a str>,
}

fn parse_version(raw: &str) -> Option<Version<'_>> {
    let v = raw.trim().trim_start_matches(['v', 'V']);
    let v = v.split('+').next()?;
    let (core, pre) = match v.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (v, None),
    };
    let core = core
        .split('.')
        .map(|p| p.parse::<u64>().ok())
        .collect::<Option<Vec<_>>>()?;
    Some(Version { core, pre })
}

fn compare_prerelease(a: &str, b: &str) -> Ordering {
    let mut left = a.split('.');
    let mut right = b.split('.');
    loop {
        match (left.next(), right.next()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) => {
                let order = match (x.parse::<u64>(), y.parse::<u64>()) {
                    (Ok(x), Ok(y)) => x.cmp(&y),
                    (Ok(_), Err(_)) => Ordering::Less,
                    (Err(_), Ok(_)) => Ordering::Greater,
                    (Err(_), Err(_)) => x.cmp(y),
                };
                if order != Ordering::Equal {
                    return order;
                }
            }
        }
    }
}

/// Semver ordering for chart versions: a leading `v` and build metadata are
/// ignored, missing core parts count as 0, a pre-release sorts before its
/// release. Unparseable versions sort before every parseable one.
pub fn compare_versions(a: &str, b: &str) -> Ordering {
    match (parse_version(a), parse_version(b)) {
        (Some(x), Some(y)) => {
            let len = x.core.len().max(y.core.len()).max(3);
            let part = |v: &Version, i: usize| v.core.get(i).copied().unwrap_or(0);
            (0..len)
                .map(|i| part(&x, i).cmp(&part(&y, i)))
                .find(|o| o.is_ne())
                .unwrap_or_else(|| match (x.pre, y.pre) {
                    (None, None) => Ordering::Equal,
                    (None, Some(_)) => Ordering::Greater,
                    (Some(_), None) => Ordering::Less,
                    (Some(p), Some(q)) => compare_prerelease(p, q),
                })
        }
        (Some(_), None) => Ordering::Greater,
        (None, Some(_)) => Ordering::Less,
        (None, None) => a.cmp(b),
    }
}

pub fn is_prerelease(version: &str) -> bool {
    parse_version(version).is_some_and(|v| v.pre.is_some())
}

/// Newest first, duplicates removed.
pub fn sort_versions_desc(versions: &mut Vec<HelmChartVersion>) {
    versions.sort_by(|a, b| compare_versions(&b.version, &a.version));
    versions.dedup_by(|a, b| a.version == b.version);
}

/// What the installed helm understands, from `helm version --short`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HelmCaps {
    /// `--dry-run=server` exists since helm 3.13; older releases only know `--dry-run`.
    pub server_dry_run: bool,
    /// Helm 4 renamed `--atomic` to `--rollback-on-failure`.
    pub rollback_on_failure: bool,
}

impl HelmCaps {
    /// Unknown versions assume a current helm 3; a wrong guess about the
    /// dry-run flag is corrected by [`is_dry_run_flag_error`].
    pub fn from_version(version: Option<&str>) -> Self {
        let core = version.and_then(parse_version).map(|v| v.core);
        match core.as_deref() {
            Some([major, minor, ..]) => Self {
                server_dry_run: *major > 3 || (*major == 3 && *minor >= 13),
                rollback_on_failure: *major >= 4,
            },
            Some([major]) => Self {
                server_dry_run: *major > 3,
                rollback_on_failure: *major >= 4,
            },
            _ => Self {
                server_dry_run: true,
                rollback_on_failure: false,
            },
        }
    }
}

/// True when helm rejected `--dry-run=server` (helm older than 3.13).
pub fn is_dry_run_flag_error(message: &str) -> bool {
    let m = message.to_ascii_lowercase();
    m.contains("dry-run")
        && (m.contains("invalid argument")
            || m.contains("unknown flag")
            || m.contains("bad flag syntax"))
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

fn non_empty(s: String) -> Option<String> {
    let t = s.trim();
    (!t.is_empty()).then(|| t.to_string())
}

/// helm reports "nothing configured" as an error on several commands.
pub fn is_no_repositories(message: &str) -> bool {
    let m = message.to_ascii_lowercase();
    m.contains("no repositories to show")
        || m.contains("no repositories configured")
        || m.contains("no repositories found. you must add one")
}

/// `helm repo list -o json`.
pub fn parse_repo_list(stdout: &str) -> Result<Vec<HelmRepo>> {
    #[derive(Deserialize)]
    struct Entry {
        name: String,
        url: String,
    }
    if stdout.trim().is_empty() {
        return Ok(Vec::new());
    }
    let entries: Vec<Entry> =
        serde_json::from_str(stdout.trim()).context("unexpected `helm repo list` output")?;
    Ok(entries
        .into_iter()
        .map(|e| HelmRepo {
            name: e.name,
            url: e.url,
        })
        .collect())
}

/// Per-repository outcome of `helm repo update`, from its progress lines:
/// `...Successfully got an update from the "x" chart repository` and
/// `...Unable to get an update from the "x" chart repository (url):` followed
/// by the reason on the next, tab-indented line.
pub fn parse_repo_update(output: &str, names: &[String]) -> Vec<HelmRepoUpdateResult> {
    let lines: Vec<&str> = output.lines().collect();
    names
        .iter()
        .map(|name| {
            let ok = format!("Successfully got an update from the \"{name}\"");
            let failed = format!("Unable to get an update from the \"{name}\"");
            if lines.iter().any(|l| l.contains(&ok)) {
                return HelmRepoUpdateResult {
                    name: name.clone(),
                    ok: true,
                    error: None,
                };
            }
            let error = match lines.iter().position(|l| l.contains(&failed)) {
                Some(i) => {
                    let inline = lines[i]
                        .split_once("):")
                        .map(|(_, rest)| rest.trim())
                        .filter(|rest| !rest.is_empty());
                    let next = lines
                        .get(i + 1)
                        .map(|l| l.trim())
                        .filter(|l| !l.is_empty() && !l.starts_with("..."));
                    inline.or(next).unwrap_or("update failed").to_string()
                }
                None => UPDATE_NOT_REPORTED.to_string(),
            };
            HelmRepoUpdateResult {
                name: name.clone(),
                ok: false,
                error: Some(error),
            }
        })
        .collect()
}

/// Charts whose description starts with "DEPRECATED" (the repository index
/// convention; `helm search` does not expose the `deprecated` flag).
pub fn is_deprecated_description(description: &str) -> bool {
    description
        .trim_start()
        .trim_start_matches(['[', '(', '*'])
        .get(..10)
        .is_some_and(|head| head.eq_ignore_ascii_case("deprecated"))
}

/// `helm search repo -o json`.
pub fn parse_search(stdout: &str) -> Result<Vec<HelmChartSummary>> {
    #[derive(Deserialize)]
    struct Entry {
        name: String,
        #[serde(default)]
        version: String,
        #[serde(default)]
        app_version: String,
        #[serde(default)]
        description: String,
    }
    if stdout.trim().is_empty() {
        return Ok(Vec::new());
    }
    let entries: Vec<Entry> =
        serde_json::from_str(stdout.trim()).context("unexpected `helm search repo` output")?;
    Ok(entries
        .into_iter()
        .map(|e| {
            let (repo, chart) = e
                .name
                .split_once('/')
                .map(|(r, c)| (r.to_string(), c.to_string()))
                .unwrap_or_else(|| (String::new(), e.name.clone()));
            HelmChartSummary {
                deprecated: is_deprecated_description(&e.description),
                name: e.name,
                repo,
                chart,
                version: e.version,
                app_version: non_empty(e.app_version),
                description: e.description.trim().to_string(),
            }
        })
        .collect())
}

/// Every version of exactly `chart_ref` in `helm search repo --versions` output.
pub fn chart_versions(search_json: &str, chart_ref: &str) -> Result<Vec<HelmChartVersion>> {
    let mut versions: Vec<HelmChartVersion> = parse_search(search_json)?
        .into_iter()
        .filter(|c| c.name == chart_ref)
        .map(|c| HelmChartVersion {
            version: c.version,
            app_version: c.app_version,
        })
        .collect();
    sort_versions_desc(&mut versions);
    Ok(versions)
}

/// `helm search hub -o json --list-repo-url`.
pub fn parse_hub_search(stdout: &str) -> Result<Vec<HelmHubChart>> {
    #[derive(Deserialize, Default)]
    struct Repo {
        #[serde(default)]
        url: String,
        #[serde(default)]
        name: String,
    }
    #[derive(Deserialize)]
    struct Entry {
        url: String,
        #[serde(default)]
        version: String,
        #[serde(default)]
        app_version: String,
        #[serde(default)]
        description: String,
        #[serde(default)]
        repository: Repo,
    }
    if stdout.trim().is_empty() {
        return Ok(Vec::new());
    }
    let entries: Vec<Entry> =
        serde_json::from_str(stdout.trim()).context("unexpected `helm search hub` output")?;
    Ok(entries
        .into_iter()
        .map(|e| HelmHubChart {
            url: e.url,
            version: e.version,
            app_version: non_empty(e.app_version),
            description: e.description.trim().to_string(),
            repository_name: e.repository.name,
            repository_url: e.repository.url,
        })
        .collect())
}

/// `Chart.yaml` (`helm show chart`). String fields keep the literal text,
/// so `appVersion: 1.10` stays "1.10".
pub fn parse_chart_metadata(chart_yaml: &str) -> Result<HelmChartMetadata> {
    #[derive(Deserialize, Default)]
    #[serde(default)]
    struct Maintainer {
        name: Option<String>,
        email: Option<String>,
        url: Option<String>,
    }
    #[derive(Deserialize, Default)]
    #[serde(default)]
    struct Dependency {
        name: Option<String>,
        version: Option<String>,
        repository: Option<String>,
        condition: Option<String>,
    }
    #[derive(Deserialize, Default)]
    #[serde(default, rename_all = "camelCase")]
    struct ChartYaml {
        name: Option<String>,
        version: Option<String>,
        app_version: Option<String>,
        description: Option<String>,
        home: Option<String>,
        icon: Option<String>,
        sources: Option<Vec<String>>,
        keywords: Option<Vec<String>>,
        maintainers: Option<Vec<Maintainer>>,
        dependencies: Option<Vec<Dependency>>,
        kube_version: Option<String>,
        #[serde(rename = "type")]
        chart_type: Option<String>,
        deprecated: Option<serde_yaml::Value>,
    }
    let chart: ChartYaml = if chart_yaml.trim().is_empty() {
        ChartYaml::default()
    } else {
        serde_yaml::from_str(chart_yaml).context("unexpected `helm show chart` output")?
    };
    let opt = |v: Option<String>| v.and_then(non_empty);
    let deprecated = match chart.deprecated {
        Some(serde_yaml::Value::Bool(b)) => b,
        Some(serde_yaml::Value::String(s)) => s.eq_ignore_ascii_case("true"),
        _ => false,
    };
    Ok(HelmChartMetadata {
        name: chart.name.unwrap_or_default(),
        version: chart.version.unwrap_or_default(),
        app_version: opt(chart.app_version),
        description: opt(chart.description),
        home: opt(chart.home),
        icon: opt(chart.icon),
        sources: chart
            .sources
            .unwrap_or_default()
            .into_iter()
            .filter_map(non_empty)
            .collect(),
        keywords: chart
            .keywords
            .unwrap_or_default()
            .into_iter()
            .filter_map(non_empty)
            .collect(),
        maintainers: chart
            .maintainers
            .unwrap_or_default()
            .into_iter()
            .filter_map(|m| {
                Some(HelmChartMaintainer {
                    name: opt(m.name)?,
                    email: opt(m.email),
                    url: opt(m.url),
                })
            })
            .collect(),
        dependencies: chart
            .dependencies
            .unwrap_or_default()
            .into_iter()
            .filter_map(|d| {
                Some(HelmChartDependency {
                    name: opt(d.name)?,
                    version: opt(d.version),
                    repository: opt(d.repository),
                    condition: opt(d.condition),
                })
            })
            .collect(),
        kube_version: opt(chart.kube_version),
        chart_type: opt(chart.chart_type),
        deprecated,
    })
}

/// `helm install|upgrade --output json`: the release object, or (should a
/// helm build print something else) the raw output as the manifest.
pub fn parse_install_output(stdout: &str, namespace: &str) -> Result<HelmInstallResult> {
    let parsed = stdout.find('{').and_then(|start| {
        serde_json::Deserializer::from_str(&stdout[start..])
            .into_iter::<Value>()
            .next()
            .and_then(|v| v.ok())
            .filter(|v| v.get("name").is_some())
    });
    let Some(release) = parsed else {
        return Ok(HelmInstallResult {
            release: None,
            manifest: stdout.to_string(),
            notes: String::new(),
            values_yaml: String::new(),
            computed_values_yaml: String::new(),
        });
    };
    let detail = release_detail(&release, Vec::new(), namespace)?;
    Ok(HelmInstallResult {
        release: Some(detail.release),
        manifest: detail.manifest,
        notes: detail.notes,
        values_yaml: detail.values_yaml,
        computed_values_yaml: detail.computed_values_yaml,
    })
}

/// The useful part of a failed helm run (stderr, else stdout, minus "Error: ").
fn failure_detail(out: &CommandOutput) -> String {
    let detail = if out.stderr.trim().is_empty() {
        out.stdout.trim()
    } else {
        out.stderr.trim()
    };
    detail.strip_prefix("Error: ").unwrap_or(detail).to_string()
}

// ---------------------------------------------------------------------------
// Argument building
// ---------------------------------------------------------------------------

fn strings<const N: usize>(parts: [&str; N]) -> Vec<String> {
    parts.iter().map(|s| s.to_string()).collect()
}

/// Flags shared by `install` and `upgrade`. User-provided values always use
/// the `--flag=value` form so they can never be read as another flag.
struct DeployFlags<'a> {
    version: Option<&'a str>,
    values_file: Option<&'a Path>,
    wait: bool,
    atomic: bool,
    timeout_secs: Option<u64>,
    dry_run: bool,
}

fn push_deploy_flags(args: &mut Vec<String>, flags: &DeployFlags, caps: HelmCaps) {
    if let Some(version) = flags.version {
        args.push(format!("--version={version}"));
    }
    if let Some(file) = flags.values_file {
        args.push(format!("--values={}", file.to_string_lossy()));
    }
    if flags.dry_run {
        args.push(if caps.server_dry_run {
            "--dry-run=server".into()
        } else {
            "--dry-run".into()
        });
    } else {
        if flags.atomic {
            args.push(if caps.rollback_on_failure {
                "--rollback-on-failure".into()
            } else {
                "--atomic".into()
            });
        }
        if flags.wait {
            args.push("--wait".into());
        }
        if let Some(secs) = flags.timeout_secs.filter(|s| *s > 0) {
            args.push(format!("--timeout={secs}s"));
        }
    }
    args.extend(strings(["--output", "json"]));
}

/// `helm install` arguments (the kubeconfig / context / namespace flags are
/// appended by [`Kubepit::helm_exec_on`]).
pub fn install_args(
    request: &HelmInstallRequest,
    version: Option<&str>,
    values_file: Option<&Path>,
    caps: HelmCaps,
) -> Vec<String> {
    let mut args = vec![
        "install".to_string(),
        request.release_name.clone(),
        request.chart_ref.clone(),
    ];
    push_deploy_flags(
        &mut args,
        &DeployFlags {
            version,
            values_file,
            wait: request.wait,
            atomic: request.atomic,
            timeout_secs: request.timeout_secs,
            dry_run: request.dry_run,
        },
        caps,
    );
    if request.create_namespace {
        args.push("--create-namespace".into());
    }
    if let Some(description) = request
        .description
        .as_deref()
        .map(str::trim)
        .filter(|d| !d.is_empty())
    {
        args.push(format!("--description={description}"));
    }
    args
}

/// `helm upgrade` arguments.
pub fn upgrade_args(
    name: &str,
    request: &HelmUpgradeRequest,
    version: Option<&str>,
    values_file: Option<&Path>,
    caps: HelmCaps,
) -> Vec<String> {
    let mut args = vec![
        "upgrade".to_string(),
        name.to_string(),
        request.chart_ref.clone(),
    ];
    push_deploy_flags(
        &mut args,
        &DeployFlags {
            version,
            values_file,
            wait: request.wait,
            atomic: request.atomic,
            timeout_secs: request.timeout_secs,
            dry_run: request.dry_run,
        },
        caps,
    );
    if request.reuse_values {
        args.push("--reuse-values".into());
    }
    if request.reset_values {
        args.push("--reset-values".into());
    }
    args
}

/// Process timeout for a deploy: helm's own `--timeout` plus headroom.
fn deploy_timeout(timeout_secs: Option<u64>) -> Duration {
    let helm = timeout_secs.unwrap_or(DEFAULT_WAIT_SECS);
    Duration::from_secs(helm.saturating_add(120)).max(HELM_DEPLOY_TIMEOUT)
}

// ---------------------------------------------------------------------------
// Chart detail cache
// ---------------------------------------------------------------------------

struct CachedChart {
    at: Instant,
    detail: HelmChartDetail,
}

/// `helm show` downloads the chart every time; details change only when the
/// user updates repositories (which clears this cache).
static CHART_CACHE: LazyLock<Mutex<HashMap<String, CachedChart>>> = LazyLock::new(Default::default);

fn cached_chart(key: &str) -> Option<HelmChartDetail> {
    let cache = CHART_CACHE.lock();
    cache
        .get(key)
        .filter(|c| c.at.elapsed() < CHART_CACHE_TTL)
        .map(|c| c.detail.clone())
}

fn cache_chart(key: String, detail: HelmChartDetail) {
    let mut cache = CHART_CACHE.lock();
    cache.retain(|_, c| c.at.elapsed() < CHART_CACHE_TTL);
    if cache.len() >= CHART_CACHE_CAPACITY {
        if let Some(oldest) = cache
            .iter()
            .min_by_key(|(_, c)| c.at)
            .map(|(k, _)| k.clone())
        {
            cache.remove(&oldest);
        }
    }
    cache.insert(
        key,
        CachedChart {
            at: Instant::now(),
            detail,
        },
    );
}

fn clear_chart_cache() {
    CHART_CACHE.lock().clear();
}

/// A private values file for one helm invocation, removed when dropped.
struct ValuesFile(PathBuf);

impl Drop for ValuesFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

impl Kubepit {
    fn helm_binary(&self) -> Result<PathBuf> {
        tools::require_helm(self.settings().helm_path.as_deref())
    }

    /// Run a helm command that does not involve a cluster.
    async fn helm_local(
        &self,
        args: &[String],
        stdin: Option<&[u8]>,
        timeout: Duration,
    ) -> Result<CommandOutput> {
        let helm = self.helm_binary()?;
        tools::run_with_stdin(&helm, args, stdin, timeout).await
    }

    async fn helm_caps(&self) -> HelmCaps {
        let info = tools::helm_info(self.settings().helm_path.as_deref()).await;
        HelmCaps::from_version(info.version.as_deref())
    }

    fn write_values_file(&self, values: &str) -> Result<Option<ValuesFile>> {
        if values.trim().is_empty() {
            return Ok(None);
        }
        validate_values(values)?;
        let path = self.paths().run_dir().join(format!(
            "helm-values-{}.yaml",
            uuid::Uuid::new_v4().simple()
        ));
        atomic_write(&path, values.as_bytes(), true)?;
        Ok(Some(ValuesFile(path)))
    }

    /// `helm_repo_list`.
    pub async fn helm_repo_list(&self) -> Result<Vec<HelmRepo>> {
        let out = self
            .helm_local(
                &strings(["repo", "list", "--output", "json"]),
                None,
                HELM_LOCAL_TIMEOUT,
            )
            .await?;
        if !out.success {
            let detail = failure_detail(&out);
            if is_no_repositories(&detail) {
                return Ok(Vec::new());
            }
            bail!("helm repo list failed: {detail}");
        }
        parse_repo_list(&out.stdout)
    }

    /// `helm_repo_add`. With a username the password goes through
    /// `--password-stdin`.
    pub async fn helm_repo_add(
        &self,
        name: &str,
        url: &str,
        options: &HelmRepoAddOptions,
    ) -> Result<()> {
        let name = name.trim();
        let url = url.trim();
        validate_repo_name(name)?;
        validate_repo_url(url)?;
        let mut args = strings(["repo", "add", name, url]);
        let username = options
            .username
            .as_deref()
            .map(str::trim)
            .filter(|u| !u.is_empty());
        let password = options.password.clone().unwrap_or_default();
        let mut stdin = None;
        match username {
            Some(user) => {
                if user.chars().any(char::is_control) {
                    bail!("invalid username");
                }
                args.push(format!("--username={user}"));
                args.push("--password-stdin".into());
                stdin = Some(password.as_bytes());
            }
            None if !password.is_empty() => bail!("a password needs a username"),
            None => {}
        }
        if options.insecure_skip_tls_verify {
            args.push("--insecure-skip-tls-verify".into());
        }
        if options.pass_credentials {
            args.push("--pass-credentials".into());
        }
        if options.force_update {
            args.push("--force-update".into());
        }
        let out = self.helm_local(&args, stdin, HELM_NETWORK_TIMEOUT).await?;
        if !out.success {
            let mut detail = failure_detail(&out);
            if !password.is_empty() {
                detail = detail.replace(&password, "••••");
            }
            bail!("helm repo add failed: {detail}");
        }
        clear_chart_cache();
        Ok(())
    }

    /// `helm_repo_remove`.
    pub async fn helm_repo_remove(&self, name: &str) -> Result<()> {
        validate_repo_name(name)?;
        let out = self
            .helm_local(&strings(["repo", "remove", name]), None, HELM_LOCAL_TIMEOUT)
            .await?;
        if !out.success {
            bail!("helm repo remove failed: {}", failure_detail(&out));
        }
        clear_chart_cache();
        Ok(())
    }

    /// `helm_repo_update`: every repository when `names` is empty.
    pub async fn helm_repo_update(&self, names: &[String]) -> Result<Vec<HelmRepoUpdateResult>> {
        let repos = self.helm_repo_list().await?;
        let targets: Vec<String> = if names.is_empty() {
            repos.iter().map(|r| r.name.clone()).collect()
        } else {
            for name in names {
                if !repos.iter().any(|r| &r.name == name) {
                    bail!("helm repository \"{name}\" is not configured");
                }
            }
            names.to_vec()
        };
        if targets.is_empty() {
            return Ok(Vec::new());
        }
        let mut args = strings(["repo", "update"]);
        if !names.is_empty() {
            args.extend(targets.iter().cloned());
        }
        let out = self
            .helm_local(&args, None, HELM_REPO_UPDATE_TIMEOUT)
            .await?;
        clear_chart_cache();
        let results = parse_repo_update(&format!("{}\n{}", out.stdout, out.stderr), &targets);
        let reported = results
            .iter()
            .any(|r| r.error.as_deref() != Some(UPDATE_NOT_REPORTED));
        if !out.success && !reported {
            bail!("helm repo update failed: {}", failure_detail(&out));
        }
        Ok(results)
    }

    /// `helm_chart_search`: charts of the configured repositories (newest
    /// version of each unless `options.versions`). An empty query lists all.
    pub async fn helm_chart_search(
        &self,
        query: &str,
        options: HelmSearchOptions,
    ) -> Result<Vec<HelmChartSummary>> {
        let query = query.trim();
        let mut args = strings(["search", "repo"]);
        if !query.is_empty() {
            if !is_plain_arg(query) {
                bail!("invalid search \"{query}\"");
            }
            args.push(query.to_string());
        }
        if options.versions {
            args.push("--versions".into());
        }
        if options.devel {
            args.push("--devel".into());
        }
        args.extend(strings(["--output", "json"]));
        let out = self.helm_local(&args, None, HELM_LOCAL_TIMEOUT).await?;
        if !out.success {
            let detail = failure_detail(&out);
            if is_no_repositories(&detail) {
                return Ok(Vec::new());
            }
            bail!("helm search repo failed: {detail}");
        }
        parse_search(&out.stdout)
    }

    /// `helm_chart_versions`: newest first, pre-releases included. OCI
    /// registries cannot be listed by helm, so they report the newest only.
    pub async fn helm_chart_versions(&self, chart_ref: &str) -> Result<Vec<HelmChartVersion>> {
        validate_chart_ref(chart_ref)?;
        if chart_ref.starts_with("oci://") {
            let chart = self.helm_show("chart", chart_ref, None).await?;
            let meta = parse_chart_metadata(&chart)?;
            return Ok(vec![HelmChartVersion {
                version: meta.version,
                app_version: meta.app_version,
            }]);
        }
        let out = self
            .helm_local(
                &strings([
                    "search",
                    "repo",
                    chart_ref,
                    "--versions",
                    "--devel",
                    "--output",
                    "json",
                ]),
                None,
                HELM_LOCAL_TIMEOUT,
            )
            .await?;
        if !out.success {
            let detail = failure_detail(&out);
            if is_no_repositories(&detail) {
                return Ok(Vec::new());
            }
            bail!("helm search repo failed: {detail}");
        }
        chart_versions(&out.stdout, chart_ref)
    }

    /// `helm_hub_search`: queries artifacthub.io.
    pub async fn helm_hub_search(&self, query: &str) -> Result<Vec<HelmHubChart>> {
        let query = query.trim();
        if query.is_empty() {
            bail!("enter a search term");
        }
        if !is_plain_arg(query) {
            bail!("invalid search \"{query}\"");
        }
        let out = self
            .helm_local(
                &strings([
                    "search",
                    "hub",
                    query,
                    "--list-repo-url",
                    "--output",
                    "json",
                ]),
                None,
                HELM_NETWORK_TIMEOUT,
            )
            .await?;
        if !out.success {
            bail!("helm search hub failed: {}", failure_detail(&out));
        }
        parse_hub_search(&out.stdout)
    }

    async fn helm_show(
        &self,
        what: &str,
        chart_ref: &str,
        version: Option<&str>,
    ) -> Result<String> {
        let mut args = strings(["show", what, chart_ref]);
        if let Some(v) = version {
            args.push(format!("--version={v}"));
        }
        let out = self.helm_local(&args, None, HELM_NETWORK_TIMEOUT).await?;
        if !out.success {
            bail!("helm show {what} failed: {}", failure_detail(&out));
        }
        Ok(out.stdout)
    }

    /// `helm_chart_show`: metadata, README and default values of one chart
    /// version (`None` = newest stable), cached for a few minutes.
    pub async fn helm_chart_show(
        &self,
        chart_ref: &str,
        version: Option<&str>,
    ) -> Result<HelmChartDetail> {
        validate_chart_ref(chart_ref)?;
        let version = normalize_version(version)?;
        let helm = self.helm_binary()?;
        let key = format!(
            "{}|{chart_ref}|{}",
            helm.display(),
            version.as_deref().unwrap_or("")
        );
        if let Some(hit) = cached_chart(&key) {
            return Ok(hit);
        }
        let v = version.as_deref();
        let (chart, readme, values) = tokio::join!(
            self.helm_show("chart", chart_ref, v),
            self.helm_show("readme", chart_ref, v),
            self.helm_show("values", chart_ref, v),
        );
        let detail = HelmChartDetail {
            metadata: parse_chart_metadata(&chart?)?,
            readme: readme?,
            values_yaml: values?,
        };
        cache_chart(key, detail.clone());
        Ok(detail)
    }

    /// Run a deploy. Dry runs skip the read-only guard (they cannot change
    /// the cluster) and fall back to `--dry-run` when helm rejects
    /// `--dry-run=server`; real runs go through [`Kubepit::helm_exec`].
    async fn helm_deploy(
        &self,
        cluster_id: &str,
        namespace: &str,
        action: &str,
        dry_run: bool,
        timeout: Duration,
        build: impl Fn(HelmCaps) -> Vec<String>,
    ) -> Result<String> {
        let caps = self.helm_caps().await;
        if !dry_run {
            return self
                .helm_exec(cluster_id, namespace, action, build(caps), timeout)
                .await;
        }
        let cluster: ClusterDef = self.cluster_def(cluster_id)?;
        let first = self
            .helm_exec_on(&cluster, namespace, action, build(caps), timeout)
            .await;
        match first {
            Err(e) if caps.server_dry_run && is_dry_run_flag_error(&format!("{e:#}")) => {
                let legacy = HelmCaps {
                    server_dry_run: false,
                    ..caps
                };
                self.helm_exec_on(&cluster, namespace, action, build(legacy), timeout)
                    .await
            }
            other => other,
        }
    }

    /// `helm_install`. With `dry_run` nothing changes and the result is a
    /// preview (rendered manifest, notes, values).
    pub(crate) async fn helm_install_unaudited(
        &self,
        cluster_id: &str,
        request: &HelmInstallRequest,
    ) -> Result<HelmInstallResult> {
        validate_release_name(&request.release_name)?;
        validate_namespace(&request.namespace)?;
        validate_chart_ref(&request.chart_ref)?;
        let version = normalize_version(request.version.as_deref())?;
        if !request.dry_run {
            // Fail fast, before writing any values file.
            self.ensure_writable(cluster_id, "install")?;
        }
        let values = self.write_values_file(&request.values_yaml)?;
        let stdout = self
            .helm_deploy(
                cluster_id,
                &request.namespace,
                "install",
                request.dry_run,
                deploy_timeout(request.timeout_secs),
                |caps| {
                    install_args(
                        request,
                        version.as_deref(),
                        values.as_ref().map(|f| f.0.as_path()),
                        caps,
                    )
                },
            )
            .await;
        drop(values);
        parse_install_output(&stdout?, &request.namespace)
    }

    /// `helm_upgrade`: a new revision from `request.chart_ref` (optionally a
    /// dry-run preview).
    pub(crate) async fn helm_upgrade_unaudited(
        &self,
        cluster_id: &str,
        namespace: &str,
        name: &str,
        request: &HelmUpgradeRequest,
    ) -> Result<HelmInstallResult> {
        validate_release_name(name)?;
        validate_namespace(namespace)?;
        validate_chart_ref(&request.chart_ref)?;
        if request.reuse_values && request.reset_values {
            bail!("choose either reuse values or reset values, not both");
        }
        let version = normalize_version(request.version.as_deref())?;
        if !request.dry_run {
            self.ensure_writable(cluster_id, "upgrade")?;
        }
        let values = self.write_values_file(&request.values_yaml)?;
        let stdout = self
            .helm_deploy(
                cluster_id,
                namespace,
                "upgrade",
                request.dry_run,
                deploy_timeout(request.timeout_secs),
                |caps| {
                    upgrade_args(
                        name,
                        request,
                        version.as_deref(),
                        values.as_ref().map(|f| f.0.as_path()),
                        caps,
                    )
                },
            )
            .await;
        drop(values);
        parse_install_output(&stdout?, namespace)
    }

    /// `helm_release_revision`: one stored revision, read natively from its
    /// release secret (`sh.helm.release.v1.<name>.v<revision>`).
    pub async fn helm_release_revision(
        &self,
        cluster_id: &str,
        namespace: &str,
        name: &str,
        revision: i64,
    ) -> Result<HelmRevisionDetail> {
        validate_release_name(name)?;
        validate_namespace(namespace)?;
        if revision < 1 {
            bail!("invalid revision {revision}");
        }
        let client = self.client(cluster_id).await?;
        let api: Api<Secret> = Api::namespaced(client, namespace);
        let secret_name = format!("sh.helm.release.v1.{name}.v{revision}");
        let secret = match api.get(&secret_name).await.map_err(kube_error) {
            Ok(secret) => secret,
            Err(e) if is_not_found(&e) => {
                bail!("helm release {name} has no revision {revision} in namespace {namespace}")
            }
            Err(e) => {
                return Err(e.context(format!("failed to read secret {namespace}/{secret_name}")))
            }
        };
        let raw = secret
            .data
            .as_ref()
            .and_then(|d| d.get("release"))
            .map(|b| b.0.clone())
            .with_context(|| format!("secret {secret_name} has no release payload"))?;
        let release = decode_release(&raw)
            .with_context(|| format!("cannot decode helm release in secret {secret_name}"))?;
        let detail = release_detail(&release, Vec::new(), namespace)?;
        Ok(HelmRevisionDetail {
            release: detail.release,
            values_yaml: detail.values_yaml,
            computed_values_yaml: detail.computed_values_yaml,
            manifest: detail.manifest,
            notes: detail.notes,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const CAPS3: HelmCaps = HelmCaps {
        server_dry_run: true,
        rollback_on_failure: false,
    };

    #[test]
    fn release_names_follow_helm_rules() {
        for ok in ["web", "my-app.v2", "a", "x1", &"a".repeat(53)] {
            assert!(validate_release_name(ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "Web",
            "-web",
            "web-",
            "we_b",
            "web..x",
            "a b",
            "--set",
            &"a".repeat(54),
        ] {
            assert!(validate_release_name(bad).is_err(), "{bad}");
        }
        assert!(validate_namespace("team-a").is_ok());
        assert!(validate_namespace("team.a").is_err());
        assert!(validate_namespace("").is_err());
    }

    #[test]
    fn chart_refs_repo_names_and_urls() {
        for ok in [
            "bitnami/nginx",
            "oci://registry-1.docker.io/bitnamicharts/nginx",
        ] {
            assert!(validate_chart_ref(ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "nginx",
            "-f/x",
            "a/b/c",
            "oci://",
            "bit nami/x",
            "/nginx",
        ] {
            assert!(validate_chart_ref(bad).is_err(), "{bad}");
        }
        assert!(validate_repo_name("prometheus-community").is_ok());
        for bad in ["", "a/b", "-x", "a b"] {
            assert!(validate_repo_name(bad).is_err(), "{bad}");
        }
        assert!(validate_repo_url("https://charts.bitnami.com/bitnami").is_ok());
        assert!(validate_repo_url("ftp://x").is_err());
        assert!(validate_repo_url("https://x y").is_err());
        let oci = validate_repo_url("oci://ghcr.io/x")
            .unwrap_err()
            .to_string();
        assert!(oci.contains("OCI"), "{oci}");
        assert_eq!(normalize_version(Some("  ")).unwrap(), None);
        assert_eq!(
            normalize_version(Some(" 1.2.3 ")).unwrap().as_deref(),
            Some("1.2.3")
        );
        assert!(normalize_version(Some("--devel")).is_err());
    }

    #[test]
    fn values_must_be_a_mapping() {
        assert!(validate_values("").is_ok());
        assert!(validate_values("replicaCount: 2\nimage:\n  tag: x\n").is_ok());
        assert!(validate_values("# only a comment\n").is_ok());
        assert!(validate_values("- a\n- b\n").is_err());
        assert!(validate_values("a: [").is_err());
    }

    #[test]
    fn versions_compare_like_semver() {
        use Ordering::*;
        assert_eq!(compare_versions("1.10.0", "1.9.3"), Greater);
        assert_eq!(compare_versions("v1.16.2", "1.16.2"), Equal);
        assert_eq!(compare_versions("2.0.0-rc.1", "2.0.0"), Less);
        assert_eq!(compare_versions("2.0.0-rc.2", "2.0.0-rc.10"), Less);
        assert_eq!(compare_versions("2.0.0-alpha", "2.0.0-alpha.1"), Less);
        assert_eq!(compare_versions("2.0.0-1", "2.0.0-alpha"), Less);
        assert_eq!(compare_versions("1.2", "1.2.0"), Equal);
        assert_eq!(compare_versions("1.2.0+build.5", "1.2.0"), Equal);
        assert_eq!(compare_versions("latest", "0.0.1"), Less);
        assert!(is_prerelease("4.0.0-beta.2"));
        assert!(!is_prerelease("v4.0.0+g1"));
        let mut versions: Vec<HelmChartVersion> =
            ["1.0.0", "1.10.0", "1.2.0", "1.10.0", "2.0.0-rc.1"]
                .iter()
                .map(|v| HelmChartVersion {
                    version: v.to_string(),
                    app_version: None,
                })
                .collect();
        sort_versions_desc(&mut versions);
        let order: Vec<&str> = versions.iter().map(|v| v.version.as_str()).collect();
        assert_eq!(order, vec!["2.0.0-rc.1", "1.10.0", "1.2.0", "1.0.0"]);
    }

    #[test]
    fn helm_capabilities_from_version() {
        let caps = |v| HelmCaps::from_version(Some(v));
        assert!(!caps("v3.12.3+g3a31588").server_dry_run);
        assert!(caps("v3.13.0").server_dry_run);
        assert_eq!(caps("v3.17.1+g980d8ac"), CAPS3);
        let four = caps("v4.0.1+g12500dd");
        assert!(four.server_dry_run && four.rollback_on_failure);
        assert_eq!(HelmCaps::from_version(None), CAPS3);
        assert_eq!(HelmCaps::from_version(Some("garbage")), CAPS3);
        assert!(is_dry_run_flag_error(
            "helm install failed: invalid argument \"server\" for \"--dry-run\" flag: strconv.ParseBool"
        ));
        assert!(!is_dry_run_flag_error(
            "helm install failed: cannot re-use a name"
        ));
    }

    #[test]
    fn repo_list_and_empty_configuration() {
        let repos = parse_repo_list(
            r#"[{"name":"bitnami","url":"https://charts.bitnami.com/bitnami"},
                {"name":"jetstack","url":"https://charts.jetstack.io"}]"#,
        )
        .unwrap();
        assert_eq!(repos.len(), 2);
        assert_eq!(repos[1].url, "https://charts.jetstack.io");
        assert!(parse_repo_list("").unwrap().is_empty());
        assert!(parse_repo_list("oops").is_err());
        assert!(is_no_repositories("Error: no repositories to show"));
        assert!(is_no_repositories("no repositories configured"));
        assert!(!is_no_repositories(
            "no repositories found matching '[foo]'.  Nothing will be updated"
        ));
    }

    #[test]
    fn repo_update_progress_lines() {
        let out = "Hang tight while we grab the latest from your chart repositories...\n\
...Successfully got an update from the \"bitnami\" chart repository\n\
...Unable to get an update from the \"private\" chart repository (https://charts.example.com):\n\
\tfailed to fetch https://charts.example.com/index.yaml : 401 Unauthorized\n\
Update Complete. ⎈Happy Helming!⎈\n";
        let names: Vec<String> = ["bitnami", "private", "ghost"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let results = parse_repo_update(out, &names);
        assert!(results[0].ok && results[0].error.is_none());
        assert!(!results[1].ok);
        assert_eq!(
            results[1].error.as_deref(),
            Some("failed to fetch https://charts.example.com/index.yaml : 401 Unauthorized")
        );
        assert_eq!(results[2].error.as_deref(), Some(UPDATE_NOT_REPORTED));
    }

    #[test]
    fn search_results_split_repo_and_chart() {
        let out = r#"[
          {"name":"bitnami/nginx","version":"18.2.4","app_version":"1.27.2","description":"NGINX Open Source is a web server."},
          {"name":"stable/nginx-ingress","version":"1.41.3","app_version":"v0.34.1","description":"DEPRECATED! An nginx Ingress controller"},
          {"name":"local","version":"0.1.0","app_version":"","description":""}
        ]"#;
        let charts = parse_search(out).unwrap();
        assert_eq!(charts[0].repo, "bitnami");
        assert_eq!(charts[0].chart, "nginx");
        assert_eq!(charts[0].app_version.as_deref(), Some("1.27.2"));
        assert!(!charts[0].deprecated);
        assert!(charts[1].deprecated);
        assert_eq!(charts[2].repo, "");
        assert_eq!(charts[2].app_version, None);
        assert!(parse_search("").unwrap().is_empty());
        assert!(is_deprecated_description("[Deprecated] use x"));
        assert!(!is_deprecated_description("Not deprecated at all"));

        let versions = r#"[
          {"name":"bitnami/nginx","version":"18.2.3","app_version":"1.27.2"},
          {"name":"bitnami/nginx-ingress-controller","version":"11.5.0","app_version":"1.11.3"},
          {"name":"bitnami/nginx","version":"18.2.4","app_version":"1.27.2"},
          {"name":"bitnami/nginx","version":"19.0.0-rc.1","app_version":"1.27.3"}
        ]"#;
        let list = chart_versions(versions, "bitnami/nginx").unwrap();
        let v: Vec<&str> = list.iter().map(|v| v.version.as_str()).collect();
        assert_eq!(v, vec!["19.0.0-rc.1", "18.2.4", "18.2.3"]);
    }

    #[test]
    fn hub_results_carry_the_repository() {
        let out = r#"[{"url":"https://artifacthub.io/packages/helm/bitnami/nginx","version":"18.2.4",
                       "app_version":"1.27.2","description":"NGINX Open Source",
                       "repository":{"url":"https://charts.bitnami.com/bitnami","name":"bitnami"}},
                      {"url":"https://artifacthub.io/packages/helm/x/y","version":"1.0.0","app_version":"","description":""}]"#;
        let hub = parse_hub_search(out).unwrap();
        assert_eq!(hub[0].repository_name, "bitnami");
        assert_eq!(hub[0].repository_url, "https://charts.bitnami.com/bitnami");
        assert_eq!(hub[1].repository_url, "");
        assert_eq!(hub[1].app_version, None);
    }

    #[test]
    fn chart_metadata_keeps_literal_versions() {
        let yaml = r#"
annotations:
  category: Infrastructure
apiVersion: v2
appVersion: 1.10
dependencies:
- name: common
  repository: oci://registry-1.docker.io/bitnamicharts
  tags: [bitnami-common]
  version: 2.x.x
- name: redis
  condition: redis.enabled
description: NGINX Open Source is a web server
home: https://bitnami.com
icon: https://bitnami.com/assets/stacks/nginx/img/nginx-stack-220x234.png
keywords: [nginx, http, web]
kubeVersion: ">=1.23.0-0"
maintainers:
- name: Broadcom, Inc. All Rights Reserved.
  url: https://github.com/bitnami/charts
- email: ""
name: nginx
sources:
- https://github.com/bitnami/charts/tree/main/bitnami/nginx
type: application
version: 18.2.4
deprecated: true
"#;
        let meta = parse_chart_metadata(yaml).unwrap();
        assert_eq!(meta.name, "nginx");
        assert_eq!(meta.version, "18.2.4");
        assert_eq!(meta.app_version.as_deref(), Some("1.10"));
        assert_eq!(meta.kube_version.as_deref(), Some(">=1.23.0-0"));
        assert_eq!(meta.chart_type.as_deref(), Some("application"));
        assert_eq!(meta.keywords, vec!["nginx", "http", "web"]);
        assert_eq!(
            meta.maintainers.len(),
            1,
            "nameless maintainers are dropped"
        );
        assert_eq!(meta.maintainers[0].email, None);
        assert_eq!(meta.dependencies[0].version.as_deref(), Some("2.x.x"));
        assert_eq!(
            meta.dependencies[1].condition.as_deref(),
            Some("redis.enabled")
        );
        assert!(meta.deprecated);
        let empty = parse_chart_metadata("").unwrap();
        assert!(empty.name.is_empty() && !empty.deprecated);
        let nulls = parse_chart_metadata("name: x\nversion: 1.0.0\nsources:\nkeywords:\n").unwrap();
        assert!(nulls.sources.is_empty() && nulls.keywords.is_empty());
    }

    #[test]
    fn install_output_is_a_release() {
        let out = json!({
            "name": "web", "namespace": "shop", "version": 1,
            "info": {"status": "pending-install", "description": "Dry run complete", "notes": "Visit it"},
            "chart": {"metadata": {"name": "nginx", "version": "18.2.4", "appVersion": "1.27.2"},
                      "values": {"replicaCount": 1, "service": {"type": "ClusterIP"}}},
            "config": {"replicaCount": 2},
            "manifest": "---\n# Source: nginx/templates/svc.yaml\nkind: Service\n"
        });
        let text = format!("WARNING: something\n{out}\n");
        let result = parse_install_output(&text, "fallback").unwrap();
        let release = result.release.unwrap();
        assert_eq!(release.name, "web");
        assert_eq!(release.status, "pending-install");
        assert_eq!(release.chart_version, "18.2.4");
        assert_eq!(result.notes, "Visit it");
        assert!(result.manifest.contains("kind: Service"));
        assert_eq!(result.values_yaml.trim(), "replicaCount: 2");
        assert!(result.computed_values_yaml.contains("type: ClusterIP"));
        let raw = parse_install_output("not json", "ns").unwrap();
        assert!(raw.release.is_none());
        assert_eq!(raw.manifest, "not json");
    }

    fn install_request() -> HelmInstallRequest {
        HelmInstallRequest {
            release_name: "web".into(),
            namespace: "shop".into(),
            chart_ref: "bitnami/nginx".into(),
            version: Some("18.2.4".into()),
            values_yaml: "replicaCount: 2\n".into(),
            create_namespace: true,
            wait: true,
            atomic: true,
            timeout_secs: Some(120),
            description: Some("  first install ".into()),
            dry_run: false,
        }
    }

    #[test]
    fn install_arguments() {
        let request = install_request();
        let args = install_args(
            &request,
            Some("18.2.4"),
            Some(Path::new("/run/v.yaml")),
            CAPS3,
        );
        assert_eq!(
            args,
            strings([
                "install",
                "web",
                "bitnami/nginx",
                "--version=18.2.4",
                "--values=/run/v.yaml",
                "--atomic",
                "--wait",
                "--timeout=120s",
                "--output",
                "json",
                "--create-namespace",
                "--description=first install",
            ])
        );
        let dry = HelmInstallRequest {
            dry_run: true,
            description: None,
            create_namespace: false,
            ..request.clone()
        };
        assert_eq!(
            install_args(&dry, None, None, CAPS3),
            strings([
                "install",
                "web",
                "bitnami/nginx",
                "--dry-run=server",
                "--output",
                "json"
            ])
        );
        let legacy = HelmCaps {
            server_dry_run: false,
            rollback_on_failure: false,
        };
        assert!(install_args(&dry, None, None, legacy).contains(&"--dry-run".to_string()));
        let helm4 = HelmCaps {
            server_dry_run: true,
            rollback_on_failure: true,
        };
        let args = install_args(&request, None, None, helm4);
        assert!(args.contains(&"--rollback-on-failure".to_string()));
        assert!(!args.contains(&"--atomic".to_string()));
    }

    #[test]
    fn upgrade_arguments() {
        let request = HelmUpgradeRequest {
            chart_ref: "bitnami/nginx".into(),
            version: Some("19.0.0".into()),
            values_yaml: String::new(),
            reuse_values: true,
            reset_values: false,
            wait: false,
            atomic: false,
            timeout_secs: None,
            dry_run: false,
        };
        assert_eq!(
            upgrade_args("web", &request, Some("19.0.0"), None, CAPS3),
            strings([
                "upgrade",
                "web",
                "bitnami/nginx",
                "--version=19.0.0",
                "--output",
                "json",
                "--reuse-values"
            ])
        );
        assert_eq!(deploy_timeout(None), HELM_DEPLOY_TIMEOUT);
        assert_eq!(deploy_timeout(Some(1800)), Duration::from_secs(1920));
    }

    #[test]
    fn chart_cache_expires_and_is_bounded() {
        let detail = HelmChartDetail {
            metadata: HelmChartMetadata::default(),
            readme: "r".into(),
            values_yaml: String::new(),
        };
        let key = format!("test-cache|{}", uuid::Uuid::new_v4());
        cache_chart(key.clone(), detail.clone());
        assert_eq!(cached_chart(&key).unwrap().readme, "r");
        for i in 0..CHART_CACHE_CAPACITY + 4 {
            cache_chart(format!("{key}|{i}"), detail.clone());
        }
        assert!(CHART_CACHE.lock().len() <= CHART_CACHE_CAPACITY);
    }
}
