//! PTY input must be cancellable even when the slave stops reading. On Linux,
//! killing the slave does not reliably interrupt an already-blocked write.

use std::io::{Read, Write};
use std::sync::Arc;

use anyhow::{Context, Result};
use portable_pty::MasterPty;

use super::pipeline::OutputFlow;

type PtyIo = (Box<dyn Read + Send>, Box<dyn Write + Send>);

pub(super) fn open(master: &dyn MasterPty, flow: Arc<OutputFlow>) -> Result<PtyIo> {
    #[cfg(target_os = "linux")]
    let readiness = linux::Readiness::new(master, flow)?;
    #[cfg(not(target_os = "linux"))]
    let _ = flow;

    let reader = master.try_clone_reader().context("clone reader")?;
    let writer = master.take_writer().context("take writer")?;
    #[cfg(target_os = "linux")]
    let (reader, writer): PtyIo = (
        Box::new(linux::CancellableIo::new(reader, readiness.clone())),
        Box::new(linux::CancellableIo::new(writer, readiness)),
    );
    Ok((reader, writer))
}

#[cfg(target_os = "linux")]
mod linux {
    use std::io;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

    use super::*;

    // A blocked reader or writer checks cancellation at least this often.
    // poll sleeps in the kernel while the PTY has no capacity/data.
    const CANCEL_POLL_MS: i32 = 50;

    pub(super) struct Readiness {
        fd: OwnedFd,
        flow: Arc<OutputFlow>,
    }

