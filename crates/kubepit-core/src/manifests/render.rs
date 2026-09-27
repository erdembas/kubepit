//! Rendering tool folders: `kubectl kustomize` / `kustomize build` for
//! Kustomize directories and `helm template` for charts.
//!
//! Both run locally and never contact a cluster. Tool paths come from the
//! settings overrides (Settings → Tools) and `$PATH`; a missing tool is a
//! clear error naming what to install. Every user value reaches the tool as
//! one argument (`--flag=value` form for flags), so it can never be read as
//! another flag.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, bail, Result};

use crate::helm_charts::{validate_namespace, validate_release_name};
use crate::paths::expand_tilde;
use crate::tools::{find_executable, CommandOutput};
use crate::types::ManifestHelmOptions;

/// Rendering a large overlay or chart (helm may resolve subcharts) is local
/// but can take a while.
pub const RENDER_TIMEOUT: Duration = Duration::from_secs(120);
/// Largest tool output parsed.
pub const MAX_RENDER_BYTES: usize = 64 * 1024 * 1024;

pub const KUSTOMIZE_MISSING: &str = "Rendering a Kustomize folder needs kubectl or kustomize, and neither was found on PATH. Install one, or set the kubectl location in Settings → Tools.";

/// Which binary renders a Kustomize folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KustomizeTool {
    /// `kubectl kustomize <dir>` (kustomize is built into kubectl).
    Kubectl(PathBuf),
    /// `kustomize build <dir>`.
    Kustomize(PathBuf),
}

/// The configured kubectl first (it is what the user runs elsewhere), then a
/// standalone `kustomize` on `$PATH`.
pub fn resolve_kustomize(kubectl_override: Option<&str>) -> Result<KustomizeTool> {
    pick_kustomize(find_executable("kubectl", kubectl_override), || {
        find_executable("kustomize", None)
    })
}

/// The choice behind [`resolve_kustomize`], given what was found.
pub fn pick_kustomize(
    kubectl: Option<PathBuf>,
    kustomize: impl FnOnce() -> Option<PathBuf>,
) -> Result<KustomizeTool> {
    if let Some(kubectl) = kubectl {
        return Ok(KustomizeTool::Kubectl(kubectl));
    }
    match kustomize() {
        Some(kustomize) => Ok(KustomizeTool::Kustomize(kustomize)),
        None => bail!(KUSTOMIZE_MISSING),
    }
}

/// Program and arguments rendering `dir`.
pub fn kustomize_command(tool: &KustomizeTool, dir: &Path) -> (PathBuf, Vec<String>) {
    let dir = dir.to_string_lossy().to_string();
    match tool {
        KustomizeTool::Kubectl(path) => (path.clone(), vec!["kustomize".into(), dir]),
        KustomizeTool::Kustomize(path) => (path.clone(), vec!["build".into(), dir]),
    }
}

/// `helm template` inputs after validation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HelmTemplatePlan {
    pub release: String,
    pub namespace: String,
    pub values: Vec<PathBuf>,
}

/// A release name derived from the chart folder (`My_Chart` → `my-chart`),
/// or helm's own placeholder when nothing valid remains.
pub fn default_release_name(chart_dir: &Path) -> String {
    let raw = chart_dir
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let mut name: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_lowercase() || c.is_ascii_digit() {
                c
            } else {
                '-'
            }
        })
        .collect();
    name.truncate(53);
    let name = name.trim_matches('-').to_string();
    if validate_release_name(&name).is_ok() {
        name
    } else {
        "release-name".to_string()
    }
}

/// Validate release name, namespace and values files (relative values files
/// are resolved against the chart folder and must exist).
pub fn helm_template_plan(
    chart_dir: &Path,
    options: Option<&ManifestHelmOptions>,
) -> Result<HelmTemplatePlan> {
    let release = options
        .map(|o| o.release_name.trim().to_string())
        .filter(|r| !r.is_empty())
        .unwrap_or_else(|| default_release_name(chart_dir));
    validate_release_name(&release)?;
    let namespace = options
        .and_then(|o| o.namespace.as_deref())
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .unwrap_or("default")
        .to_string();
    validate_namespace(&namespace)?;
    let mut values = Vec::new();
    for raw in options
        .map(|o| o.values_files.as_slice())
        .unwrap_or_default()
        .iter()
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
    {
        let path = expand_tilde(raw);
        let path = if path.is_absolute() {
            path
        } else {
            chart_dir.join(path)
        };
        if !path.is_file() {
            bail!("values file {raw} does not exist");
        }
        values.push(path);
    }
    Ok(HelmTemplatePlan {
        release,
        namespace,
        values,
    })
}

