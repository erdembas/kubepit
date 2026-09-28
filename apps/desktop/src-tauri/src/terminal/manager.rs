use std::collections::HashMap;
use std::io::Write;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use kubepit_core::terminal::{LaunchProgram, TerminalLaunch};
use parking_lot::Mutex;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::Channel;

use super::pipeline::{spawn_output_pipeline, OutputFlow};
use super::shell::{shell_command_for, shell_for};
use super::TerminalOutput;

/// How long the exit watcher waits for buffered output to reach the webview
/// before reporting `terminal://exit`.
const EXIT_DRAIN_TIMEOUT: Duration = Duration::from_millis(750);

type Cleanup = Box<dyn FnOnce() + Send + 'static>;
/// Terminal id → (stream id, cols, rows) requested before the PTY existed.
type PendingSizes = HashMap<String, (String, u16, u16)>;
/// Called with `(terminal id, exit code)` when a PTY child exits on its own.
pub type ExitHook = Arc<dyn Fn(&str, Option<i32>) + Send + Sync + 'static>;

struct TermInstance {
    /// Pipe writer feeding the PTY master.
    writer: Mutex<Box<dyn Write + Send>>,
    /// PTY master handle. Kept alive so `resize()` has somewhere to call.
    master: Mutex<Box<dyn MasterPty + Send>>,
    /// Kills the PTY child from `destroy` while the exit watcher thread
    /// blocks in `wait()` on the child itself.
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    flow: Arc<OutputFlow>,
    /// Runs once when the terminal goes away (node-shell pod deletion).
    cleanup: Mutex<Option<Cleanup>>,
}

impl TermInstance {
    fn run_cleanup(&self) {
        let cleanup = self.cleanup.lock().take();
        if let Some(cleanup) = cleanup {
            cleanup();
        }
    }
}

#[derive(Clone)]
pub struct TerminalManager {
    terms: Arc<Mutex<HashMap<String, Arc<TermInstance>>>>,
    /// Sizes requested before a terminal existed (node shells spend up to a
    /// minute creating their pod), keyed by id → (stream id, cols, rows).
    pending_sizes: Arc<Mutex<PendingSizes>>,
    on_exit: ExitHook,
}

impl Default for TerminalManager {
    fn default() -> Self {
        Self {
            terms: Arc::new(Mutex::new(HashMap::new())),
            pending_sizes: Arc::new(Mutex::new(HashMap::new())),
            on_exit: Arc::new(|_, _| {}),
        }
    }
}

