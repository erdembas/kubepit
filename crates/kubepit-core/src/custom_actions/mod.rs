//! Custom actions (k9s-plugin style): user-defined commands run against an
//! object, a multi-selection or a cluster (`~/.kubepit/actions.json`,
//! backend-owned).
//!
//! | Module       | Responsibility                                            |
//! |--------------|-----------------------------------------------------------|
//! | [`model`]    | definitions, validation, shortcuts, scope matching        |
//! | [`template`] | placeholder substitution with context-aware shell quoting |
//! | [`import`]   | Kubepit JSON exports and k9s `plugins.yaml`               |
//! | [`runner`]   | background runs (`sh -c`, timeout, capped output)         |
//!
//! Actions run in three modes: `terminal` (a dock PTY: the login shell
//! runs `/bin/sh -c "$KUBEPIT_ACTION_COMMAND"`, see
//! [`Kubepit::prepare_custom_action_terminal`]), `background` (captured
//! output) and `open-url`. Every run resolves the saved definition by id in
//! the backend, so `mutating` actions are refused on read-only clusters no
//! matter what the UI sends, and `KUBECONFIG` always points at the
//! cluster's `run/<id>.kubeconfig`.
//!
//! The public run entry points (`custom_action_run`,
//! `prepare_custom_action_terminal`) live in `history/audited.rs`: runs of
//! `mutating` actions are recorded in the audit log with the command
//! re-rendered by [`Kubepit::redacted_command`]; output is never stored.

pub mod import;
pub mod model;
pub mod runner;
pub mod template;

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use parking_lot::RwLock;

use crate::app::Kubepit;
use crate::change_journal::normalize::Redactor;
use crate::history::redact::secret_like;
use crate::store::{load_json_or_default, write_json};
use crate::terminal::{LaunchProgram, TerminalLaunch};
use crate::types::ClusterDef;

pub use model::{
    applies_to, normalize_shortcut, validate_action, validate_list, CustomAction,
    CustomActionImport, CustomActionImportNote, CustomActionMode, CustomActionResult,
    CustomActionTarget, CustomActionsFile, CustomActionsState, ResolvedCustomAction,
};
use template::{render_shell, render_url, unknown_placeholders, TemplateValues};

/// Version written to `actions.json`.
pub const FILE_VERSION: u32 = 1;

/// What the login shell runs for a terminal-mode action: echo the resolved
/// command dimmed, then hand over to `sh` (POSIX quoting, whatever the
/// user's shell is).
pub const TERMINAL_SCRIPT: &str = r#"printf '\033[2m$ %s\033[0m\n\n' "$KUBEPIT_ACTION_COMMAND"; exec /bin/sh -c "$KUBEPIT_ACTION_COMMAND""#;

/// The persisted definitions, cached in memory and written through.
pub struct CustomActionsStore {
    path: PathBuf,
    state: RwLock<(Vec<CustomAction>, bool)>,
}

impl CustomActionsStore {
    pub fn open(path: PathBuf) -> Result<Self> {
        let file: CustomActionsFile = load_json_or_default(&path)?;
        // A corrupt file was moved aside: start uninitialized again.
        let initialized = path.exists();
        let mut actions: Vec<CustomAction> = Vec::new();
        for action in file.actions {
            let label = action.name.clone();
            match validate_action(action) {
                Ok(a) if !actions.iter().any(|o| o.id == a.id) => actions.push(a),
                Ok(a) => tracing::warn!("actions.json: duplicate id {:?} skipped", a.id),
                Err(e) => tracing::warn!("actions.json: {label:?} skipped: {e:#}"),
            }
        }
        Ok(Self {
            path,
            state: RwLock::new((actions, initialized)),
        })
    }

    pub fn state(&self) -> CustomActionsState {
        let guard = self.state.read();
        CustomActionsState {
            actions: guard.0.clone(),
            initialized: guard.1,
        }
    }

    pub fn get(&self, id: &str) -> Option<CustomAction> {
        self.state.read().0.iter().find(|a| a.id == id).cloned()
    }

