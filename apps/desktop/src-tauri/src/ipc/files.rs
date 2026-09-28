//! Resource wizards: bytes of a local file the user picked in the dialog.

use kubepit_core::local_files::{read_local_file, LocalFile, MAX_LOCAL_FILE_BYTES};

use super::{blocking, IpcResult};

/// Reads a picked file (at most 1 MiB) as base64. The content is never logged.
#[tauri::command]
pub async fn local_file_read(path: String) -> IpcResult<LocalFile> {
    blocking(move || {
        let path = kubepit_core::paths::expand_tilde(&path);
        read_local_file(&path, MAX_LOCAL_FILE_BYTES)
    })
    .await
}
