use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use kubepit_core::error::{is_read_only, to_ipc};
use kubepit_core::types::TerminalSpec;
use tauri::ipc::Channel;

use crate::AppState;

use super::TerminalOutput;

/// Red, CRLF-terminated text for the terminal (xterm needs `\r\n`).
fn error_banner(message: &str) -> String {
    format!(
        "\r\n\x1b[31m{}\x1b[0m\r\n",
        message.replace("\r\n", "\n").replace('\n', "\r\n")
    )
}

/// Start a terminal session described by `spec`.
///
/// Setup failures that the user should read in context (kubectl missing,
/// node-shell pod not starting, unknown cluster…) are written into the
/// terminal in red followed by a `terminal://exit` event, instead of
/// rejecting the call. Read-only violations are returned as errors.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Named IPC parameters include the output channel and app state.
pub async fn terminal_create(
    id: String,
    stream_id: String,
    spec: TerminalSpec,
    cols: u16,
    rows: u16,
    on_output: Channel<TerminalOutput>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let core = state.core.clone();
    let terminals = state.terminals.clone();

    // A restart reuses the id: stop the previous PTY (and its helper pod)
    // before preparing the new session.
    {
        let terminals = terminals.clone();
        let id = id.clone();
        tauri::async_runtime::spawn_blocking(move || terminals.destroy(&id))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| format!("{e:#}"))?;
    }

    let progress_channel = on_output.clone();
    let progress_stream = stream_id.clone();
    let progress = move |text: &str| {
        progress_channel
            .send(TerminalOutput {
                data: BASE64.encode(text.as_bytes()),
                stream_id: progress_stream.clone(),
            })
            .is_ok()
    };

    match core.prepare_terminal(&id, &spec, &progress).await {
        Ok(mut launch) if launch.cleanup.is_some() && !progress("") => {
            // The webview went away while the node-shell pod was starting;
            // nobody will ever destroy this terminal, so clean up now.
            if let Some(cleanup) = launch.cleanup.take() {
                cleanup();
            }
            Err("terminal closed before it was ready".to_string())
        }
        Ok(launch) => tauri::async_runtime::spawn_blocking(move || {
            terminals.create(&id, &stream_id, cols, rows, on_output, launch)
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("{e:#}")),
        Err(err) if is_read_only(&err) => Err(to_ipc(err)),
        Err(err) => {
            let _ = on_output.send(TerminalOutput {
                data: BASE64.encode(error_banner(&format!("{err:#}"))),
                stream_id,
            });
            terminals.notify_exit(&id, Some(1));
            Ok(())
        }
    }
}

#[tauri::command]
pub async fn terminal_write(
    id: String,
    stream_id: String,
    data: Vec<u8>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let terminals = state.terminals.clone();
    tauri::async_runtime::spawn_blocking(move || terminals.write(&id, &stream_id, &data))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn terminal_resize(
    id: String,
    stream_id: String,
    cols: u16,
    rows: u16,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let terminals = state.terminals.clone();
    tauri::async_runtime::spawn_blocking(move || terminals.resize(&id, &stream_id, cols, rows))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn terminal_destroy(id: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let terminals = state.terminals.clone();
    tauri::async_runtime::spawn_blocking(move || terminals.destroy(&id))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("{e:#}"))
}

// Only updates a byte counter; no OS I/O or blocking wait on this path.
#[tauri::command]
pub fn terminal_acknowledge(
    id: String,
    stream_id: String,
    bytes: usize,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state
        .terminals
        .acknowledge(&id, &stream_id, bytes)
        .map_err(|e| format!("{e:#}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn banner_uses_crlf_and_red() {
        let banner = error_banner("kubectl was not found\nInstall it");
        assert_eq!(
            banner,
            "\r\n\x1b[31mkubectl was not found\r\nInstall it\x1b[0m\r\n"
        );
    }
}