    /// Validate, persist and cache the whole list.
    pub fn replace(&self, actions: Vec<CustomAction>) -> Result<Vec<CustomAction>> {
        let actions = validate_list(actions)?;
        let mut guard = self.state.write();
        let file = CustomActionsFile {
            version: FILE_VERSION,
            actions: actions.clone(),
        };
        write_json(&self.path, &file, false)?;
        *guard = (actions.clone(), true);
        Ok(actions)
    }
}

fn read_import_file(path: &Path) -> Result<String> {
    let meta =
        std::fs::metadata(path).with_context(|| format!("cannot read {}", path.display()))?;
    if !meta.is_file() {
        bail!("{} is not a file", path.display());
    }
    if meta.len() > import::MAX_IMPORT_BYTES {
        bail!("{} is larger than 1 MiB", path.display());
    }
    std::fs::read_to_string(path).with_context(|| format!("cannot read {}", path.display()))
}

impl Kubepit {
    /// `custom_actions_list`.
    pub fn custom_actions_list(&self) -> CustomActionsState {
        self.custom_actions.state()
    }

    /// `custom_actions_save`: replace the whole list (order included).
    pub fn custom_actions_save(&self, actions: Vec<CustomAction>) -> Result<Vec<CustomAction>> {
        self.custom_actions.replace(actions)
    }

    /// `custom_actions_import`: read definitions from a file the user picked
    /// (`path`, desktop) or from its text (`text`, browser previews). The
    /// format is detected; nothing is saved.
    pub fn custom_actions_import(
        &self,
        path: Option<&str>,
        text: Option<&str>,
    ) -> Result<CustomActionImport> {
        let owned;
        let text = match (path.map(str::trim).filter(|p| !p.is_empty()), text) {
            (Some(path), _) => {
                owned = read_import_file(&crate::paths::expand_tilde(path))?;
                owned.as_str()
            }
            (None, Some(text)) => {
                if text.len() as u64 > import::MAX_IMPORT_BYTES {
                    bail!("the file is larger than 1 MiB");
                }
                text
            }
            (None, None) => bail!("nothing to import"),
        };
        import::parse_import(text)
    }

    /// Placeholder values for a target. Without a cluster (previews in the
    /// settings) sample values stand in for the cluster ones.
    fn template_values(
        &self,
        cluster: Option<&ClusterDef>,
        kubeconfig: Option<&Path>,
        target: &CustomActionTarget,
    ) -> TemplateValues {
        let nonempty = |v: &Option<String>| v.clone().filter(|s| !s.is_empty());
        let (cluster_name, context, kubeconfig) = match cluster {
            Some(c) => (
                c.name.clone(),
                c.context.clone(),
                kubeconfig
                    .map(Path::to_path_buf)
                    .or_else(|| self.paths().run_kubeconfig(&c.id).ok()),
            ),
            None => (
                "my-cluster".to_string(),
                "my-context".to_string(),
                Some(self.paths().run_dir().join("example.kubeconfig")),
            ),
        };
        TemplateValues {
            cluster: Some(cluster_name),
            context: Some(context),
            kubeconfig: kubeconfig.map(|p| p.to_string_lossy().to_string()),
            namespace: nonempty(&target.namespace),
            name: nonempty(&target.name),
            kind: nonempty(&target.kind),
            group: target.group.clone(),
            version: nonempty(&target.version),
            resource: nonempty(&target.resource),
            container: nonempty(&target.container),
            labels: target.labels.clone(),
            annotations: target.annotations.clone(),
            selection: target
                .selection
                .iter()
                .filter(|s| !s.is_empty())
                .cloned()
                .collect(),
        }
    }

