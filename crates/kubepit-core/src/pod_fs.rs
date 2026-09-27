//! Container file browser and copy (`kubectl cp`), over exec.
//!
//! Every operation runs one small POSIX `sh -c` script in the container
//! (paths travel as positional arguments, never spliced into the script),
//! written for both GNU coreutils and busybox:
//!
//! - **list** walks the directory with shell globs and builtins only and
//!   prints NUL-separated `kind, name, link target` records, so names with
//!   spaces or newlines survive; one `stat -c '%f %s %Y %n'` call then adds
//!   mode, size and mtime (matched back to the names in order, see
//!   [`parse_listing`]). Without a usable `stat` the entries simply lack
//!   those columns.
//! - **read** prints a `KPFS1 <size>` header and the first `max_bytes`
//!   (`head -c`) for previews.
//! - **download** streams `cat` — or `tar cf -` for a directory, saved as a
//!   `.tar` archive rather than extracted, so nothing from the container is
//!   ever unpacked onto the user's disk — into `<local>.part`, renamed when
//!   the command succeeded.
//! - **upload** streams the local file into `head -c <size>` (which needs
//!   no stdin EOF, so it also works over the v4 exec protocol), then moves
//!   it into place. It is mutating and refused on read-only clusters.
//!
//! A container without `sh` cannot be browsed this way; that error says so
//! and points at ephemeral debug containers.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine as _;
use k8s_openapi::api::core::v1::Pod;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::Status;
use kube::api::{Api, AttachParams, AttachedProcess};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};

use crate::app::Kubepit;
use crate::error::describe_kube_error;
use crate::paths::expand_tilde;
use crate::types::{PodDirListing, PodFileContent, PodFsEntry, PodFsKind, PodFsTransfer};

/// Entries returned per directory (`truncated` beyond that).
pub const LIST_LIMIT: usize = 5_000;
/// Default and maximum preview size.
pub const DEFAULT_PREVIEW_BYTES: u64 = 512 * 1024;
pub const MAX_PREVIEW_BYTES: u64 = 1024 * 1024;
/// Listing output cap (5 000 long names + stat lines fit easily).
const LIST_OUTPUT_LIMIT: usize = 16 * 1024 * 1024;
const STDERR_LIMIT: usize = 64 * 1024;
const PIPE_BUF: usize = 64 * 1024;
const QUICK_TIMEOUT: Duration = Duration::from_secs(60);

/// `sh -c LIST_SCRIPT sh <dir> <limit>`.
pub const LIST_SCRIPT: &str = r#"d=${1:-.}
if [ ! -e "$d" ]; then echo "no such file or directory: $d" >&2; exit 2; fi
if [ ! -d "$d" ]; then echo "not a directory: $d" >&2; exit 3; fi
cd -- "$d" 2>/dev/null || { echo "permission denied: $d" >&2; exit 4; }
printf 'KPFS1\0%s\0' "$(pwd)"
n=0
for f in * .[!.]* ..?*; do
  if [ -L "$f" ]; then
    t=$(readlink -- "$f" 2>/dev/null)
    if [ -d "$f" ]; then k=ld; else k=l; fi
  elif [ -d "$f" ]; then k=d; t=
  elif [ -f "$f" ]; then k=f; t=
  elif [ -e "$f" ]; then k=o; t=
  else continue
  fi
  n=$((n+1))
  if [ "$n" -gt "$2" ]; then printf 'KPFS-MORE\0'; break; fi
  printf '%s\0%s\0%s\0' "$k" "$f" "$t"
done
printf 'KPFS-STAT\0'
stat -c '%f %s %Y %n' -- * .[!.]* ..?* 2>/dev/null
exit 0
"#;

/// `sh -c READ_SCRIPT sh <file> <max bytes>`.
pub const READ_SCRIPT: &str = r#"f=$1
if [ -d "$f" ]; then echo "is a directory: $f" >&2; exit 3; fi
if [ ! -e "$f" ]; then echo "no such file or directory: $f" >&2; exit 2; fi
if [ ! -r "$f" ]; then echo "permission denied: $f" >&2; exit 4; fi
s=$(stat -L -c %s -- "$f" 2>/dev/null)
printf 'KPFS1 %s\n' "$s"
exec head -c "$2" -- "$f"
"#;

/// `sh -c DOWNLOAD_SCRIPT sh <path> <parent> <./name>`.
pub const DOWNLOAD_SCRIPT: &str = r#"p=$1
if [ -d "$p" ]; then
  command -v tar >/dev/null 2>&1 || { echo "tar is not available in this container" >&2; exit 5; }
  cd -- "$2" 2>/dev/null || { echo "permission denied: $2" >&2; exit 4; }
  printf 'KPFS1 dir\n'
  exec tar cf - "$3"