/// `helm template <release> <chart> --namespace=… --include-crds --values=…`.
pub fn helm_template_args(chart_dir: &Path, plan: &HelmTemplatePlan) -> Vec<String> {
    let mut args = vec![
        "template".to_string(),
        plan.release.clone(),
        chart_dir.to_string_lossy().to_string(),
        format!("--namespace={}", plan.namespace),
        "--include-crds".to_string(),
    ];
    args.extend(
        plan.values
            .iter()
            .map(|v| format!("--values={}", v.to_string_lossy())),
    );
    args
}

/// `kubectl kustomize /path` for display (program name only, spaced
/// arguments quoted).
pub fn display_command(program: &Path, args: &[String]) -> String {
    let name = program
        .file_stem()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| program.to_string_lossy().to_string());
    std::iter::once(name)
        .chain(args.iter().map(|a| {
            if a.chars().any(char::is_whitespace) {
                format!("'{a}'")
            } else {
                a.clone()
            }
        }))
        .collect::<Vec<_>>()
        .join(" ")
}

/// The error for a failed render: the tool's own message plus a hint for
/// the usual causes.
pub fn render_failure(tool: &str, out: &CommandOutput) -> anyhow::Error {
    let detail = if out.stderr.trim().is_empty() {
        out.stdout.trim()
    } else {
        out.stderr.trim()
    };
    let detail = detail.strip_prefix("Error: ").unwrap_or(detail);
    let detail = if detail.is_empty() {
        format!("exit code {}", out.code.unwrap_or(-1))
    } else {
        detail.to_string()
    };
    let hint = if detail.contains("missing in charts/ directory")
        || detail.contains("found in Chart.yaml, but missing")
    {
        " (run `helm dependency build` in the chart folder first)"
    } else if tool.starts_with("kubectl") && detail.contains("unknown command") {
        " (this kubectl is too old to render Kustomize; install kustomize or a newer kubectl)"
    } else {
        ""
    };
    anyhow!("{tool} failed: {detail}{hint}")
}

