//! Local manifests: render a folder (plain YAML/JSON, a Kustomize directory
//! or a Helm chart) into documents that remember their source file, then
//! diff and apply them against one or more clusters.
//!
//! | Module       | Responsibility                                            |
//! |--------------|-----------------------------------------------------------|
//! | [`discover`] | picked paths → root + kind, folder walks, fingerprints    |
//! | [`parse`]    | multi-document parsing with source lines, `List` expansion |
//! | [`render`]   | `kubectl kustomize` / `kustomize build` / `helm template` |
//! | [`recent`]   | recently opened sources (`manifests.json`)                |
//! | [`apply`]    | per-document dry run and apply against one cluster        |
//!
//! Rendering never touches a cluster: plain folders are read directly and
//! both tools render locally. The multi-cluster part lives in the UI, which
//! runs [`Kubepit::manifests_dry_run`] / [`Kubepit::manifests_apply`] once per
//! target cluster.

pub mod apply;
pub mod discover;
pub mod parse;
pub mod recent;
pub mod render;

use std::path::PathBuf;

use anyhow::{Context, Result};

use crate::app::Kubepit;
use crate::tools;
use crate::types::{ManifestRecent, ManifestRender, ManifestSource, ManifestSourceKind};
use discover::{fingerprint, kustomization_file, read_plain, relative, resolve, walk_plain};
use parse::{Format, Parsed};
use render::{
    display_command, helm_template_args, helm_template_plan, kustomize_command, render_output,
    resolve_kustomize, KustomizeTool, RENDER_TIMEOUT,
};

async fn blocking<T: Send + 'static>(task: impl FnOnce() -> T + Send + 'static) -> Result<T> {
    tokio::task::spawn_blocking(task)
        .await
        .context("background task failed")
}

/// Values files a helm source depends on (for fingerprints); invalid
/// entries are ignored here, rendering reports them.
fn helm_values(resolved: &discover::Resolved, source: &ManifestSource) -> Vec<PathBuf> {
    if resolved.kind != ManifestSourceKind::Helm {
        return Vec::new();
    }
    helm_template_plan(&resolved.root, source.helm.as_ref())
        .map(|plan| plan.values)
        .unwrap_or_default()
}

impl Kubepit {
    /// `manifests_render`: read or render `source` into documents. A
    /// successful render is remembered in the recent list.
    pub async fn manifests_render(&self, source: &ManifestSource) -> Result<ManifestRender> {
        let resolved = {
            let source = source.clone();
            blocking(move || resolve(&source)).await??
        };
        let settings = self.settings();
        let root_display = resolved.root.to_string_lossy().to_string();
        let mut nested = Vec::new();
        let mut files = 0;
        let mut command = None;
        let parsed = match resolved.kind {
            ManifestSourceKind::Kustomize => {
                let tool = resolve_kustomize(settings.kubectl_path.as_deref())?;
                let (program, args) = kustomize_command(&tool, &resolved.root);
                let label = match tool {
                    KustomizeTool::Kubectl(_) => "kubectl kustomize",
                    KustomizeTool::Kustomize(_) => "kustomize build",
                };
                let out = tools::run(&program, &args, RENDER_TIMEOUT).await?;
                let text = render_output(label, out)?;
                command = Some(display_command(&program, &args));
                let source_name =
                    kustomization_file(&resolved.root).unwrap_or("kustomization.yaml");
                let mut parsed = Parsed::default();
                parsed.add_text(&text, source_name, Format::Rendered);
                parsed
            }
            ManifestSourceKind::Helm => {
                let helm = tools::require_helm(settings.helm_path.as_deref())?;
                let plan = helm_template_plan(&resolved.root, source.helm.as_ref())?;
                let args = helm_template_args(&resolved.root, &plan);
                let out = tools::run(&helm, &args, RENDER_TIMEOUT).await?;
                let text = render_output("helm template", out)?;
                command = Some(display_command(&helm, &args));
                let chart_name = relative(
                    resolved.root.parent().unwrap_or(&resolved.root),
                    &resolved.root,
                );
                let mut parsed = Parsed::default();
                parsed.add_text(&text, &chart_name, Format::Rendered);
                parsed
            }
            ManifestSourceKind::Plain | ManifestSourceKind::Auto => {
                let plain = resolved.clone();
                let (parsed, walked, found) = blocking(move || {
                    let walk = walk_plain(&plain);
                    let mut parsed = Parsed::default();
                    parsed.problems.extend(walk.problems.iter().cloned());
                    let read = read_plain(&plain.root, &walk.files, &mut parsed);
                    (parsed, read, walk.nested)
                })
                .await?;
                files = walked;
                nested = found;
                parsed
            }
        };
        let fingerprint = {
            let values = helm_values(&resolved, source);
            let resolved = resolved.clone();
            blocking(move || fingerprint(&resolved, &values)).await?
        };
        let now = chrono::Utc::now().timestamp_millis();
        if let Err(e) = recent::remember(self.paths().root(), source, now) {
            tracing::warn!("could not update the recent manifests list: {e:#}");
        }
        Ok(ManifestRender {
            root: root_display,
            kind: resolved.kind,
            files,
            documents: parsed.documents,
            problems: parsed.problems,
            nested,
            command,
            fingerprint,
            rendered_at: now,
        })
    }

    /// `manifests_fingerprint`: compare with [`ManifestRender::fingerprint`]
    /// to detect edits (the UI polls it while "watch" is on). Blocking.
    pub fn manifests_fingerprint(&self, source: &ManifestSource) -> Result<String> {
        let resolved = resolve(source)?;
        let values = helm_values(&resolved, source);
        Ok(fingerprint(&resolved, &values))
    }

    /// `manifests_recent_list`, newest first. Blocking.
    pub fn manifests_recent_list(&self) -> Vec<ManifestRecent> {
        recent::load(self.paths().root())
    }

    /// `manifests_recent_remove`: forget the entry with these paths. Blocking.
    pub fn manifests_recent_remove(&self, paths: &[String]) -> Result<Vec<ManifestRecent>> {
        recent::forget(self.paths().root(), paths)
    }
}
