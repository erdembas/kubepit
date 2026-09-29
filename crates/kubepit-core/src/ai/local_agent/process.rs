use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::super::local_discovery::ResolvedExecutable;
use super::super::provider::{
    answer_cap, AiTimeouts, ProviderError, ProviderErrorKind, MAX_RESPONSE_BYTES,
};
use super::super::sse::LineSplitter;
use super::{protocol, timeout};

/// Private, fresh cwd, never a user's project or kubeconfig directory.
pub(super) struct Scratch(PathBuf);

impl Scratch {
    pub(super) fn new() -> Result<Self, ProviderError> {
        let path = std::env::temp_dir().join(format!("kubepit-agent-{}", uuid::Uuid::new_v4()));
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&path).map_err(|_| {
            ProviderError::new(
                ProviderErrorKind::Network,
                "could not create a private local agent directory",
            )
        })?;
        // Resolve /var -> /private/var on macOS for protocols requiring a
        // canonical cwd. A failed canonicalization still cleans up the dir.
        let mut scratch = Self(path);
        scratch.0 = scratch
            .0
            .canonicalize()
            .map_err(|_| protocol("could not resolve the local agent directory"))?;
        Ok(scratch)
    }

    pub(super) fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub(super) fn controlled_command(executable: &ResolvedExecutable, cwd: &Path) -> Command {
    let mut command = Command::new(&executable.path);
    command.env_clear();
    // Base process envelope excludes KUBECONFIG, runtime hooks and parent agent
    // session IDs. The model-config projector separately adds explicit native
    // provider credentials and endpoint values, without executable integrations.
    for name in [
        "HOME",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "SystemRoot",
        "WINDIR",
        "USER",
        "LOGNAME",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "PATH",
        "CODEX_HOME",
        "CLAUDE_CONFIG_DIR",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "NODE_EXTRA_CA_CERTS",
    ] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    if let Some(path) = &executable.command_path {
        command.env("PATH", path);
    }
    command
        .current_dir(cwd)
        .env("PWD", cwd)
        .env("TMPDIR", cwd)
        .env("TMP", cwd)
        .env("TEMP", cwd)
        .env("KUBECONFIG", cwd.join("no-cluster-access"))
        .env("NO_COLOR", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    command
}

enum Packet {
    Message(Value),
    Error(ProviderError),
    Eof,
}

pub(super) struct Process {
    child: Child,
    stdin: Option<ChildStdin>,
    receiver: mpsc::Receiver<Packet>,
    tasks: Vec<JoinHandle<()>>,
    timeouts: AiTimeouts,
    start: Instant,
    last_event: Instant,
    content_started: bool,
    output_cap: Duration,
    #[cfg(unix)]
    group: i32,
}

impl Process {
    pub(super) fn spawn(
        mut command: Command,
        timeouts: AiTimeouts,
        max_tokens: u32,
    ) -> Result<Self, ProviderError> {
        let mut child = command.spawn().map_err(|error| {
            let kind = if error.kind() == std::io::ErrorKind::NotFound {
                ProviderErrorKind::NotFound
            } else {
                ProviderErrorKind::Network
            };
            ProviderError::new(
                kind,
                "could not start the local agent; check its installation and sign-in",
            )
        })?;
        #[cfg(unix)]
        let group = child.id().unwrap_or_default() as i32;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().expect("piped agent stdout");
        let stderr = child.stderr.take().expect("piped agent stderr");
        let (sender, receiver) = mpsc::channel(8);
        let tasks = vec![
            tokio::spawn(read_stdout(stdout, sender.clone())),
            tokio::spawn(drain_stderr(stderr, sender)),
        ];
        let start = Instant::now();
        Ok(Self {
            child,
            stdin,
            receiver,
            tasks,
            timeouts,
            start,
            last_event: start,
            content_started: false,
            output_cap: answer_cap(&timeouts, max_tokens),
            #[cfg(unix)]
            group,
        })
    }

    pub(super) async fn write(
        &mut self,
        bytes: &[u8],
        cancel: &CancellationToken,
    ) -> Result<(), ProviderError> {
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| protocol("the local agent input is closed"))?;
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(ProviderError::cancelled()),
            result = tokio::time::timeout(self.timeouts.connect.min(self.timeouts.total), stdin.write_all(bytes)) => {
                result.map_err(|_| timeout())?.map_err(|_| protocol("could not write to the local agent"))
            }
        }
    }

    pub(super) async fn send(
        &mut self,
        value: Value,
        cancel: &CancellationToken,
    ) -> Result<(), ProviderError> {
        let mut bytes = serde_json::to_vec(&value)
            .map_err(|_| protocol("could not encode the local agent request"))?;
        bytes.push(b'\n');
        self.write(&bytes, cancel).await
    }

    pub(super) fn close_input(&mut self) {
        self.stdin.take();
    }

    pub(super) fn content_started(&mut self) {
        self.content_started = true;
    }

    pub(super) async fn next(
        &mut self,
        cancel: &CancellationToken,
    ) -> Result<Option<Value>, ProviderError> {
        let absolute = self.start
            + if self.content_started {
                self.output_cap
            } else {
                self.timeouts.total.min(self.timeouts.first_event)
            };
        let idle = self.last_event + self.timeouts.idle;
        let deadline = absolute.min(idle);
        let packet = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(ProviderError::cancelled()),
            _ = tokio::time::sleep_until(deadline.into()) => return Err(timeout()),
            packet = self.receiver.recv() => packet,
        };
        match packet {
            Some(Packet::Message(value)) => {
                self.last_event = Instant::now();
                Ok(Some(value))
            }
            Some(Packet::Error(error)) => Err(error),
            Some(Packet::Eof) | None => Ok(None),
        }
    }

    pub(super) async fn successful_exit(
        &mut self,
        cancel: &CancellationToken,
    ) -> Result<(), ProviderError> {
        let status = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(ProviderError::cancelled()),
            status = tokio::time::timeout(self.timeouts.connect, self.child.wait()) => {
                status.map_err(|_| timeout())?.map_err(|_| protocol("could not wait for the local agent"))?
            }
        };
        if status.success() {
            Ok(())
        } else {
            Err(ProviderError::new(ProviderErrorKind::Auth,
                "the local agent exited unsuccessfully; check its CLI sign-in, model access and version"))
        }
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        // The process is its own group, so npm/shell launcher children cannot
        // survive cancellation or an abandoned future. Never target our group.
        #[cfg(unix)]
        if self.group > 0 {
            // SAFETY: process_group(0) assigned the freshly spawned child its
            // own positive pgid. kill sends a signal only; no pointers are used.
            unsafe {
                libc::kill(-self.group, libc::SIGKILL);
            }
        }
        let _ = self.child.start_kill();
        for task in &self.tasks {
            task.abort();
        }
    }
}