    /// `custom_action_resolve`: what `action` (possibly an unsaved draft)
    /// would run for `target`. Only reads; allowed on read-only clusters.
    pub fn custom_action_resolve(
        &self,
        action: &CustomAction,
        cluster_id: Option<&str>,
        target: &CustomActionTarget,
    ) -> Result<ResolvedCustomAction> {
        let cluster = match cluster_id.filter(|id| !id.is_empty()) {
            Some(id) => Some(self.cluster_def(id)?),
            None => None,
        };
        let values = self.template_values(cluster.as_ref(), None, target);
        let rendered = match action.mode {
            CustomActionMode::OpenUrl => render_url(&action.command, &values)?,
            _ => render_shell(&action.command, &values)?,
        };
        Ok(ResolvedCustomAction {
            command: rendered.text,
            missing: rendered.missing,
            unknown: unknown_placeholders(&action.command),
        })
    }

    /// The saved action `action_id`, checked for a run against `target`.
    pub(crate) fn runnable_action(
        &self,
        cluster_id: &str,
        action_id: &str,
        target: &CustomActionTarget,
    ) -> Result<(CustomAction, ClusterDef)> {
        let action = self
            .custom_actions
            .get(action_id)
            .ok_or_else(|| anyhow!("custom action {action_id} does not exist"))?;
        if !action.enabled {
            bail!("the custom action \"{}\" is disabled", action.name);
        }
        let cluster = if action.mutating {
            self.ensure_writable(
                cluster_id,
                &format!("running the custom action \"{}\"", action.name),
            )?
        } else {
            self.cluster_def(cluster_id)?
        };
        if !applies_to(&action, &cluster, target) {
            bail!(
                "the custom action \"{}\" does not apply to this {}",
                action.name,
                target.kind.as_deref().unwrap_or("cluster")
            );
        }
        Ok((action, cluster))
    }

    fn action_env(
        cluster: &ClusterDef,
        kubeconfig: &Path,
        action: &CustomAction,
        target: &CustomActionTarget,
    ) -> Vec<(String, String)> {
        let mut env = vec![
            (
                "KUBECONFIG".to_string(),
                kubeconfig.to_string_lossy().to_string(),
            ),
            ("KUBEPIT_CLUSTER".to_string(), cluster.name.clone()),
            ("KUBEPIT_CONTEXT".to_string(), cluster.context.clone()),
            ("KUBEPIT_ACTION".to_string(), action.name.clone()),
        ];
        if let Some(ns) = target.namespace.as_deref().filter(|ns| !ns.is_empty()) {
            env.push(("KUBEPIT_NAMESPACE".to_string(), ns.to_string()));
        }
        env
    }

    /// The command `action` runs for `target`, as the audit log keeps it:
    /// every `annotations.*` value (and, for Secret-like kinds, every
    /// `labels.*` value) is replaced by one of `redactor`'s markers.
    pub(crate) fn redacted_command(
        &self,
        action: &CustomAction,
        cluster: &ClusterDef,
        target: &CustomActionTarget,
        redactor: &Redactor,
    ) -> Result<String> {
        let mut values = self.template_values(Some(cluster), None, target);
        let mask = |map: &mut std::collections::BTreeMap<String, String>| {
            for (key, value) in map.iter_mut() {
                let marker = redactor.secret_marker(key, &serde_json::Value::String(value.clone()));
                *value = marker.as_str().unwrap_or_default().to_string();
            }
        };
        mask(&mut values.annotations);
        if secret_like(target.kind.as_deref().unwrap_or_default()) {
            mask(&mut values.labels);
        }
        Ok(render_shell(&action.command, &values)?.text)
    }