impl TerminalManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// A manager that reports children exiting on their own through `hook`.
    pub fn with_exit_hook(hook: ExitHook) -> Self {
        Self {
            on_exit: hook,
            ..Self::default()
        }
    }

    /// Report an exit for a terminal that never got a PTY (setup failed).
    pub fn notify_exit(&self, id: &str, code: Option<i32>) {
        (self.on_exit)(id, code);
    }

    /// Start `launch` in a fresh PTY registered as `id`. An existing PTY
    /// with the same id is destroyed first. If spawning fails, the launch's
    /// cleanup hook still runs.
    pub fn create(
        &self,
        id: &str,
        stream_id: &str,
        cols: u16,
        rows: u16,
        on_output: Channel<TerminalOutput>,
        mut launch: TerminalLaunch,
    ) -> Result<()> {
        let cleanup = launch.cleanup.take();
        match self.spawn(id, stream_id, cols, rows, on_output, launch, cleanup) {
            Ok(()) => Ok(()),
            Err((err, cleanup)) => {
                if let Some(cleanup) = cleanup {
                    cleanup();
                }
                Err(err)
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn spawn(
        &self,
        id: &str,
        stream_id: &str,
        cols: u16,
        rows: u16,
        on_output: Channel<TerminalOutput>,
        launch: TerminalLaunch,
        cleanup: Option<Cleanup>,
    ) -> std::result::Result<(), (anyhow::Error, Option<Cleanup>)> {
        if let Err(e) = self.destroy(id) {
            return Err((e, cleanup));
        }
        let (cols, rows) = match self.pending_sizes.lock().remove(id) {
            Some((stream, c, r)) if stream == stream_id => (c, r),
            _ => (cols, rows),
        };

        let pty_system = native_pty_system();
        let pair = match pty_system
            .openpty(PtySize {
                rows: rows.max(1),
                cols: cols.max(2),
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("failed to open PTY")
        {
            Ok(pair) => pair,
            Err(e) => return Err((e, cleanup)),
        };

        let (program, args) = match launch.program {
            LaunchProgram::LoginShell { override_path } => shell_for(override_path.as_deref()),
            LaunchProgram::Exec { program, args } => (program, args),
            LaunchProgram::LoginShellCommand {
                override_path,
                script,
            } => shell_command_for(override_path.as_deref(), &script),
        };
        let mut cmd = CommandBuilder::new(&program);
        for arg in args {
            cmd.arg(arg);
        }
        cmd.cwd(&launch.cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        for (key, value) in &launch.env {
            cmd.env(key, value);
        }

        let mut child = match pair.slave.spawn_command(cmd) {
            Ok(child) => child,
            Err(e) => {
                return Err((
                    e.context(format!("failed to start {}", program.display())),
                    cleanup,
                ))
            }
        };
        // The child holds its own handle; ours would keep the PTY open (and
        // EOF from arriving) after the child exits.
        drop(pair.slave);

        let io = pair
            .master
            .try_clone_reader()
            .context("clone reader")
            .and_then(|r| {
                pair.master
                    .take_writer()
                    .context("take writer")
                    .map(|w| (r, w))
            });
        let (reader, writer) = match io {
            Ok(io) => io,
            Err(e) => {
                let _ = child.kill();
                return Err((e, cleanup));
            }
        };

        let flow = Arc::new(OutputFlow::new(stream_id.to_owned()));
        let term = Arc::new(TermInstance {
            writer: Mutex::new(writer),
            master: Mutex::new(pair.master),
            killer: Mutex::new(child.clone_killer()),
            flow: flow.clone(),
            cleanup: Mutex::new(cleanup),
        });
        self.terms.lock().insert(id.to_string(), term.clone());

        let drained = spawn_output_pipeline(reader, on_output, flow);

        // Exit watcher: owns the child, reaps it, and reports exits that were
        // not caused by `destroy` (which unregisters the instance first).
        let manager = self.clone();
        let id = id.to_string();
        std::thread::spawn(move || {
            let code = child.wait().ok().map(|status| status.exit_code() as i32);
            let _ = drained.recv_timeout(EXIT_DRAIN_TIMEOUT);
            let still_registered = {
                let mut terms = manager.terms.lock();
                match terms.get(&id) {
                    Some(current) if Arc::ptr_eq(current, &term) => terms.remove(&id),
                    _ => None,
                }
            };
            if let Some(term) = still_registered {
                term.flow.close();
                term.run_cleanup();
                (manager.on_exit)(&id, code);
            }
        });
        Ok(())
    }

    fn get(&self, id: &str) -> Result<Arc<TermInstance>> {
        self.terms
            .lock()
            .get(id)
            .cloned()
            .context("terminal not found")
    }

    /// Late acknowledgements (after exit, or for setup messages written
    /// before the PTY existed) are harmless and ignored.
    pub fn acknowledge(&self, id: &str, stream_id: &str, bytes: usize) -> Result<()> {
        let term = self.terms.lock().get(id).cloned();
        if let Some(term) = term {
            if term.flow.id == stream_id {
                term.flow.acknowledge(bytes);
            }
        }
        Ok(())
    }

    pub fn write(&self, id: &str, stream_id: &str, data: &[u8]) -> Result<()> {
        let term = self.get(id)?;
        anyhow::ensure!(term.flow.id == stream_id, "terminal session has changed");
        let mut writer = term.writer.lock();
        writer.write_all(data)?;
        writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, id: &str, stream_id: &str, cols: u16, rows: u16) -> Result<()> {
        let term = self.terms.lock().get(id).cloned();
        let Some(term) = term else {
            // Still being prepared (node shell): apply the size at spawn.
            self.pending_sizes
                .lock()
                .insert(id.to_string(), (stream_id.to_string(), cols, rows));
            return Ok(());
        };
        anyhow::ensure!(term.flow.id == stream_id, "terminal session has changed");
        term.master
            .lock()
            .resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(2),
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("resize failed")?;
        Ok(())
    }

    /// Tear down the PTY for `id`. Idempotent for React StrictMode dev paths.
    pub fn destroy(&self, id: &str) -> Result<()> {
        self.pending_sizes.lock().remove(id);
        // Drop the registry lock before touching OS handles. In particular,
        // never wait for a blocked writer to flush before killing its shell.
        let removed = self.terms.lock().remove(id);
        if let Some(term) = removed {
            term.flow.close();
            // A foreground TUI may keep the slave open and leave writes blocked
            // even after its parent shell exits. Terminate its PTY process group.
            #[cfg(unix)]
            if let Some(group) = term.master.lock().process_group_leader() {
                if group > 0 {
                    // SAFETY: the positive group id came from this PTY; a
                    // negative pid targets only that managed process group.
                    unsafe {
                        libc::kill(-group, libc::SIGKILL);
                    }
                }
            }
            // The exit watcher thread reaps the child; shutdown never waits.
            let _ = term.killer.lock().kill();
            term.run_cleanup();
        }
        Ok(())
    }

    /// Destroy every terminal (app exit).
    pub fn destroy_all(&self) {
        let ids: Vec<String> = self.terms.lock().keys().cloned().collect();
        for id in ids {
            let _ = self.destroy(&id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use portable_pty::ChildKiller;
    use std::io;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;

    #[derive(Debug, Clone)]
    struct TestKiller;

    impl ChildKiller for TestKiller {
        fn kill(&mut self) -> io::Result<()> {
            Ok(())
        }
        fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
            Box::new(self.clone())
        }
    }

    struct TestMaster;

    impl MasterPty for TestMaster {
        fn resize(&self, _: PtySize) -> Result<()> {
            Ok(())
        }
        fn get_size(&self) -> Result<PtySize> {
            Ok(PtySize::default())
        }
        fn try_clone_reader(&self) -> Result<Box<dyn io::Read + Send>> {
            Ok(Box::new(io::empty()))
        }
        fn take_writer(&self) -> Result<Box<dyn Write + Send>> {
            Ok(Box::new(io::sink()))
        }
        #[cfg(unix)]
        fn process_group_leader(&self) -> Option<i32> {
            None
        }
        #[cfg(unix)]
        fn as_raw_fd(&self) -> Option<std::os::fd::RawFd> {
            None
        }
    }

    fn instance() -> Arc<TermInstance> {
        Arc::new(TermInstance {
            writer: Mutex::new(Box::new(io::sink())),
            master: Mutex::new(Box::new(TestMaster)),
            killer: Mutex::new(Box::new(TestKiller)),
            flow: Arc::new(OutputFlow::default()),
            cleanup: Mutex::new(None),
        })
    }

    fn exec(program: &str, args: &[&str]) -> TerminalLaunch {
        TerminalLaunch {
            program: LaunchProgram::Exec {
                program: program.into(),
                args: args.iter().map(|a| a.to_string()).collect(),
            },
            env: vec![("KUBEPIT_TEST".into(), "yes".into())],
            cwd: std::env::temp_dir(),
            cleanup: None,
        }
    }

    fn capture_channel() -> (Channel<TerminalOutput>, mpsc::Receiver<String>) {
        let (tx, rx) = mpsc::channel();
        let channel = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(data) = body {
                let _ = tx.send(data);
            }
            Ok(())
        });
        (channel, rx)
    }

    fn decode(json: &str) -> String {
        use base64::Engine;
        let payload: serde_json::Value = serde_json::from_str(json).unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(payload["data"].as_str().unwrap())
            .unwrap();
        String::from_utf8(bytes).unwrap()
    }

    #[cfg(unix)]
    #[test]
    fn custom_tool_arguments_are_passed_literally_to_the_pty() {
        let manager = TerminalManager::new();
        let (channel, rx) = capture_channel();
        manager
            .create(
                "tool-test",
                "generation",
                120,
                24,
                channel,
                // The child stays alive briefly: on macOS a PTY whose slave closes
                // before the first master read can drop the pending output.
                exec(
                    "/bin/sh",
                    &[
                        "-c",
                        "printf '%s %s\\n' \"$0\" \"$1\"; sleep 0.3",
                        "$(literal)",
                        "a value with spaces",
                    ],
                ),
            )
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut text = String::new();
        while !text.contains("$(literal) a value with spaces") {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            let data = rx.recv_timeout(remaining).expect("tool output");
            text.push_str(&decode(&data));
        }
        manager.destroy("tool-test").unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn launch_environment_reaches_the_child() {
        let manager = TerminalManager::new();
        let (channel, rx) = capture_channel();
        manager
            .create(
                "env-test",
                "g",
                80,
                24,
                channel,
                exec("/bin/sh", &["-c", "printf \"$KUBEPIT_TEST\"; sleep 0.3"]),
            )
            .unwrap();
        let data = rx.recv_timeout(Duration::from_secs(3)).expect("output");
        assert!(decode(&data).contains("yes"));
        manager.destroy("env-test").unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn exit_is_reported_and_cleanup_runs_when_the_child_ends() {
        let (exit_tx, exit_rx) = mpsc::channel();
        let manager = TerminalManager::with_exit_hook(Arc::new(move |id, code| {
            let _ = exit_tx.send((id.to_string(), code));
        }));
        let cleaned = Arc::new(AtomicUsize::new(0));
        let counter = cleaned.clone();
        let mut launch = exec("/bin/sh", &["-c", "printf bye; sleep 0.3; exit 3"]);
        launch.cleanup = Some(Box::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        }));
        let (channel, rx) = capture_channel();
        manager
            .create("exits", "g", 80, 24, channel, launch)
            .unwrap();
        let (id, code) = exit_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("exit event");
        assert_eq!(id, "exits");
        assert_eq!(code, Some(3));
        assert_eq!(cleaned.load(Ordering::SeqCst), 1);
        // Output was delivered before the exit was reported.
        assert!(decode(&rx.try_recv().expect("output before exit")).contains("bye"));
        assert!(
            manager.get("exits").is_err(),
            "exited terminals are unregistered"
        );
        // Destroying afterwards is a no-op and does not rerun cleanup.
        manager.destroy("exits").unwrap();
        assert_eq!(cleaned.load(Ordering::SeqCst), 1);
    }

    #[cfg(unix)]
    #[test]
    fn destroy_runs_cleanup_once_and_reports_no_exit() {
        let (exit_tx, exit_rx) = mpsc::channel::<(String, Option<i32>)>();
        let manager = TerminalManager::with_exit_hook(Arc::new(move |id, code| {
            let _ = exit_tx.send((id.to_string(), code));
        }));
        let cleaned = Arc::new(AtomicUsize::new(0));
        let counter = cleaned.clone();
        let mut launch = exec("/bin/sh", &["-c", "sleep 30"]);
        launch.cleanup = Some(Box::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        }));
        let (channel, _rx) = capture_channel();
        manager
            .create("long", "g", 80, 24, channel, launch)
            .unwrap();
        manager.destroy("long").unwrap();
        manager.destroy("long").unwrap();
        assert_eq!(cleaned.load(Ordering::SeqCst), 1);
        assert!(exit_rx.recv_timeout(Duration::from_millis(1500)).is_err());
    }

    #[test]
    fn failed_spawn_still_runs_cleanup() {
        let manager = TerminalManager::new();
        let cleaned = Arc::new(AtomicUsize::new(0));
        let counter = cleaned.clone();
        let mut launch = exec("/definitely/not/a/program", &[]);
        launch.cleanup = Some(Box::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        }));
        let (channel, _rx) = capture_channel();
        // portable-pty may report a missing program either at spawn time or
        // as an immediate exit; the cleanup must run exactly once either way.
        let result = manager.create("bad", "g", 80, 24, channel, launch);
        if result.is_ok() {
            for _ in 0..50 {
                if cleaned.load(Ordering::SeqCst) == 1 {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        assert_eq!(cleaned.load(Ordering::SeqCst), 1);
    }

    #[cfg(unix)]
    #[test]
    fn destroying_a_real_pty_releases_blocked_input() {
        use std::io::Read;
        let manager = TerminalManager::new();
        let pair = native_pty_system().openpty(PtySize::default()).unwrap();
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", "stty raw -echo; printf ready; exec sleep 30"]);
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut ready = [0; 5];
        reader.read_exact(&mut ready).unwrap();
        assert_eq!(&ready, b"ready");
        let writer = pair.master.take_writer().unwrap();
        let flow = Arc::new(OutputFlow::default());
        let stream_id = flow.id.clone();
        let killer = child.clone_killer();
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        manager.terms.lock().insert(
            "blocked".into(),
            Arc::new(TermInstance {
                writer: Mutex::new(writer),
                master: Mutex::new(pair.master),
                killer: Mutex::new(killer),
                flow,
                cleanup: Mutex::new(None),
            }),
        );
        let worker_manager = manager.clone();
        let (tx, rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let result = worker_manager.write("blocked", &stream_id, &vec![b'x'; 1024 * 1024]);
            tx.send(result).unwrap();
        });
        // A non-reading slave in raw mode must eventually fill the PTY.
        let was_blocked = rx.recv_timeout(Duration::from_millis(50)).is_err();
        manager.destroy("blocked").unwrap();
        assert!(was_blocked, "the test must exercise a blocked write");
        rx.recv_timeout(Duration::from_secs(2))
            .expect("closing the PTY must release its writer")
            .ok();
        worker.join().unwrap();
    }

    #[test]
    fn stale_input_and_resize_cannot_target_a_replacement_session() {
        let manager = TerminalManager::new();
        manager.terms.lock().insert("a".into(), instance());
        assert!(manager.write("a", "old-session", b"stale input").is_err());
        assert!(manager.resize("a", "old-session", 80, 24).is_err());
    }

    #[test]
    fn resize_before_spawn_is_remembered_and_acks_are_tolerant() {
        let manager = TerminalManager::new();
        manager.resize("pending", "s1", 132, 50).unwrap();
        assert_eq!(
            manager.pending_sizes.lock().get("pending").cloned(),
            Some(("s1".to_string(), 132, 50))
        );
        manager.acknowledge("pending", "s1", 10).unwrap();
        manager.destroy("pending").unwrap();
        assert!(manager.pending_sizes.lock().is_empty());
    }

    #[test]
    fn blocked_input_does_not_block_resize_other_terminals_or_destroy() {
        let manager = TerminalManager::new();
        let a = instance();
        manager.terms.lock().insert("a".into(), a.clone());
        manager.terms.lock().insert("b".into(), instance());
        let blocked_writer = a.writer.lock();
        let worker_manager = manager.clone();
        let (tx, rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            worker_manager
                .resize("a", &worker_manager.get("a").unwrap().flow.id, 120, 40)
                .unwrap();
            worker_manager
                .write("b", &worker_manager.get("b").unwrap().flow.id, b"hello")
                .unwrap();
            worker_manager.destroy("a").unwrap();
            tx.send(()).unwrap();
        });
        let result = rx.recv_timeout(Duration::from_secs(1));
        drop(blocked_writer);
        worker.join().unwrap();
        result.expect("unrelated work must finish while the first writer is locked");
        assert!(manager.get("a").is_err());
        assert!(manager.get("b").is_ok());
    }
}