fi
if [ ! -e "$p" ]; then echo "no such file or directory: $p" >&2; exit 2; fi
if [ ! -r "$p" ]; then echo "permission denied: $p" >&2; exit 4; fi
printf 'KPFS1 file\n'
exec cat -- "$p"
"#;

/// `sh -c UPLOAD_SCRIPT sh <dir> <name> <size>`; the file arrives on stdin.
pub const UPLOAD_SCRIPT: &str = r#"d=$1; n=$2; size=$3
if [ ! -d "$d" ]; then echo "not a directory: $d" >&2; exit 3; fi
if [ ! -w "$d" ]; then echo "permission denied: $d" >&2; exit 4; fi
t="$d/.$n.kubepit-part"
if head -c "$size" > "$t" && [ "$(wc -c < "$t" | tr -d ' ')" = "$size" ]; then
  mv -f -- "$t" "$d/$n" && exit 0
fi
rm -f -- "$t"
echo "upload to $d/$n failed" >&2
exit 5
"#;

fn sh(script: &str, args: &[&str]) -> Vec<String> {
    let mut command = vec![
        "sh".to_string(),
        "-c".to_string(),
        script.to_string(),
        "sh".to_string(),
    ];
    command.extend(args.iter().map(|a| a.to_string()));
    command
}

// ---------------------------------------------------------------------------
// Pure parsing
// ---------------------------------------------------------------------------

/// `ls -l` style mode string from a raw `st_mode`.
pub fn mode_string(mode: u32) -> String {
    let kind = match mode & 0o170_000 {
        0o040_000 => 'd',
        0o120_000 => 'l',
        0o020_000 => 'c',
        0o060_000 => 'b',
        0o010_000 => 'p',
        0o140_000 => 's',
        _ => '-',
    };
    let mut out = String::with_capacity(10);
    out.push(kind);
    for (shift, special, set_char) in [(6, 0o4000, 's'), (3, 0o2000, 's'), (0, 0o1000, 't')] {
        let bits = (mode >> shift) & 0o7;
        out.push(if bits & 4 != 0 { 'r' } else { '-' });
        out.push(if bits & 2 != 0 { 'w' } else { '-' });
        let exec = bits & 1 != 0;
        out.push(match (mode & special != 0, exec) {
            (true, true) => set_char,
            (true, false) => set_char.to_ascii_uppercase(),
            (false, true) => 'x',
            (false, false) => '-',
        });
    }
    out
}

struct Fields<'a> {
    rest: &'a [u8],
}

impl<'a> Fields<'a> {
    fn next(&mut self) -> Option<&'a [u8]> {
        let end = self.rest.iter().position(|b| *b == 0)?;
        let field = &self.rest[..end];
        self.rest = &self.rest[end + 1..];
        Some(field)
    }
}

fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StatInfo {
    pub mode: u32,
    pub size: u64,
    pub modified: i64,
}

/// Parse `stat -c '%f %s %Y %n'` output against the names it was run for.
///
/// `%n` is the raw name, so a name containing a newline spans lines; and a
/// name that vanished between the walk and `stat` has no line at all. Each
/// record is therefore matched to the next expected name it is followed by
/// (`<name>\n`), skipping names without a record.
pub fn parse_stat_lines(text: &[u8], names: &[&[u8]]) -> HashMap<usize, StatInfo> {
    let mut out = HashMap::new();
    let mut cursor = 0;
    let mut next_name = 0;
    while cursor < text.len() {
        let Some((info, name_start)) = parse_stat_prefix(&text[cursor..]) else {
            break;
        };
        let rest = &text[cursor + name_start..];
        let matched = (next_name..names.len()).find(|&i| {
            let name = names[i];
            rest.starts_with(name) && matches!(rest.get(name.len()), None | Some(b'\n'))
        });
        match matched {
            Some(i) => {
                out.insert(i, info);
                cursor += name_start + names[i].len() + 1;
                next_name = i + 1;
            }
            None => match rest.iter().position(|b| *b == b'\n') {
                Some(nl) => cursor += name_start + nl + 1,
                None => break,
            },
        }
    }
    out
}