/// The tool's output, bounded.
pub fn render_output(tool: &str, out: CommandOutput) -> Result<String> {
    if !out.success {
        return Err(render_failure(tool, &out));
    }
    if out.stdout.len() > MAX_RENDER_BYTES {
        bail!(
            "{tool} produced more than {} MiB of manifests",
            MAX_RENDER_BYTES / (1024 * 1024)
        );
    }
    Ok(out.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn output(success: bool, stdout: &str, stderr: &str) -> CommandOutput {
        CommandOutput {
            success,
            code: Some(if success { 0 } else { 1 }),
            stdout: stdout.into(),
            stderr: stderr.into(),
        }
    }

    #[test]
    fn kustomize_commands() {
        let dir = Path::new("/work/overlays/prod");
        let (program, args) =
            kustomize_command(&KustomizeTool::Kubectl("/usr/bin/kubectl".into()), dir);
        assert_eq!(program, PathBuf::from("/usr/bin/kubectl"));
        assert_eq!(args, vec!["kustomize", "/work/overlays/prod"]);
        let (program, args) =
            kustomize_command(&KustomizeTool::Kustomize("/opt/kustomize".into()), dir);
        assert_eq!(program, PathBuf::from("/opt/kustomize"));
        assert_eq!(args, vec!["build", "/work/overlays/prod"]);
        assert_eq!(
            display_command(Path::new("/usr/bin/kubectl"), &args),
            "kubectl build /work/overlays/prod"
        );
        assert_eq!(
            display_command(Path::new("helm"), &["template".into(), "/a b".into()]),
            "helm template '/a b'"
        );
    }

    #[test]
    fn kustomize_tool_choice_and_missing_tools() {
        let kubectl = PathBuf::from("/bin/kubectl");
        let kustomize = PathBuf::from("/bin/kustomize");
        assert_eq!(
            pick_kustomize(Some(kubectl.clone()), || Some(kustomize.clone())).unwrap(),
            KustomizeTool::Kubectl(kubectl)
        );
        assert_eq!(
            pick_kustomize(None, || Some(kustomize.clone())).unwrap(),
            KustomizeTool::Kustomize(kustomize)
        );
        let err = pick_kustomize(None, || None).unwrap_err();
        assert!(
            err.to_string().contains("needs kubectl or kustomize"),
            "{err}"
        );
        assert!(err.to_string().contains("Settings → Tools"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn kustomize_prefers_the_configured_kubectl() {
        let dir = tempfile::tempdir().unwrap();
        let kubectl = dir.path().join("my-kubectl");
        std::fs::write(&kubectl, "#!/bin/sh\n").unwrap();
        assert_eq!(
            resolve_kustomize(Some(kubectl.to_str().unwrap())).unwrap(),
            KustomizeTool::Kubectl(kubectl)
        );
    }

    #[test]
    fn helm_template_arguments() {
        let dir = tempfile::tempdir().unwrap();
        let chart = dir.path().join("Shop_Chart");
        std::fs::create_dir_all(chart.join("env")).unwrap();
        std::fs::write(chart.join("env/prod.yaml"), "replicas: 3\n").unwrap();
        let extra = dir.path().join("secrets.yaml");
        std::fs::write(&extra, "token: x\n").unwrap();

        let plan = helm_template_plan(&chart, None).unwrap();
        assert_eq!(plan.release, "shop-chart");
        assert_eq!(plan.namespace, "default");
        assert!(plan.values.is_empty());

        let options = ManifestHelmOptions {
            release_name: " shop ".into(),
            namespace: Some("store".into()),
            values_files: vec![
                "env/prod.yaml".into(),
                extra.to_string_lossy().to_string(),
                "  ".into(),
            ],
        };
        let plan = helm_template_plan(&chart, Some(&options)).unwrap();
        let args = helm_template_args(&chart, &plan);
        assert_eq!(
            args,
            vec![
                "template".to_string(),
                "shop".to_string(),
                chart.to_string_lossy().to_string(),
                "--namespace=store".to_string(),
                "--include-crds".to_string(),
                format!("--values={}", chart.join("env/prod.yaml").display()),
                format!("--values={}", extra.display()),
            ]
        );

        let bad = |options: ManifestHelmOptions| {
            helm_template_plan(&chart, Some(&options))
                .unwrap_err()
                .to_string()
        };
        assert!(bad(ManifestHelmOptions {
            release_name: "--post-renderer=x".into(),
            ..Default::default()
        })
        .contains("invalid release name"));
        assert!(bad(ManifestHelmOptions {
            namespace: Some("Bad NS".into()),
            ..Default::default()
        })
        .contains("invalid namespace"));
        assert!(bad(ManifestHelmOptions {
            values_files: vec!["missing.yaml".into()],
            ..Default::default()
        })
        .contains("values file missing.yaml does not exist"));
        assert_eq!(default_release_name(Path::new("/x/---")), "release-name");
    }

    #[test]
    fn failures_map_to_readable_errors() {
        let err = render_failure(
            "helm template",
            &output(
                false,
                "",
                "Error: An error occurred while checking for chart dependencies. You may need to run `helm dependency build` to fetch missing dependencies: found in Chart.yaml, but missing in charts/ directory: redis\n",
            ),
        );
        let text = err.to_string();
        assert!(
            text.starts_with("helm template failed: An error occurred"),
            "{text}"
        );
        assert!(text.ends_with("in the chart folder first)"), "{text}");

        let err = render_failure(
            "kubectl kustomize",
            &output(
                false,
                "",
                "error: unknown command \"kustomize\" for \"kubectl\"",
            ),
        );
        assert!(err.to_string().contains("too old"), "{err}");

        let err = render_failure("kustomize build", &output(false, "", ""));
        assert_eq!(err.to_string(), "kustomize build failed: exit code 1");

        let err = render_output(
            "kubectl kustomize",
            output(
                false,
                "",
                "Error: accumulating resources: missing.yaml: no such file",
            ),
        )
        .unwrap_err();
        assert_eq!(
            err.to_string(),
            "kubectl kustomize failed: accumulating resources: missing.yaml: no such file"
        );
        assert_eq!(
            render_output("helm template", output(true, "kind: A\n", "warning")).unwrap(),
            "kind: A\n"
        );
    }
}
