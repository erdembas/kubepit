//! What runs inside a terminal PTY for each [`TerminalSpec`].
//!
//! The desktop shell owns the PTY (RunHQ's pipeline); this module decides
//! the program, arguments, environment and working directory, and — for
//! node shells — creates the helper pod first and hands back a cleanup hook
//! that deletes it when the terminal goes away.
//!
//! Pod sessions shell out to `kubectl exec/attach -it` against the
//! cluster's generated single-context kubeconfig: kubectl already handles
//! TTY resize, SPDY/WebSocket fallbacks and exec auth plugins perfectly, and
//! users get exactly the behaviour they know from their own terminal.

use std::path::{Path, PathBuf};

use anyhow::Result;

use crate::app::Kubepit;
use crate::node_shell::NODE_SHELL_EXEC;
use crate::tools;
use crate::types::TerminalSpec;

/// Default command for `pod-exec` when the UI sends none.
pub const DEFAULT_EXEC_COMMAND: [&str; 3] = ["sh", "-c", "clear; (bash || ash || sh)"];

/// The program to start in the PTY.
#[derive(Debug, Clone, PartialEq)]
pub enum LaunchProgram {
    /// The user's login shell (`settings.shell_path` override, else `$SHELL`).
    LoginShell { override_path: Option<String> },
    /// A specific program with literal arguments.
    Exec { program: PathBuf, args: Vec<String> },
    /// The login shell running `script` (`<shell> <login args> -c <script>`);
    /// custom actions in terminal mode.
    LoginShellCommand {
        override_path: Option<String>,
        script: String,
    },
}

/// Everything the PTY manager needs to start a terminal.
pub struct TerminalLaunch {
    pub program: LaunchProgram,
    pub env: Vec<(String, String)>,
    pub cwd: PathBuf,
    /// Runs exactly once when the terminal is destroyed or exits.
    pub cleanup: Option<Box<dyn FnOnce() + Send + 'static>>,
}

impl std::fmt::Debug for TerminalLaunch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TerminalLaunch")
            .field("program", &self.program)
            .field("env", &self.env)
            .field("cwd", &self.cwd)
            .field("cleanup", &self.cleanup.is_some())
            .finish()
    }
}

fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

fn kubectl_base(kubeconfig: &Path, context: &str) -> Vec<String> {
    vec![
        "--kubeconfig".to_string(),
        kubeconfig.to_string_lossy().to_string(),
        "--context".to_string(),
        context.to_string(),
    ]
}

/// `kubectl … exec -i -t -n <ns> <pod> [-c <container>] -- <command>`.
pub fn kubectl_exec_args(
    kubeconfig: &Path,
    context: &str,
    namespace: &str,
    pod: &str,
    container: Option<&str>,
    command: &[String],
) -> Vec<String> {
    let mut args = kubectl_base(kubeconfig, context);
    args.extend(["exec", "-i", "-t", "-n", namespace, pod].map(String::from));
    if let Some(c) = container.filter(|c| !c.is_empty()) {
        args.extend(["-c".to_string(), c.to_string()]);
    }
    args.push("--".to_string());
    args.extend(command.iter().cloned());
    args
}

/// `kubectl … attach -i -t -n <ns> <pod> [-c <container>]`.
pub fn kubectl_attach_args(
    kubeconfig: &Path,
    context: &str,
    namespace: &str,
    pod: &str,
    container: Option<&str>,
) -> Vec<String> {
    let mut args = kubectl_base(kubeconfig, context);
    args.extend(["attach", "-i", "-t", "-n", namespace, pod].map(String::from));
    if let Some(c) = container.filter(|c| !c.is_empty()) {
        args.extend(["-c".to_string(), c.to_string()]);
    }
    args
}