    /// `custom_action_run` without the audit log (see `history/audited.rs`):
    /// run a saved `background` action and capture its output, or resolve an
    /// `open-url` action's URL for the UI to open.
    pub(crate) async fn custom_action_run_unaudited(
        &self,
        cluster_id: &str,
        action_id: &str,
        target: &CustomActionTarget,
    ) -> Result<CustomActionResult> {
        let (action, cluster) = self.runnable_action(cluster_id, action_id, target)?;
        match action.mode {
            CustomActionMode::Terminal => {
                bail!("the custom action \"{}\" runs in a terminal", action.name)
            }
            CustomActionMode::OpenUrl => {
                let values = self.template_values(Some(&cluster), None, target);
                let url = render_url(&action.command, &values)?;
                Ok(CustomActionResult {
                    mode: action.mode,
                    command: url.text,
                    ..Default::default()
                })
            }
            CustomActionMode::Background => {
                let kubeconfig = self.write_run_kubeconfig(&cluster)?;
                let values = self.template_values(Some(&cluster), Some(&kubeconfig), target);
                let command = render_shell(&action.command, &values)?.text;
                let env = Self::action_env(&cluster, &kubeconfig, &action, target);
                let timeout = Duration::from_secs(u64::from(action.timeout_secs.max(1)));
                let out = runner::run_shell(&command, &env, timeout).await?;
                Ok(CustomActionResult {
                    mode: action.mode,
                    command,
                    exit_code: out.exit_code,
                    stdout: out.stdout,
                    stderr: out.stderr,
                    timed_out: out.timed_out,
                    truncated: out.truncated,
                    duration_ms: out.duration_ms,
                })
            }
        }
    }

