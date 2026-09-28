//! Local files picked by the user for resource wizards (Secret and
//! ConfigMap values, TLS certificates and keys, `.env` imports).
//!
//! The UI picks a path through the native dialog and asks for its bytes;
//! nothing else in the app reads arbitrary files. Reads are bounded by
//! [`MAX_LOCAL_FILE_BYTES`] (Kubernetes rejects objects above roughly 1 MiB
//! anyway), bytes cross as base64 so binary files survive IPC, and neither
//! the content nor anything derived from it is logged: errors only name the
//! path and sizes.

use std::io::Read;
use std::path::Path;

use anyhow::{bail, Context, Result};
use base64::Engine;
use serde::{Deserialize, Serialize};

/// Largest file a wizard may load (1 MiB, the practical size limit of a
/// ConfigMap or Secret).
pub const MAX_LOCAL_FILE_BYTES: u64 = 1024 * 1024;

/// A local file's content, base64-encoded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalFile {
    /// The path as read (after `~` expansion).
    pub path: String,
    /// Last path segment, the default data key.
    pub name: String,
    pub size: u64,
    /// True when the bytes are valid UTF-8 (`kubectl create configmap
    /// --from-file` puts everything else in `binaryData`).
    pub utf8: bool,
    /// Standard base64 of the whole file.
    pub base64: String,
}

fn size_text(bytes: u64) -> String {
    if bytes >= 1024 * 1024 {
        format!("{:.1} MiB", bytes as f64 / (1024.0 * 1024.0))
    } else if bytes >= 1024 {
        format!("{:.1} KiB", bytes as f64 / 1024.0)
    } else {
        format!("{bytes} B")
    }
}

/// Read a regular file of at most `max_bytes` bytes.
pub fn read_local_file(path: &Path, max_bytes: u64) -> Result<LocalFile> {
    let meta =
        std::fs::metadata(path).with_context(|| format!("cannot read {}", path.display()))?;
    if meta.is_dir() {
        bail!("{} is a folder, not a file", path.display());
    }
    if !meta.is_file() {
        bail!("{} is not a regular file", path.display());
    }
    let too_large = |size: u64| {
        anyhow::anyhow!(
            "{} is too large ({}); files up to {} can be loaded",
            path.display(),
            size_text(size),
            size_text(max_bytes)
        )
    };
    if meta.len() > max_bytes {
        return Err(too_large(meta.len()));
    }
    let file =
        std::fs::File::open(path).with_context(|| format!("cannot open {}", path.display()))?;
    // The file may grow between `metadata` and the read: never take more than the limit.
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .with_context(|| format!("cannot read {}", path.display()))?;
    if bytes.len() as u64 > max_bytes {
        return Err(too_large(bytes.len() as u64));
    }
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(LocalFile {
        path: path.to_string_lossy().into_owned(),
        name,
        size: bytes.len() as u64,
        utf8: std::str::from_utf8(&bytes).is_ok(),
        base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
    })
}