    impl Readiness {
        pub(super) fn new(master: &dyn MasterPty, flow: Arc<OutputFlow>) -> Result<Arc<Self>> {
            let fd = master.as_raw_fd().context("PTY has no file descriptor")?;
            // SAFETY: the live master owns fd. The duplicate gets independent
            // ownership and stays open until both I/O wrappers have gone away.
            let duplicate = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
            if duplicate < 0 {
                return Err(io::Error::last_os_error()).context("clone PTY readiness handle");
            }
            let fd = unsafe { OwnedFd::from_raw_fd(duplicate) };
            // dup shares file status flags with portable-pty's reader/writer.
            // Keep nonblocking enabled through their drops: the writer's
            // destructor also attempts to write a final newline and EOT.
            let flags = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GETFL) };
            if flags < 0
                || unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) }
                    < 0
            {
                return Err(io::Error::last_os_error()).context("make PTY I/O nonblocking");
            }
            Ok(Arc::new(Self { fd, flow }))
        }

        fn ensure_open(&self) -> io::Result<()> {
            if self.flow.is_closed() {
                Err(io::Error::new(io::ErrorKind::BrokenPipe, "terminal closed"))
            } else {
                Ok(())
            }
        }

        fn wait(&self, events: libc::c_short) -> io::Result<()> {
            loop {
                self.ensure_open()?;
                let mut descriptor = libc::pollfd {
                    fd: self.fd.as_raw_fd(),
                    events,
                    revents: 0,
                };
                // SAFETY: descriptor is initialized, writable, and owns no
                // handle; self.fd remains alive for the entire blocking poll.
                let result = unsafe { libc::poll(&mut descriptor, 1, CANCEL_POLL_MS) };
                if result < 0 {
                    let error = io::Error::last_os_error();
                    if error.kind() == io::ErrorKind::Interrupted {
                        continue;
                    }
                    return Err(error);
                }
                self.ensure_open()?;
                // Drain trailing output on hangup, then let portable-pty turn
                // Linux's EIO into normal EOF on the final read.
                if events == libc::POLLIN
                    && descriptor.revents & (libc::POLLIN | libc::POLLHUP) != 0
                {
                    return Ok(());
                }
                if descriptor.revents & (libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) != 0 {
                    return Err(io::Error::new(io::ErrorKind::BrokenPipe, "PTY closed"));
                }
                if descriptor.revents & events != 0 {
                    return Ok(());
                }
            }
        }
    }

    pub(super) struct CancellableIo<T> {
        inner: T,
        readiness: Arc<Readiness>,
    }

    impl<T> CancellableIo<T> {
        pub(super) fn new(inner: T, readiness: Arc<Readiness>) -> Self {
            Self { inner, readiness }
        }
    }

    impl<T: Read> Read for CancellableIo<T> {
        fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
            loop {
                self.readiness.ensure_open()?;
                match self.inner.read(bytes) {
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        self.readiness.wait(libc::POLLIN)?;
                    }
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    result => return result,
                }
            }
        }
    }

    impl<T: Write> Write for CancellableIo<T> {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            loop {
                self.readiness.ensure_open()?;
                match self.inner.write(bytes) {
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        self.readiness.wait(libc::POLLOUT)?;
                    }
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    result => return result,
                }
            }
        }

        fn flush(&mut self) -> io::Result<()> {
            self.readiness.ensure_open()?;
            self.inner.flush()
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use std::sync::mpsc;
    use std::time::Duration;

    use portable_pty::{native_pty_system, CommandBuilder, PtySize};

    use super::*;

    #[test]
    fn delayed_pty_input_and_output_are_lossless() {
        let pair = native_pty_system().openpty(PtySize::default()).unwrap();
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", "stty raw -echo; printf ready; sleep 0.1; exec cat"]);
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let flow = Arc::new(OutputFlow::default());
        let (mut reader, mut writer) = open(pair.master.as_ref(), flow.clone()).unwrap();
        let mut ready = [0; 5];
        reader.read_exact(&mut ready).unwrap();
        assert_eq!(&ready, b"ready");
        let expected: Vec<u8> = (0..512 * 1024).map(|i| (i % 251) as u8).collect();
        let input = expected.clone();
        let (sent_tx, sent_rx) = mpsc::channel();
        let input_worker = std::thread::spawn(move || {
            let result = writer.write_all(&input).and_then(|()| writer.flush());
            let _ = sent_tx.send(result);
        });
        let (received_tx, received_rx) = mpsc::channel();
        let output_worker = std::thread::spawn(move || {
            let mut output = vec![0; 512 * 1024];
            let result = reader.read_exact(&mut output).map(|()| output);
            let _ = received_tx.send(result);
        });
        let received = received_rx.recv_timeout(Duration::from_secs(5));
        let sent = sent_rx.recv_timeout(Duration::from_secs(1));
        flow.close();
        let _ = child.kill();
        let _ = child.wait();
        sent.expect("PTY input must finish").unwrap();
        assert_eq!(received.expect("PTY output must finish").unwrap(), expected);
        input_worker.join().unwrap();
        output_worker.join().unwrap();
    }

    #[test]
    fn closing_flow_releases_an_idle_reader() {
        let pair = native_pty_system().openpty(PtySize::default()).unwrap();
        let flow = Arc::new(OutputFlow::default());
        let (mut reader, _writer) = open(pair.master.as_ref(), flow.clone()).unwrap();
        let (tx, rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let _ = tx.send(reader.read(&mut [0; 1]));
        });
        assert!(rx.recv_timeout(Duration::from_millis(50)).is_err());
        flow.close();
        let error = rx
            .recv_timeout(Duration::from_secs(1))
            .expect("closing the flow must release an idle reader")
            .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::BrokenPipe);
        worker.join().unwrap();
    }

    #[test]
    fn closing_flow_releases_input_while_the_slave_is_alive() {
        let pair = native_pty_system().openpty(PtySize::default()).unwrap();
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", "stty raw -echo; printf ready; exec sleep 30"]);
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let flow = Arc::new(OutputFlow::default());
        let (mut reader, mut writer) = open(pair.master.as_ref(), flow.clone()).unwrap();
        let mut ready = [0; 5];
        reader.read_exact(&mut ready).unwrap();
        assert_eq!(&ready, b"ready");
        let (tx, rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let _ = tx.send(writer.write_all(&vec![b'x'; 1024 * 1024]));
        });
        let was_blocked = rx.recv_timeout(Duration::from_millis(50)).is_err();
        flow.close();
        let result = rx.recv_timeout(Duration::from_secs(1));
        let child_still_alive = child.try_wait().unwrap().is_none();
        let _ = child.kill();
        let _ = child.wait();
        assert!(was_blocked, "the test must exercise backpressure");
        assert!(
            child_still_alive,
            "cancellation must not rely on child exit"
        );
        assert_eq!(
            result
                .expect("closing the flow must release input")
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::BrokenPipe
        );
        worker.join().unwrap();
    }

    #[test]
    fn child_exit_preserves_trailing_output() {
        let pair = native_pty_system().openpty(PtySize::default()).unwrap();
        let flow = Arc::new(OutputFlow::default());
        let (mut reader, _writer) = open(pair.master.as_ref(), flow).unwrap();
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", "printf trailing-output"]);
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        child.wait().unwrap();
        let mut output = String::new();
        reader.read_to_string(&mut output).unwrap();
        assert_eq!(output, "trailing-output");
    }

    #[test]
    fn child_exit_wakes_an_idle_reader_with_eof() {
        let pair = native_pty_system().openpty(PtySize::default()).unwrap();
        let flow = Arc::new(OutputFlow::default());
        let (mut reader, _writer) = open(pair.master.as_ref(), flow).unwrap();
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", "sleep 0.1"]);
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let result = reader.read(&mut [0; 1]);
        child.wait().unwrap();
        assert_eq!(result.unwrap(), 0);
    }
}