/// `<hex> <size> <mtime> ` → (info, offset of the name).
fn parse_stat_prefix(line: &[u8]) -> Option<(StatInfo, usize)> {
    let mut offset = 0;
    let mut take = |line: &[u8]| -> Option<String> {
        let rest = &line[offset..];
        let end = rest.iter().position(|b| *b == b' ')?;
        let token = std::str::from_utf8(&rest[..end]).ok()?.to_string();
        offset += end + 1;
        Some(token)
    };
    let mode = u32::from_str_radix(&take(line)?, 16).ok()?;
    let size = take(line)?.parse().ok()?;
    let modified = take(line)?.parse().ok()?;
    Some((
        StatInfo {
            mode,
            size,
            modified,
        },
        offset,
    ))
}

/// Parse the output of [`LIST_SCRIPT`].
pub fn parse_listing(output: &[u8]) -> Result<PodDirListing> {
    let mut fields = Fields { rest: output };
    if fields.next() != Some(b"KPFS1".as_slice()) {
        bail!("unexpected directory listing output from the container");
    }
    let path = lossy(fields.next().unwrap_or_default());
    let mut raw: Vec<(PodFsKind, bool, &[u8], &[u8])> = Vec::new();
    let mut truncated = false;
    let mut stat_text: &[u8] = &[];
    while let Some(field) = fields.next() {
        let (kind, link_to_dir) = match field {
            b"KPFS-STAT" => {
                stat_text = fields.rest;
                break;
            }
            b"KPFS-MORE" => {
                truncated = true;
                continue;
            }
            b"d" => (PodFsKind::Dir, false),
            b"f" => (PodFsKind::File, false),
            b"l" => (PodFsKind::Symlink, false),
            b"ld" => (PodFsKind::Symlink, true),
            b"o" => (PodFsKind::Other, false),
            _ => bail!("unexpected directory listing output from the container"),
        };
        let (Some(name), Some(target)) = (fields.next(), fields.next()) else {
            bail!("directory listing output was cut off");
        };
        raw.push((kind, link_to_dir, name, target));
    }
    let names: Vec<&[u8]> = raw.iter().map(|(_, _, name, _)| *name).collect();
    let stats = parse_stat_lines(stat_text, &names);
    let mut entries: Vec<PodFsEntry> = raw
        .iter()
        .enumerate()
        .map(|(i, (kind, link_to_dir, name, target))| {
            let stat = stats.get(&i);
            PodFsEntry {
                name: lossy(name),
                kind: *kind,
                size: stat.map(|s| s.size),
                mode: stat.map(|s| mode_string(s.mode)),
                modified: stat.map(|s| s.modified),
                link_target: (*kind == PodFsKind::Symlink).then(|| lossy(target)),
                link_to_dir: *link_to_dir,
            }
        })
        .collect();
    sort_entries(&mut entries);
    Ok(PodDirListing {
        path,
        entries,
        truncated,
    })
}