impl Kubepit {
    /// Resolve a terminal spec into a launch plan. `progress` receives text
    /// to show in the terminal before the PTY starts (node-shell pod
    /// creation); it returns `false` once the terminal is gone.
    pub async fn prepare_terminal(
        &self,
        terminal_id: &str,
        spec: &TerminalSpec,
        progress: &(dyn Fn(&str) -> bool + Send + Sync),
    ) -> Result<TerminalLaunch> {
        let settings = self.settings();
        match spec {
            TerminalSpec::Local {
                cluster_id,
                namespace,
            } => {
                let mut env = Vec::new();
                if let Some(id) = cluster_id.as_deref().filter(|id| !id.is_empty()) {
                    let cluster = self.cluster_def(id)?;
                    let kubeconfig = self.write_run_kubeconfig(&cluster)?;
                    env.push((
                        "KUBECONFIG".to_string(),
                        kubeconfig.to_string_lossy().to_string(),
                    ));
                    env.push(("KUBEPIT_CLUSTER".to_string(), cluster.name.clone()));
                    env.push(("KUBEPIT_CONTEXT".to_string(), cluster.context.clone()));
                }
                if let Some(ns) = namespace.as_deref().filter(|ns| !ns.is_empty()) {
                    env.push(("KUBEPIT_NAMESPACE".to_string(), ns.to_string()));
                }
                Ok(TerminalLaunch {
                    program: LaunchProgram::LoginShell {
                        override_path: settings.shell_path.clone(),
                    },
                    env,
                    cwd: home_dir(),
                    cleanup: None,
                })
            }
            TerminalSpec::PodExec {
                cluster_id,
                namespace,
                pod,
                container,
                command,
            } => {
                let kubectl = tools::require_kubectl(settings.kubectl_path.as_deref())?;
                let cluster = self.cluster_def(cluster_id)?;
                let kubeconfig = self.write_run_kubeconfig(&cluster)?;
                let command: Vec<String> = match command {
                    Some(cmd) if !cmd.is_empty() => cmd.clone(),
                    _ => DEFAULT_EXEC_COMMAND.map(String::from).to_vec(),
                };
                Ok(TerminalLaunch {
                    program: LaunchProgram::Exec {
                        program: kubectl,
                        args: kubectl_exec_args(
                            &kubeconfig,
                            &cluster.context,
                            namespace,
                            pod,
                            container.as_deref(),
                            &command,
                        ),
                    },
                    env: vec![("KUBEPIT_CLUSTER".to_string(), cluster.name.clone())],
                    cwd: home_dir(),
                    cleanup: None,
                })
            }
            TerminalSpec::PodAttach {
                cluster_id,
                namespace,
                pod,
                container,
            } => {
                let kubectl = tools::require_kubectl(settings.kubectl_path.as_deref())?;
                let cluster = self.cluster_def(cluster_id)?;
                let kubeconfig = self.write_run_kubeconfig(&cluster)?;
                Ok(TerminalLaunch {
                    program: LaunchProgram::Exec {
                        program: kubectl,
                        args: kubectl_attach_args(
                            &kubeconfig,
                            &cluster.context,
                            namespace,
                            pod,
                            container.as_deref(),
                        ),
                    },
                    env: vec![("KUBEPIT_CLUSTER".to_string(), cluster.name.clone())],
                    cwd: home_dir(),
                    cleanup: None,
                })
            }
            TerminalSpec::CustomAction {
                cluster_id,
                action_id,
                target,
            } => self.prepare_custom_action_terminal(cluster_id, action_id, target),
            TerminalSpec::NodeShell { cluster_id, node } => {
                let cluster = self.ensure_writable(cluster_id, "opening a node shell")?;
                // Check kubectl before creating anything on the cluster.
                let kubectl = tools::require_kubectl(settings.kubectl_path.as_deref())?;
                let kubeconfig = self.write_run_kubeconfig(&cluster)?;
                let pod = self
                    .start_node_shell(terminal_id, cluster_id, node, progress)
                    .await?;
                let command = ["sh", "-c", NODE_SHELL_EXEC].map(String::from);
                Ok(TerminalLaunch {
                    program: LaunchProgram::Exec {
                        program: kubectl,
                        args: kubectl_exec_args(
                            &kubeconfig,
                            &cluster.context,
                            &pod.namespace,
                            &pod.name,
                            None,
                            &command,
                        ),
                    },
                    env: vec![("KUBEPIT_CLUSTER".to_string(), cluster.name.clone())],
                    cwd: home_dir(),
                    cleanup: Some(self.node_shell_cleanup(&pod.name)),
                })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cluster::tests_support::app_with_cluster;

    #[test]
    fn exec_args_match_kubectl_syntax() {
        let args = kubectl_exec_args(
            Path::new("/k/run/c.kubeconfig"),
            "prod",
            "shop",
            "web-0",
            Some("app"),
            &DEFAULT_EXEC_COMMAND.map(String::from),
        );
        assert_eq!(
            args,
            vec![
                "--kubeconfig",
                "/k/run/c.kubeconfig",
                "--context",
                "prod",
                "exec",
                "-i",
                "-t",
                "-n",
                "shop",
                "web-0",
                "-c",
                "app",
                "--",
                "sh",
                "-c",
                "clear; (bash || ash || sh)"
            ]
        );
    }

    #[test]
    fn attach_args_skip_empty_container() {
        let args = kubectl_attach_args(Path::new("/k"), "ctx", "ns", "p", Some(""));
        assert_eq!(
            args,
            vec![
                "--kubeconfig",
                "/k",
                "--context",
                "ctx",
                "attach",
                "-i",
                "-t",
                "-n",
                "ns",
                "p"
            ]
        );
    }

    #[tokio::test]
    async fn local_terminal_points_kubeconfig_at_run_file() {
        let (_dir, app, cluster) = app_with_cluster(false);
        let spec = TerminalSpec::Local {
            cluster_id: Some(cluster.id.clone()),
            namespace: Some("team-a".into()),
        };
        let launch = app.prepare_terminal("t1", &spec, &|_| true).await.unwrap();
        assert!(matches!(launch.program, LaunchProgram::LoginShell { .. }));
        let env: std::collections::HashMap<_, _> = launch.env.into_iter().collect();
        let run = app.paths().run_kubeconfig(&cluster.id).unwrap();
        assert_eq!(env["KUBECONFIG"], run.to_string_lossy());
        assert_eq!(env["KUBEPIT_CLUSTER"], cluster.name);
        assert_eq!(env["KUBEPIT_NAMESPACE"], "team-a");
        assert!(run.exists());

        let plain = app
            .prepare_terminal(
                "t2",
                &TerminalSpec::Local {
                    cluster_id: None,
                    namespace: None,
                },
                &|_| true,
            )
            .await
            .unwrap();
        assert!(plain.env.is_empty());
    }

    #[tokio::test]
    async fn node_shell_is_blocked_on_read_only_clusters() {
        let (_dir, app, cluster) = app_with_cluster(true);
        let spec = TerminalSpec::NodeShell {
            cluster_id: cluster.id.clone(),
            node: "n1".into(),
        };
        let err = app
            .prepare_terminal("t", &spec, &|_| true)
            .await
            .unwrap_err();
        assert!(crate::error::is_read_only(&err));
    }
}