    /// Launch plan of a `terminal` action (`TerminalSpec::CustomAction`),
    /// without the audit log (see `history/audited.rs`).
    pub(crate) fn prepare_custom_action_terminal_unaudited(
        &self,
        cluster_id: &str,
        action_id: &str,
        target: &CustomActionTarget,
    ) -> Result<TerminalLaunch> {
        let (action, cluster) = self.runnable_action(cluster_id, action_id, target)?;
        if action.mode != CustomActionMode::Terminal {
            bail!(
                "the custom action \"{}\" does not run in a terminal",
                action.name
            );
        }
        let kubeconfig = self.write_run_kubeconfig(&cluster)?;
        let values = self.template_values(Some(&cluster), Some(&kubeconfig), target);
        let command = render_shell(&action.command, &values)?.text;
        let mut env = Self::action_env(&cluster, &kubeconfig, &action, target);
        env.push(("KUBEPIT_ACTION_COMMAND".to_string(), command.clone()));
        let program = if cfg!(windows) {
            LaunchProgram::Exec {
                program: runner::posix_shell()?,
                args: vec!["-c".to_string(), command],
            }
        } else {
            LaunchProgram::LoginShellCommand {
                override_path: self.settings().shell_path,
                script: TERMINAL_SCRIPT.to_string(),
            }
        };
        Ok(TerminalLaunch {
            program,
            env,
            cwd: dirs::home_dir().unwrap_or_else(|| PathBuf::from("/")),
            cleanup: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::cluster::tests_support::app_with_cluster;
    use crate::error::is_read_only;

    fn action(id: &str, command: &str) -> CustomAction {
        CustomAction {
            id: id.into(),
            name: format!("Action {id}"),
            command: command.into(),
            scopes: vec!["Pod".into(), "cluster".into()],
            ..Default::default()
        }
    }

    fn pod(name: &str) -> CustomActionTarget {
        CustomActionTarget {
            namespace: Some("shop".into()),
            name: Some(name.into()),
            kind: Some("Pod".into()),
            group: Some(String::new()),
            version: Some("v1".into()),
            resource: Some("pods".into()),
            ..Default::default()
        }
    }

    #[test]
    fn persistence_round_trips_and_tracks_initialization() {
        let (_dir, app, _cluster) = app_with_cluster(false);
        let first = app.custom_actions_list();
        assert!(!first.initialized);
        assert!(first.actions.is_empty());

        let saved = app
            .custom_actions_save(vec![
                action("b", "echo {name}"),
                CustomAction {
                    id: String::new(),
                    ..action("", "  echo {namespace}  ")
                },
            ])
            .unwrap();
        assert_eq!(saved.len(), 2);
        assert_eq!(saved[0].id, "b");
        assert!(!saved[1].id.is_empty());
        assert_eq!(saved[1].command, "echo {namespace}");

        let reopened = CustomActionsStore::open(app.paths().custom_actions_file()).unwrap();
        let state = reopened.state();
        assert!(state.initialized);
        assert_eq!(state.actions, saved);

        // An empty list stays empty (examples are only seeded once, by the UI).
        app.custom_actions_save(vec![]).unwrap();
        let state = app.custom_actions_list();
        assert!(state.initialized && state.actions.is_empty());

        // Invalid lists are rejected without touching the file.
        assert!(app
            .custom_actions_save(vec![action("a", "x"), action("a", "y")])
            .is_err());
        assert!(app.custom_actions_list().actions.is_empty());
    }

    #[test]
    fn corrupt_or_hand_edited_files_load_what_is_valid() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("actions.json");
        std::fs::write(&path, "{not json").unwrap();
        let store = CustomActionsStore::open(path.clone()).unwrap();
        assert!(!store.state().initialized);

        std::fs::write(
            &path,
            serde_json::json!({
                "version": 1,
                "actions": [
                    { "id": "ok", "name": "Ok", "command": "echo" },
                    { "id": "bad", "name": "", "command": "echo" },
                    { "id": "ok", "name": "Dup", "command": "echo" }
                ]
            })
            .to_string(),
        )
        .unwrap();
        let store = CustomActionsStore::open(path).unwrap();
        let state = store.state();
        assert!(state.initialized);
        assert_eq!(state.actions.len(), 1);
        assert_eq!(state.actions[0].name, "Ok");
    }

    #[test]
    fn resolve_uses_cluster_values_and_samples() {
        let (_dir, app, cluster) = app_with_cluster(false);
        let a = action("a", "kubectl --kubeconfig {kubeconfig} --context {context} -n {namespace} get {resource} {name} # {cluster} {namepsace}");
        let resolved = app
            .custom_action_resolve(&a, Some(&cluster.id), &pod("web-0"))
            .unwrap();
        let run = app.paths().run_kubeconfig(&cluster.id).unwrap();
        assert_eq!(
            resolved.command,
            format!(
                "kubectl --kubeconfig {} --context dev -n shop get pods web-0 # {{cluster}} {{namepsace}}",
                template::shell_quote(&run.to_string_lossy())
            )
        );
        assert_eq!(resolved.unknown, vec!["{namepsace}"]);

        let sample = app
            .custom_action_resolve(&action("s", "echo {cluster} {container}"), None, &pod("p"))
            .unwrap();
        assert_eq!(sample.command, "echo my-cluster ''");
        assert_eq!(sample.missing, vec!["{container}"]);
        assert!(app
            .custom_action_resolve(&a, Some("missing"), &pod("p"))
            .is_err());
    }

    #[test]
    fn redacted_commands_mask_annotations_and_secret_labels() {
        let (_dir, app, cluster) = app_with_cluster(false);
        let a = action("r", "echo {annotations.note} {labels.app} {name}");
        let redactor = Redactor::new();
        let mut target = pod("web-0");
        target.annotations = BTreeMap::from([("note".into(), "hunter2".into())]);
        target.labels = BTreeMap::from([("app".into(), "shop".into())]);
        let pod_command = app
            .redacted_command(&a, &cluster, &target, &redactor)
            .unwrap();
        assert!(!pod_command.contains("hunter2"), "{pod_command}");
        assert!(
            pod_command.starts_with("echo '<redacted #"),
            "{pod_command}"
        );
        assert!(pod_command.ends_with(" shop web-0"), "{pod_command}");
        // Labels of Secret-like kinds are masked too.
        target.kind = Some("SealedSecret".into());
        let secret_command = app
            .redacted_command(&a, &cluster, &target, &redactor)
            .unwrap();
        assert!(!secret_command.contains("shop"), "{secret_command}");
        assert!(secret_command.ends_with(" web-0"), "{secret_command}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn background_runs_pass_hostile_values_verbatim() {
        let (dir, app, cluster) = app_with_cluster(false);
        let marker = dir.path().join("pwned");
        let m = marker.to_string_lossy().to_string();
        let hostile = format!("$(touch {m}); `touch {m}`; touch {m} ' \" \\ *");
        let mut a = action(
            "h",
            "printf '%s|' {name} \"{annotations.note}\" '{labels.app}' {namespace}",
        );
        a.mode = CustomActionMode::Background;
        app.custom_actions_save(vec![a]).unwrap();
        let mut target = pod(&hostile);
        target.annotations = BTreeMap::from([("note".into(), hostile.clone())]);
        target.labels = BTreeMap::from([("app".into(), hostile.clone())]);
        let out = app
            .custom_action_run(&cluster.id, "h", &target)
            .await
            .unwrap();
        assert_eq!(out.exit_code, Some(0), "{out:?}");
        assert_eq!(out.stdout, format!("{hostile}|{hostile}|{hostile}|shop|"));
        assert!(!marker.exists());
        assert!(app.paths().run_kubeconfig(&cluster.id).unwrap().exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn background_runs_see_the_cluster_kubeconfig() {
        let (_dir, app, cluster) = app_with_cluster(false);
        let mut a = action(
            "env",
            "printf '%s\\n' \"$KUBECONFIG\" \"$KUBEPIT_CONTEXT\" \"$KUBEPIT_NAMESPACE\"",
        );
        a.mode = CustomActionMode::Background;
        app.custom_actions_save(vec![a]).unwrap();
        let out = app
            .custom_action_run(&cluster.id, "env", &pod("p"))
            .await
            .unwrap();
        let run = app.paths().run_kubeconfig(&cluster.id).unwrap();
        assert_eq!(
            out.stdout,
            format!("{}\ndev\nshop\n", run.to_string_lossy())
        );
    }

    #[tokio::test]
    async fn mutating_actions_are_refused_on_read_only_clusters() {
        let (_dir, app, cluster) = app_with_cluster(true);
        let mut mutating = action("m", "kubectl delete pod {name}");
        mutating.mutating = true;
        mutating.mode = CustomActionMode::Background;
        let mut terminal = action("t", "kubectl delete pod {name}");
        terminal.mutating = true;
        let mut url = action("u", "https://example.com/{name}");
        url.mode = CustomActionMode::OpenUrl;
        url.mutating = true;
        let mut reader = action("r", "https://example.com/{name}");
        reader.mode = CustomActionMode::OpenUrl;
        app.custom_actions_save(vec![mutating, terminal, url, reader])
            .unwrap();

        let err = app
            .custom_action_run(&cluster.id, "m", &pod("p"))
            .await
            .unwrap_err();
        assert!(is_read_only(&err), "{err:#}");
        let err = app
            .custom_action_run(&cluster.id, "u", &pod("p"))
            .await
            .unwrap_err();
        assert!(is_read_only(&err));
        let err = app
            .prepare_custom_action_terminal(&cluster.id, "t", &pod("p"))
            .unwrap_err();
        assert!(is_read_only(&err));

        let ok = app
            .custom_action_run(&cluster.id, "r", &pod("web 0"))
            .await
            .unwrap();
        assert_eq!(ok.command, "https://example.com/web%200");
    }

    #[tokio::test]
    async fn runs_check_enabled_mode_and_scope() {
        let (_dir, app, cluster) = app_with_cluster(false);
        let mut disabled = action("d", "echo");
        disabled.enabled = false;
        disabled.mode = CustomActionMode::Background;
        let terminal = action("t", "echo {name}");
        let mut nodes = action("n", "echo {name}");
        nodes.scopes = vec!["Node".into()];
        nodes.mode = CustomActionMode::Background;
        app.custom_actions_save(vec![disabled, terminal, nodes])
            .unwrap();

        assert!(app
            .custom_action_run(&cluster.id, "d", &pod("p"))
            .await
            .is_err());
        assert!(app
            .custom_action_run(&cluster.id, "t", &pod("p"))
            .await
            .is_err());
        assert!(app
            .custom_action_run(&cluster.id, "n", &pod("p"))
            .await
            .is_err());
        assert!(app
            .custom_action_run(&cluster.id, "nope", &pod("p"))
            .await
            .is_err());
        assert!(app.custom_action_run("nope", "t", &pod("p")).await.is_err());
    }

    #[test]
    fn terminal_actions_run_through_the_login_shell() {
        let (_dir, app, cluster) = app_with_cluster(false);
        app.custom_actions_save(vec![action("t", "kubectl logs -f {name} -n {namespace}")])
            .unwrap();
        let launch = app
            .prepare_custom_action_terminal(&cluster.id, "t", &pod("web 0"))
            .unwrap();
        let env: std::collections::HashMap<_, _> = launch.env.into_iter().collect();
        assert_eq!(
            env["KUBEPIT_ACTION_COMMAND"],
            "kubectl logs -f 'web 0' -n shop"
        );
        let run = app.paths().run_kubeconfig(&cluster.id).unwrap();
        assert_eq!(env["KUBECONFIG"], run.to_string_lossy());
        assert!(run.exists());
        if cfg!(unix) {
            assert_eq!(
                launch.program,
                LaunchProgram::LoginShellCommand {
                    override_path: None,
                    script: TERMINAL_SCRIPT.to_string(),
                }
            );
        }
        // Cluster-level runs have no object.
        let cluster_level = app
            .prepare_custom_action_terminal(&cluster.id, "t", &CustomActionTarget::default())
            .unwrap();
        let env: std::collections::HashMap<_, _> = cluster_level.env.into_iter().collect();
        assert_eq!(env["KUBEPIT_ACTION_COMMAND"], "kubectl logs -f '' -n ''");
    }

    #[cfg(unix)]
    #[test]
    fn the_terminal_script_hands_the_command_to_sh() {
        let out = std::process::Command::new("/bin/sh")
            .args(["-c", TERMINAL_SCRIPT])
            .env("KUBEPIT_ACTION_COMMAND", "printf '%s' 'it'\\''s'")
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(stdout.ends_with("it's"), "{stdout:?}");
        assert!(stdout.contains("$ printf"));
    }

    #[test]
    fn contract_shapes() {
        let spec: crate::types::TerminalSpec = serde_json::from_value(serde_json::json!({
            "kind": "custom-action",
            "cluster_id": "c",
            "action_id": "a",
            "target": { "name": "web-0", "labels": { "app": "web" }, "selection": [] }
        }))
        .unwrap();
        let crate::types::TerminalSpec::CustomAction {
            cluster_id,
            action_id,
            target,
        } = spec
        else {
            panic!("not a custom action spec");
        };
        assert_eq!((cluster_id.as_str(), action_id.as_str()), ("c", "a"));
        assert_eq!(target.name.as_deref(), Some("web-0"));
        assert_eq!(target.labels["app"], "web");

        let json = serde_json::to_value(CustomAction::default()).unwrap();
        assert_eq!(json["mode"], "terminal");
        assert_eq!(json["shortcut"], serde_json::Value::Null);
        let url: CustomActionMode = serde_json::from_value(serde_json::json!("open-url")).unwrap();
        assert_eq!(url, CustomActionMode::OpenUrl);

        let settings: crate::types::Settings =
            serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(!settings.keyboard_mode);
    }

    #[test]
    fn imports_read_paths_or_text() {
        let (dir, app, _cluster) = app_with_cluster(false);
        let file = dir.path().join("plugins.yaml");
        std::fs::write(
            &file,
            "plugins:\n  neat:\n    scopes: [all]\n    command: sh\n    args: [-c, \"kubectl get $RESOURCE_NAME $NAME -n $NAMESPACE -o yaml | kubectl neat\"]\n",
        )
        .unwrap();
        let out = app
            .custom_actions_import(Some(&file.to_string_lossy()), None)
            .unwrap();
        assert_eq!(out.format, "k9s");
        assert_eq!(
            out.actions[0].command,
            "kubectl get {resource} {name} -n {namespace} -o yaml | kubectl neat"
        );
        let text = app.custom_actions_import(None, Some("[]")).unwrap();
        assert_eq!(text.format, "kubepit");
        assert!(app.custom_actions_import(None, None).is_err());
        assert!(app
            .custom_actions_import(Some(&dir.path().to_string_lossy()), None)
            .is_err());
    }
}