/// Directories (and links to them) first, then by name, case-insensitively.
pub fn sort_entries(entries: &mut [PodFsEntry]) {
    entries.sort_by(|a, b| {
        let dir = |e: &PodFsEntry| !(e.kind == PodFsKind::Dir || e.link_to_dir);
        dir(a)
            .cmp(&dir(b))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
}

/// Binary heuristic: a NUL byte early on (like git) or invalid UTF-8. A
/// multi-byte character cut by `truncated` does not count.
pub fn looks_binary(data: &[u8], truncated: bool) -> bool {
    if data[..data.len().min(8_000)].contains(&0) {
        return true;
    }
    match std::str::from_utf8(data) {
        Ok(_) => false,
        Err(e) => !(truncated && e.error_len().is_none()),
    }
}

/// Parse the output of [`READ_SCRIPT`].
pub fn parse_file_content(path: &str, output: &[u8], max_bytes: u64) -> Result<PodFileContent> {
    let Some(newline) = output.iter().position(|b| *b == b'\n') else {
        bail!("unexpected file preview output from the container");
    };
    let header = lossy(&output[..newline]);
    let Some(size_text) = header.strip_prefix("KPFS1") else {
        bail!("unexpected file preview output from the container");
    };
    let size = size_text.trim().parse::<u64>().ok();
    let max = usize::try_from(max_bytes).unwrap_or(usize::MAX);
    let body = &output[newline + 1..];
    let data = &body[..body.len().min(max)];
    let truncated = match size {
        Some(size) => size > data.len() as u64,
        None => data.len() >= max,
    };
    let binary = looks_binary(data, truncated);
    let (text, base64) = if binary {
        (
            None,
            Some(base64::engine::general_purpose::STANDARD.encode(data)),
        )
    } else {
        let valid = match std::str::from_utf8(data) {
            Ok(text) => text,
            // Only a cut multi-byte tail can fail here (see `looks_binary`).
            Err(e) => std::str::from_utf8(&data[..e.valid_up_to()]).unwrap_or_default(),
        };
        (Some(valid.to_string()), None)
    };
    Ok(PodFileContent {
        path: path.to_string(),
        size,
        text,
        base64,
        truncated,
        binary,
    })
}

/// `/var/log/` → (`/var`, `log`); `/` itself is refused (use a folder below it).
pub fn split_remote_path(path: &str) -> Result<(String, String)> {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        bail!("pick a file or a folder below /");
    }
    Ok(match trimmed.rsplit_once('/') {
        Some(("", name)) => ("/".to_string(), name.to_string()),
        Some((parent, name)) => (parent.to_string(), name.to_string()),
        None => (".".to_string(), trimmed.to_string()),
    })
}

/// `dir` + `name` without doubling the slash.
pub fn join_remote(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

/// True for the runtime's "cannot execute sh" failures (no shell in the image).
pub fn is_missing_shell(message: &str) -> bool {
    let m = message.to_ascii_lowercase();
    m.contains("executable file not found")
        || m.contains("not found in $path")
        || (m.contains("exec") && m.contains("no such file or directory"))
}

/// The failure described by an exec's final status, preferring the
/// script's own stderr. `None` when the command succeeded.
pub fn exec_failure(status: Option<&Status>, stderr: &str, container: &str) -> Option<String> {
    let status = status?;
    if status.status.as_deref() != Some("Failure") {
        return None;
    }
    let message = status.message.as_deref().unwrap_or_default();
    let stderr = stderr.trim();
    if stderr.is_empty() && is_missing_shell(message) {
        return Some(format!(
            "container \"{container}\" has no shell (sh), so its files cannot be browsed; start a debug container to inspect it"
        ));
    }
    if !stderr.is_empty() {
        let last = stderr.lines().rev().find(|l| !l.trim().is_empty());
        return Some(last.unwrap_or(stderr).trim().to_string());
    }
    if message.is_empty() {
        let reason = status.reason.as_deref().unwrap_or("unknown reason");
        Some(format!("command failed ({reason})"))
    } else {
        Some(message.to_string())
    }
}

// ---------------------------------------------------------------------------
// Exec plumbing
// ---------------------------------------------------------------------------

fn attach_params(container: Option<&str>, stdin: bool, stdout: bool) -> AttachParams {
    let mut params = AttachParams::default()
        .stdin(stdin)
        .stdout(stdout)
        .stderr(true);
    if let Some(c) = container.filter(|c| !c.is_empty()) {
        params = params.container(c);
    }
    params.max_stdin_buf_size = Some(PIPE_BUF);
    params.max_stdout_buf_size = Some(PIPE_BUF);
    params.max_stderr_buf_size = Some(PIPE_BUF);
    params
}

async fn start_exec(
    api: &Api<Pod>,
    pod: &str,
    command: Vec<String>,
    params: &AttachParams,
) -> Result<AttachedProcess> {
    api.exec(pod, command, params)
        .await
        .map_err(|e| anyhow!("cannot exec into {pod}: {}", describe_kube_error(&e)))
}

/// Read to EOF, keeping at most `limit` bytes (`true` when more came).
async fn read_capped(reader: Option<impl AsyncRead + Unpin>, limit: usize) -> (Vec<u8>, bool) {
    let Some(mut reader) = reader else {
        return (Vec::new(), false);
    };
    let mut out = Vec::new();
    let mut buf = vec![0u8; 16 * 1024];
    loop {
        match reader.read(&mut buf).await {
            Ok(0) | Err(_) => return (out, false),
            Ok(n) => {
                if out.len() + n > limit {
                    out.extend_from_slice(&buf[..limit - out.len()]);
                    return (out, true);
                }
                out.extend_from_slice(&buf[..n]);
            }
        }
    }
}

struct Captured {
    stdout: Vec<u8>,
    stderr: String,
    status: Option<Status>,
}

/// Run a command to completion and capture its (bounded) output.
async fn exec_capture(
    api: &Api<Pod>,
    pod: &str,
    container: Option<&str>,
    command: Vec<String>,
    stdout_limit: usize,
) -> Result<Captured> {
    let run = async {
        let mut process =
            start_exec(api, pod, command, &attach_params(container, false, true)).await?;
        let status = process.take_status();
        let ((stdout, overflow), (stderr, _)) = tokio::join!(
            read_capped(process.stdout(), stdout_limit),
            read_capped(process.stderr(), STDERR_LIMIT),
        );
        if overflow {
            process.abort();
            bail!("the container sent more output than expected");
        }
        let status = match status {
            Some(status) => status.await,
            None => None,
        };
        Ok(Captured {
            stdout,
            stderr: lossy(&stderr),
            status,
        })
    };
    tokio::time::timeout(QUICK_TIMEOUT, run)
        .await
        .map_err(|_| {
            anyhow!(
                "the container did not answer within {}s",
                QUICK_TIMEOUT.as_secs()
            )
        })?
}

fn container_label(container: Option<&str>) -> String {
    container
        .filter(|c| !c.is_empty())
        .unwrap_or("default")
        .to_string()
}

impl Kubepit {
    async fn pod_api(&self, cluster_id: &str, namespace: &str) -> Result<Api<Pod>> {
        let client = self.client(cluster_id).await?;
        Ok(Api::namespaced(client, namespace))
    }

    /// `pod_fs_list`: one directory. An empty `path` lists the container's
    /// working directory; the result carries the absolute path either way.
    pub async fn pod_fs_list(
        &self,
        cluster_id: &str,
        namespace: &str,
        pod: &str,
        container: Option<&str>,
        path: &str,
    ) -> Result<PodDirListing> {
        let api = self.pod_api(cluster_id, namespace).await?;
        let limit = LIST_LIMIT.to_string();
        let command = sh(LIST_SCRIPT, &[path, &limit]);
        let out = exec_capture(&api, pod, container, command, LIST_OUTPUT_LIMIT).await?;
        if let Some(failure) = exec_failure(
            out.status.as_ref(),
            &out.stderr,
            &container_label(container),
        ) {
            bail!(failure);
        }
        parse_listing(&out.stdout)
    }

    /// `pod_fs_read`: the first `max_bytes` (default 512 KiB, at most 1 MiB)
    /// of a file, as text or base64.
    pub async fn pod_fs_read(
        &self,
        cluster_id: &str,
        namespace: &str,
        pod: &str,
        container: Option<&str>,
        path: &str,
        max_bytes: Option<u64>,
    ) -> Result<PodFileContent> {
        let max = max_bytes
            .unwrap_or(DEFAULT_PREVIEW_BYTES)
            .clamp(1, MAX_PREVIEW_BYTES);
        let api = self.pod_api(cluster_id, namespace).await?;
        let command = sh(READ_SCRIPT, &[path, &max.to_string()]);
        let limit = usize::try_from(max).unwrap_or(usize::MAX) + 128;
        let out = exec_capture(&api, pod, container, command, limit).await?;
        if let Some(failure) = exec_failure(
            out.status.as_ref(),
            &out.stderr,
            &container_label(container),
        ) {
            bail!(failure);
        }
        parse_file_content(path, &out.stdout, max)
    }

    /// `pod_fs_download`: stream a file (or a directory as a tar archive) to
    /// `local_path`. A partial download never replaces an existing file.
    pub async fn pod_fs_download(
        &self,
        cluster_id: &str,
        namespace: &str,
        pod: &str,
        container: Option<&str>,
        remote_path: &str,
        local_path: &str,
    ) -> Result<PodFsTransfer> {
        let (parent, name) = split_remote_path(remote_path)?;
        let local = expand_tilde(local_path.trim());
        if local.as_os_str().is_empty() {
            bail!("no destination file given");
        }
        let part = PathBuf::from(format!("{}.part", local.display()));
        let api = self.pod_api(cluster_id, namespace).await?;
        let command = sh(
            DOWNLOAD_SCRIPT,
            &[remote_path, &parent, &format!("./{name}")],
        );
        let mut process =
            start_exec(&api, pod, command, &attach_params(container, false, true)).await?;
        let status = process.take_status();
        let stderr = tokio::spawn(read_capped(process.stderr(), STDERR_LIMIT));
        let mut stdout = BufReader::new(
            process
                .stdout()
                .ok_or_else(|| anyhow!("exec has no stdout"))?,
        );

        let mut header = Vec::new();
        (&mut stdout)
            .take(64)
            .read_until(b'\n', &mut header)
            .await?;
        let archive = header.starts_with(b"KPFS1 dir");
        let mut bytes = 0;
        let mut copy_error = None;
        if header.starts_with(b"KPFS1 ") {
            let result = async {
                let mut file = tokio::fs::File::create(&part)
                    .await
                    .with_context(|| format!("cannot write {}", part.display()))?;
                let n = tokio::io::copy(&mut stdout, &mut file).await?;
                file.flush().await?;
                Ok::<u64, anyhow::Error>(n)
            }
            .await;
            match result {
                Ok(n) => bytes = n,
                Err(e) => copy_error = Some(e),
            }
        }
        drop(stdout);
        let status = match status {
            Some(status) => status.await,
            None => None,
        };
        let (stderr, _) = stderr.await.unwrap_or_default();
        let failure = exec_failure(
            status.as_ref(),
            &lossy(&stderr),
            &container_label(container),
        );
        let failed = copy_error.is_some() || failure.is_some() || !header.starts_with(b"KPFS1 ");
        if failed {
            let _ = tokio::fs::remove_file(&part).await;
            if let Some(err) = copy_error {
                return Err(err.context("download failed"));
            }
            bail!(failure.unwrap_or_else(|| "download failed: unexpected output".to_string()));
        }
        tokio::fs::rename(&part, &local)
            .await
            .with_context(|| format!("cannot write {}", local.display()))?;
        Ok(PodFsTransfer {
            path: local.to_string_lossy().to_string(),
            bytes,
            archive,
        })
    }

    /// `pod_fs_upload`: copy one local file into `remote_dir` (replacing a
    /// file of the same name). Mutating: refused on read-only clusters.
    pub async fn pod_fs_upload(
        &self,
        cluster_id: &str,
        namespace: &str,
        pod: &str,
        container: Option<&str>,
        local_path: &str,
        remote_dir: &str,
    ) -> Result<PodFsTransfer> {
        self.ensure_writable(cluster_id, "uploading files")?;
        let local = expand_tilde(local_path.trim());
        let meta = tokio::fs::metadata(&local)
            .await
            .with_context(|| format!("cannot read {}", local.display()))?;
        if !meta.is_file() {
            bail!("{} is not a file", local.display());
        }
        let name = local
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .filter(|n| !n.is_empty() && n != "." && n != ".." && !n.contains('/'))
            .ok_or_else(|| anyhow!("{} has no usable file name", local.display()))?;
        let dir = if remote_dir.trim().is_empty() {
            "."
        } else {
            remote_dir
        };
        let size = meta.len();
        let api = self.pod_api(cluster_id, namespace).await?;
        let command = sh(UPLOAD_SCRIPT, &[dir, &name, &size.to_string()]);
        let mut process =
            start_exec(&api, pod, command, &attach_params(container, true, false)).await?;
        let mut stdin = process
            .stdin()
            .ok_or_else(|| anyhow!("exec has no stdin"))?;
        let status = process
            .take_status()
            .ok_or_else(|| anyhow!("exec has no status"))?;
        let stderr = tokio::spawn(read_capped(process.stderr(), STDERR_LIMIT));
        let mut file = tokio::fs::File::open(&local)
            .await
            .with_context(|| format!("cannot read {}", local.display()))?;
        tokio::pin!(status);
        // Keep stdin open until the status arrives: over the v4 protocol,
        // closing it would close the whole connection.
        let status = tokio::select! {
            sent = async {
                tokio::io::copy(&mut file, &mut stdin).await?;
                stdin.flush().await
            } => {
                sent.context("upload failed")?;
                tokio::time::timeout(QUICK_TIMEOUT, &mut status)
                    .await
                    .map_err(|_| anyhow!("the container did not confirm the upload"))?
            }
            status = &mut status => status,
        };
        drop(stdin);
        let (stderr, _) = stderr.await.unwrap_or_default();
        if let Some(failure) = exec_failure(
            status.as_ref(),
            &lossy(&stderr),
            &container_label(container),
        ) {
            bail!(failure);
        }
        Ok(PodFsTransfer {
            path: join_remote(dir, &name),
            bytes: size,
            archive: false,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cluster::tests_support::app_with_cluster;

    fn listing(records: &[(&str, &str, &str)], stat: &str) -> Vec<u8> {
        let mut out = b"KPFS1\0/app\0".to_vec();
        for (kind, name, target) in records {
            for field in [kind, name, target] {
                out.extend_from_slice(field.as_bytes());
                out.push(0);
            }
        }
        out.extend_from_slice(b"KPFS-STAT\0");
        out.extend_from_slice(stat.as_bytes());
        out
    }

    #[test]
    fn gnu_listing_with_odd_names() {
        // GNU coreutils: `stat -c '%f %s %Y %n'` prints raw names.
        let out = listing(
            &[
                ("f", "My Notes.txt", ""),
                ("d", "logs", ""),
                ("f", "line\nbreak", ""),
                ("ld", "current", "releases/v2"),
                ("l", "dangling", "/nowhere"),
                ("o", "app.sock", ""),
            ],
            "81a4 12 1714557600 My Notes.txt\n41ed 4096 1714557000 logs\n81a4 3 1714557601 line\nbreak\na1ff 11 1714550000 current\na1ff 8 1714550001 dangling\nc1ed 0 1714557602 app.sock\n",
        );
        let result = parse_listing(&out).unwrap();
        assert_eq!(result.path, "/app");
        assert!(!result.truncated);
        let names: Vec<&str> = result.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "current",
                "logs",
                "app.sock",
                "dangling",
                "line\nbreak",
                "My Notes.txt"
            ]
        );
        let by = |n: &str| result.entries.iter().find(|e| e.name == n).unwrap();
        assert_eq!(by("logs").kind, PodFsKind::Dir);
        assert_eq!(by("logs").mode.as_deref(), Some("drwxr-xr-x"));
        let notes = by("My Notes.txt");
        assert_eq!(
            (notes.kind, notes.size, notes.modified),
            (PodFsKind::File, Some(12), Some(1_714_557_600))
        );
        assert_eq!(notes.mode.as_deref(), Some("-rw-r--r--"));
        assert_eq!(by("line\nbreak").size, Some(3));
        let current = by("current");
        assert_eq!(current.kind, PodFsKind::Symlink);
        assert!(current.link_to_dir);
        assert_eq!(current.link_target.as_deref(), Some("releases/v2"));
        assert_eq!(current.mode.as_deref(), Some("lrwxrwxrwx"));
        assert!(!by("dangling").link_to_dir);
        assert_eq!(by("app.sock").kind, PodFsKind::Other);
        assert_eq!(by("app.sock").mode.as_deref(), Some("srwxr-xr-x"));
        assert_eq!(by("logs").link_target, None);
    }

    #[test]
    fn busybox_listing_with_missing_stat_records() {
        // busybox: same format; a file vanished between the walk and stat,
        // and an unmatched glob literal produced no record either.
        let out = listing(
            &[("f", ".profile", ""), ("f", "gone", ""), ("d", "etc", "")],
            "81a4 20 1700000000 .profile\n41ed 4096 1700000001 etc\n",
        );
        let result = parse_listing(&out).unwrap();
        let by = |n: &str| result.entries.iter().find(|e| e.name == n).unwrap();
        assert_eq!(by(".profile").size, Some(20));
        assert_eq!(by("gone").size, None);
        assert_eq!(by("gone").mode, None);
        assert_eq!(by("etc").modified, Some(1_700_000_001));
    }

    #[test]
    fn listing_without_stat_and_truncated() {
        let mut out = b"KPFS1\0/\0d\0bin\0\0f\0a b\0\0KPFS-MORE\0KPFS-STAT\0".to_vec();
        out.extend_from_slice(b"sh: stat: not found\n");
        let result = parse_listing(&out).unwrap();
        assert!(result.truncated);
        assert_eq!(result.entries.len(), 2);
        assert!(result.entries.iter().all(|e| e.size.is_none()));
        assert_eq!(result.entries[0].name, "bin");
    }

    #[test]
    fn names_that_look_like_markers_are_just_names() {
        let out = listing(&[("f", "KPFS-STAT", ""), ("f", "KPFS-MORE", "")], "");
        let result = parse_listing(&out).unwrap();
        assert_eq!(result.entries.len(), 2);
        assert!(!result.truncated);
        assert!(parse_listing(b"welcome to the container\n").is_err());
        assert!(parse_listing(b"KPFS1\0/\0f\0cut").is_err());
    }

    #[test]
    fn stat_matching_prefers_the_expected_name() {
        let names: Vec<&[u8]> = vec![b"a", b"a\nb", b"c"];
        let stats = parse_stat_lines(b"81a4 1 1 a\n81a4 2 2 a\nb\n81a4 3 3 c\n", &names);
        assert_eq!(stats[&0].size, 1);
        assert_eq!(stats[&1].size, 2);
        assert_eq!(stats[&2].size, 3);
        // A record for an unknown name is skipped, later ones still match.
        let stats = parse_stat_lines(b"81a4 9 9 zzz\n81a4 3 3 c\n", &names);
        assert_eq!(stats.len(), 1);
        assert_eq!(stats[&2].size, 3);
    }

    #[test]
    fn mode_strings() {
        assert_eq!(mode_string(0o100_644), "-rw-r--r--");
        assert_eq!(mode_string(0o040_755), "drwxr-xr-x");
        assert_eq!(mode_string(0o104_755), "-rwsr-xr-x");
        assert_eq!(mode_string(0o041_777), "drwxrwxrwt");
        assert_eq!(mode_string(0o102_640), "-rw-r-S---");
        assert_eq!(mode_string(0o020_620), "crw--w----");
    }

    #[test]
    fn file_previews() {
        let text = parse_file_content("/etc/hostname", b"KPFS1 4\nweb\n", 1024).unwrap();
        assert_eq!(text.text.as_deref(), Some("web\n"));
        assert_eq!(text.size, Some(4));
        assert!(!text.truncated && !text.binary && text.base64.is_none());

        // Cut in the middle of a multi-byte character: still text.
        let mut out = b"KPFS1 100\n".to_vec();
        out.extend_from_slice("ab€".as_bytes());
        let cut = parse_file_content("/f", &out, 4).unwrap();
        assert!(cut.truncated && !cut.binary);
        assert_eq!(cut.text.as_deref(), Some("ab"));

        let bin = parse_file_content("/bin/sh", b"KPFS1 3\n\x7fE\0", 1024).unwrap();
        assert!(bin.binary && bin.text.is_none());
        assert_eq!(bin.base64.as_deref(), Some("f0UA"));

        // /proc files report size 0 but have content; unknown size.
        let proc = parse_file_content("/proc/cpuinfo", b"KPFS1 \nprocessor : 0\n", 1024).unwrap();
        assert_eq!(proc.size, None);
        assert!(!proc.truncated);
        assert!(parse_file_content("/f", b"garbage", 10).is_err());
        assert!(looks_binary(&[0xff, 0xfe, b'a'], false));
    }

    #[test]
    fn remote_paths() {
        assert_eq!(
            split_remote_path("/var/log/").unwrap(),
            ("/var".into(), "log".into())
        );
        assert_eq!(
            split_remote_path("/etc").unwrap(),
            ("/".into(), "etc".into())
        );
        assert_eq!(
            split_remote_path("notes.txt").unwrap(),
            (".".into(), "notes.txt".into())
        );
        assert!(split_remote_path("/").is_err());
        assert_eq!(join_remote("/", "a"), "/a");
        assert_eq!(join_remote("/tmp", "a b"), "/tmp/a b");
    }

    #[test]
    fn exec_failures() {
        let failure = |message: &str| Status {
            status: Some("Failure".into()),
            message: Some(message.into()),
            reason: Some("InternalError".into()),
            ..Default::default()
        };
        let success = Status {
            status: Some("Success".into()),
            ..Default::default()
        };
        let no_sh = failure(
            "OCI runtime exec failed: exec failed: unable to start container process: exec: \"sh\": executable file not found in $PATH: unknown",
        );
        let text = exec_failure(Some(&no_sh), "", "app").unwrap();
        assert!(text.contains("has no shell") && text.contains("debug container"));
        let exit = failure("command terminated with non-zero exit code: exit status 2");
        assert_eq!(
            exec_failure(Some(&exit), "no such file or directory: /nope\n", "app").as_deref(),
            Some("no such file or directory: /nope")
        );
        assert_eq!(
            exec_failure(Some(&exit), "", "app").as_deref(),
            Some("command terminated with non-zero exit code: exit status 2")
        );
        assert_eq!(exec_failure(Some(&success), "noise", "app"), None);
        assert_eq!(exec_failure(None, "", "app"), None);
        assert!(!is_missing_shell("permission denied"));
    }

    #[test]
    fn scripts_take_arguments_positionally() {
        let command = sh(LIST_SCRIPT, &["/tmp/$(rm -rf /)", "10"]);
        assert_eq!(command[..2], ["sh".to_string(), "-c".to_string()]);
        assert_eq!(command[3], "sh");
        assert_eq!(command[4], "/tmp/$(rm -rf /)");
        assert!(!command[2].contains("rm -rf"));
    }

    #[tokio::test]
    async fn read_only_clusters_refuse_uploads() {
        let (dir, app, cluster) = app_with_cluster(true);
        let file = dir.path().join("x.txt");
        std::fs::write(&file, "hi").unwrap();
        let err = app
            .pod_fs_upload(
                &cluster.id,
                "ns",
                "web",
                None,
                &file.to_string_lossy(),
                "/tmp",
            )
            .await
            .unwrap_err();
        assert!(crate::error::is_read_only(&err));
    }
}