async fn read_stdout(mut stdout: impl AsyncRead + Unpin, sender: mpsc::Sender<Packet>) {
    let mut bytes = [0_u8; 8192];
    let mut lines = LineSplitter::default();
    let mut total = 0_usize;
    loop {
        let count = match stdout.read(&mut bytes).await {
            Ok(count) => count,
            Err(_) => {
                let _ = sender
                    .send(Packet::Error(protocol(
                        "could not read the local agent output",
                    )))
                    .await;
                return;
            }
        };
        total = total.saturating_add(count);
        if total > MAX_RESPONSE_BYTES {
            let _ = sender
                .send(Packet::Error(protocol(
                    "the local agent stream exceeded the output limit",
                )))
                .await;
            return;
        }
        // EOF terminates a final JSON record even without its optional newline.
        let batch = match lines.push(if count == 0 { b"\n" } else { &bytes[..count] }) {
            Ok(lines) => lines,
            Err(_) => {
                let _ = sender
                    .send(Packet::Error(protocol(
                        "the local agent sent an oversized event",
                    )))
                    .await;
                return;
            }
        };
        for line in batch {
            if line.trim().is_empty() {
                continue;
            }
            let value = match serde_json::from_str::<Value>(&line) {
                Ok(value) if value.is_object() => value,
                _ => {
                    let _ = sender
                        .send(Packet::Error(protocol("the local agent sent invalid JSON")))
                        .await;
                    return;
                }
            };
            if sender.send(Packet::Message(value)).await.is_err() {
                return;
            }
        }
        if count == 0 {
            let _ = sender.send(Packet::Eof).await;
            return;
        }
    }
}

async fn drain_stderr(mut stderr: impl AsyncRead + Unpin, sender: mpsc::Sender<Packet>) {
    // Do not retain or surface stderr: CLI errors can echo prompts, tokens or
    // local file contents. Draining avoids a blocked pipe; the total is bounded.
    let mut bytes = [0_u8; 4096];
    let mut total = 0_usize;
    while let Ok(count) = stderr.read(&mut bytes).await {
        if count == 0 {
            return;
        }
        total = total.saturating_add(count);
        if total > MAX_RESPONSE_BYTES {
            let _ = sender
                .send(Packet::Error(protocol(
                    "the local agent error stream exceeded the output limit",
                )))
                .await;
            return;
        }
    }
}
