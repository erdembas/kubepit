//! Background runs: `sh -c <command>` with a timeout and capped output.
//!
//! The child runs in its own process group (Unix) so a timeout kills
//! everything it started (`kubectl … | less`, `sleep` in a loop), not just
//! the shell. Output is captured up to [`OUTPUT_CAP`] bytes per stream; the
//! rest is read and dropped so a chatty command never blocks on a full pipe.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use parking_lot::Mutex;
use tokio::io::{AsyncRead, AsyncReadExt};

/// Bytes kept per stream (stdout, stderr).
pub const OUTPUT_CAP: usize = 256 * 1024;
/// How long pipes may stay open after the shell exited (background jobs).
const DRAIN_GRACE: Duration = Duration::from_millis(500);

/// What a finished (or killed) run produced.
#[derive(Debug, Default)]
pub struct RunOutput {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub truncated: bool,
    pub duration_ms: u64,
}

/// The POSIX shell commands run through.
pub fn posix_shell() -> Result<PathBuf> {
    if cfg!(windows) {
        return crate::tools::find_executable("sh", None).context(
            "custom actions need a POSIX sh on the PATH (for example the one of Git for Windows)",
        );
    }
    Ok(PathBuf::from("/bin/sh"))
}

#[derive(Default)]
struct Capture {
    bytes: Vec<u8>,
    truncated: bool,
}

async fn read_capped(mut reader: impl AsyncRead + Unpin, sink: Arc<Mutex<Capture>>) {
    let mut chunk = [0u8; 8192];
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(n) => {
                let mut capture = sink.lock();
                let room = OUTPUT_CAP.saturating_sub(capture.bytes.len());
                if n > room {
                    capture.truncated = true;
                }
                let keep = n.min(room);
                capture.bytes.extend_from_slice(&chunk[..keep]);
            }
        }
    }
}

#[cfg(unix)]
fn kill_group(pid: Option<u32>) {
    if let Some(pid) = pid {
        // The child leads its own process group (`process_group(0)`).
        let _ = std::process::Command::new("kill")
            .args(["-KILL", &format!("-{pid}")])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

#[cfg(not(unix))]
fn kill_group(_pid: Option<u32>) {}

/// Run `command` through `sh -c` with `env` added to the environment.
pub async fn run_shell(
    command: &str,
    env: &[(String, String)],
    timeout: Duration,
) -> Result<RunOutput> {
    let shell = posix_shell()?;
    let started = Instant::now();
    let mut cmd = tokio::process::Command::new(&shell);
    cmd.arg("-c")
        .arg(command)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for (key, value) in env {
        cmd.env(key, value);
    }
    if let Some(home) = dirs::home_dir() {
        cmd.current_dir(home);
    }
    #[cfg(unix)]
    cmd.process_group(0);
    #[cfg(windows)]
    {
        // Headless helper: never flash a console window.
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd
        .spawn()
        .with_context(|| format!("failed to start {}", shell.display()))?;
    let pid = child.id();
    let stdout = Arc::new(Mutex::new(Capture::default()));
    let stderr = Arc::new(Mutex::new(Capture::default()));
    let readers = [
        child
            .stdout
            .take()
            .map(|pipe| tokio::spawn(read_capped(pipe, stdout.clone()))),
        child
            .stderr
            .take()
            .map(|pipe| tokio::spawn(read_capped(pipe, stderr.clone()))),
    ];

    let (exit_code, timed_out) = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(status) => (
            status.context("waiting for the command failed")?.code(),
            false,
        ),
        Err(_) => {
            kill_group(pid);
            let _ = child.kill().await;
            (None, true)
        }
    };
    // Something the shell started in the background may still hold the pipes.
    for reader in readers.into_iter().flatten() {
        let abort = reader.abort_handle();
        if tokio::time::timeout(DRAIN_GRACE, reader).await.is_err() {
            kill_group(pid);
            abort.abort();
        }
    }
    let take = |capture: &Arc<Mutex<Capture>>| {
        let capture = capture.lock();
        (
            String::from_utf8_lossy(&capture.bytes).to_string(),
            capture.truncated,
        )
    };
    let (stdout, out_truncated) = take(&stdout);
    let (stderr, err_truncated) = take(&stderr);
    Ok(RunOutput {
        exit_code,
        stdout,
        stderr,
        timed_out,
        truncated: out_truncated || err_truncated,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn captures_output_and_exit_code() {
        let env = vec![("KP_TEST".to_string(), "hello".to_string())];
        let out = run_shell(
            "printf '%s' \"$KP_TEST\"; echo oops >&2; exit 3",
            &env,
            Duration::from_secs(10),
        )
        .await
        .unwrap();
        assert_eq!(out.stdout, "hello");
        assert_eq!(out.stderr, "oops\n");
        assert_eq!(out.exit_code, Some(3));
        assert!(!out.timed_out && !out.truncated);
    }

    #[tokio::test]
    async fn timeouts_kill_the_whole_group() {
        let started = Instant::now();
        let out = run_shell(
            "echo started; sleep 30 | cat; echo never",
            &[],
            Duration::from_millis(300),
        )
        .await
        .unwrap();
        assert!(out.timed_out);
        assert_eq!(out.exit_code, None);
        assert_eq!(out.stdout, "started\n");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[tokio::test]
    async fn output_is_capped() {
        let out = run_shell(
            "head -c 600000 /dev/zero | tr '\\0' x",
            &[],
            Duration::from_secs(20),
        )
        .await
        .unwrap();
        assert_eq!(out.stdout.len(), OUTPUT_CAP);
        assert!(out.truncated);
        assert_eq!(out.exit_code, Some(0));
    }

    #[tokio::test]
    async fn background_jobs_do_not_hold_the_run_open() {
        let started = Instant::now();
        let out = run_shell("sleep 30 & echo done", &[], Duration::from_secs(10))
            .await
            .unwrap();
        assert_eq!(out.stdout, "done\n");
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
