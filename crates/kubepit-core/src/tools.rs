//! External tools: locating `kubectl` / `helm` and running them safely.
//!
//! Binaries are resolved from the settings override first, then `$PATH`
//! (which startup extended with the login-shell PATH, see
//! [`crate::shell_env`]). Every invocation has a timeout and
//! `kill_on_drop`, so a hung `helm` can never wedge an IPC call forever.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};

use crate::paths::expand_tilde;
use crate::types::ToolInfo;

/// Timeout for `--version` style probes.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// `macos` | `linux` | `windows`, as the UI expects.
pub fn os_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(windows) {
        "windows"
    } else {
        "linux"
    }
}

/// Resolve `name` through an optional override path, then `$PATH`.
pub fn find_executable(name: &str, override_path: Option<&str>) -> Option<PathBuf> {
    if let Some(raw) = override_path.map(str::trim).filter(|s| !s.is_empty()) {
        let path = expand_tilde(raw);
        if path.is_file() {
            return Some(path);
        }
        // A bare name in the override ("kubectl-1.30") is looked up on PATH.
        if !raw.contains(['/', '\\']) {
            return search_path(raw);
        }
        return None;
    }
    search_path(name)
}

fn search_path(name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    let candidates: Vec<String> = if cfg!(windows) && Path::new(name).extension().is_none() {
        vec![
            format!("{name}.exe"),
            format!("{name}.cmd"),
            name.to_string(),
        ]
    } else {
        vec![name.to_string()]
    };
    std::env::split_paths(&path_var)
        .filter(|dir| !dir.as_os_str().is_empty())
        .flat_map(|dir| candidates.iter().map(move |c| dir.join(c)))
        .find(|p| is_executable(p))
}

fn is_executable(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Captured result of a finished subprocess.
#[derive(Debug)]
pub struct CommandOutput {
    pub success: bool,
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// Run `program args…` with a timeout. The child is killed if the timeout
/// fires or the calling future is dropped.
pub async fn run(program: &Path, args: &[String], timeout: Duration) -> Result<CommandOutput> {
    run_with_stdin(program, args, None, timeout).await
}

/// [`run`], optionally feeding `stdin` to the child (then closing it).
/// Secrets such as `helm repo add --password-stdin` travel this way so they
/// never appear in the process list, logs or error messages.
pub async fn run_with_stdin(
    program: &Path,
    args: &[String],
    stdin: Option<&[u8]>,
    timeout: Duration,
) -> Result<CommandOutput> {
    use tokio::io::AsyncWriteExt as _;

    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args)
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        // Headless helper: never flash a console window.
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd
        .spawn()
        .with_context(|| format!("failed to start {}", program.display()))?;
    let input = child.stdin.take();
    let finished = async move {
        if let (Some(bytes), Some(mut pipe)) = (stdin, input) {
            // A child that exits without reading stdin closes the pipe; its
            // exit status tells the real story, so a broken pipe is ignored.
            let _ = pipe.write_all(bytes).await;
            drop(pipe);
        }
        child.wait_with_output().await
    };
    let output = tokio::time::timeout(timeout, finished)
        .await
        .map_err(|_| {
            anyhow!(
                "{} did not finish within {}s",
                program.display(),
                timeout.as_secs()
            )
        })??;
    Ok(CommandOutput {
        success: output.status.success(),
        code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

/// `kubectl` path + client version (`kubectl version --client -o json`).
pub async fn kubectl_info(override_path: Option<&str>) -> ToolInfo {
    let Some(path) = find_executable("kubectl", override_path) else {
        return ToolInfo::default();
    };
    let args = ["version", "--client", "-o", "json"].map(String::from);
    let version = match run(&path, &args, PROBE_TIMEOUT).await {
        Ok(out) if out.success => parse_kubectl_version(&out.stdout),
        _ => None,
    };
    ToolInfo {
        path: Some(path.to_string_lossy().to_string()),
        version,
    }
}

/// `helm` path + version (`helm version --short`).
pub async fn helm_info(override_path: Option<&str>) -> ToolInfo {
    let Some(path) = find_executable("helm", override_path) else {
        return ToolInfo::default();
    };
    let args = ["version", "--short"].map(String::from);
    let version = match run(&path, &args, PROBE_TIMEOUT).await {
        Ok(out) if out.success => parse_helm_version(&out.stdout),
        _ => None,
    };
    ToolInfo {
        path: Some(path.to_string_lossy().to_string()),
        version,
    }
}

/// Extract `clientVersion.gitVersion` from `kubectl version -o json`.
pub fn parse_kubectl_version(stdout: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(stdout).ok()?;
    value
        .pointer("/clientVersion/gitVersion")
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

/// `v3.14.2+g4dcd0ab` → `v3.14.2+g4dcd0ab` (first non-empty line, trimmed).
pub fn parse_helm_version(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(str::to_string)
}

/// kubectl for terminals, with a friendly error when missing.
pub fn require_kubectl(override_path: Option<&str>) -> Result<PathBuf> {
    find_executable("kubectl", override_path).ok_or_else(|| {
        anyhow!(
            "kubectl was not found on PATH. Install kubectl or set its location in Settings → Tools."
        )
    })
}

/// helm for release mutations, with a friendly error when missing.
pub fn require_helm(override_path: Option<&str>) -> Result<PathBuf> {
    find_executable("helm", override_path).ok_or_else(|| {
        anyhow!("helm was not found on PATH. Install helm or set its location in Settings → Tools.")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kubectl_version_json() {
        let out = r#"{
  "clientVersion": {"major": "1", "minor": "31", "gitVersion": "v1.31.1", "platform": "darwin/arm64"},
  "kustomizeVersion": "v5.4.2"
}"#;
        assert_eq!(parse_kubectl_version(out).as_deref(), Some("v1.31.1"));
        assert_eq!(parse_kubectl_version("garbage"), None);
    }

    #[test]
    fn helm_version_short() {
        assert_eq!(
            parse_helm_version("\nv3.14.2+g4dcd0ab\n").as_deref(),
            Some("v3.14.2+g4dcd0ab")
        );
        assert_eq!(parse_helm_version("  \n"), None);
    }

    #[cfg(unix)]
    #[test]
    fn override_path_must_exist() {
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("kubectl");
        std::fs::write(&fake, "#!/bin/sh\n").unwrap();
        assert_eq!(
            find_executable("kubectl", Some(fake.to_str().unwrap())),
            Some(fake.clone())
        );
        assert_eq!(find_executable("kubectl", Some("/no/such/kubectl")), None);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn run_captures_output_and_times_out() {
        let sh = PathBuf::from("/bin/sh");
        let out = run(
            &sh,
            &["-c".into(), "echo hi; echo err >&2; exit 3".into()],
            PROBE_TIMEOUT,
        )
        .await
        .unwrap();
        assert!(!out.success);
        assert_eq!(out.code, Some(3));
        assert_eq!(out.stdout.trim(), "hi");
        assert_eq!(out.stderr.trim(), "err");
        let slow = run(
            &sh,
            &["-c".into(), "sleep 5".into()],
            Duration::from_millis(100),
        )
        .await;
        assert!(slow.unwrap_err().to_string().contains("did not finish"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn run_with_stdin_feeds_the_child() {
        let sh = PathBuf::from("/bin/sh");
        let out = run_with_stdin(
            &sh,
            &["-c".into(), "read line; echo \"got:$line\"".into()],
            Some(b"s3cret\n"),
            PROBE_TIMEOUT,
        )
        .await
        .unwrap();
        assert!(out.success);
        assert_eq!(out.stdout.trim(), "got:s3cret");
        // A child that never reads stdin still finishes normally.
        let out = run_with_stdin(
            &sh,
            &["-c".into(), "exit 0".into()],
            Some(b"x"),
            PROBE_TIMEOUT,
        )
        .await
        .unwrap();
        assert!(out.success);
    }
}
