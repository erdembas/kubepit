//! In-app updates on top of `tauri-plugin-updater`.
//!
//! Inert until release signing is configured: `lib.rs` registers the plugin
//! only when `plugins.updater.pubkey` is set (see
//! [`kubepit_core::updates::UpdaterConfig`]); otherwise `update_check` and
//! `update_install` refuse with "not configured" and the UI says so. The
//! relaunch after installing goes through `tauri-plugin-process` from the UI.

use std::time::Duration;

use kubepit_core::updates::{
    DownloadProgress, UpdateInfo, UpdateProgress, UpdaterConfig, UpdaterStatus,
    DEFAULT_UPDATE_ENDPOINT,
};
use parking_lot::Mutex;
use tauri::ipc::Channel;
use tauri::{AppHandle, State, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

use super::IpcResult;

const NOT_CONFIGURED: &str = "Updates are not configured for this build";
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);

/// Managed state: the build's updater config and the update found by the last check.
pub struct UpdaterState {
    config: UpdaterConfig,
    pending: Mutex<Option<Update>>,
}

impl UpdaterState {
    pub fn new(config: UpdaterConfig) -> Self {
        Self {
            config,
            pending: Mutex::new(None),
        }
    }

    /// Whether the updater plugin should be registered.
    pub fn enabled(&self) -> bool {
        self.config.enabled()
    }
}

#[tauri::command]
pub async fn update_status(
    app: AppHandle,
    state: State<'_, UpdaterState>,
) -> IpcResult<UpdaterStatus> {
    Ok(UpdaterStatus {
        configured: state.enabled(),
        current_version: app.package_info().version.to_string(),
        endpoint: state.config.endpoint().to_string(),
    })
}

/// `null` when the running version is the newest one.
#[tauri::command]
pub async fn update_check(
    app: AppHandle,
    state: State<'_, UpdaterState>,
) -> IpcResult<Option<UpdateInfo>> {
    if !state.enabled() {
        return Err(NOT_CONFIGURED.to_string());
    }
    let mut builder = app.updater_builder().timeout(CHECK_TIMEOUT);
    if state.config.endpoints.is_empty() {
        let url = Url::parse(DEFAULT_UPDATE_ENDPOINT).map_err(|e| e.to_string())?;
        builder = builder.endpoints(vec![url]).map_err(|e| e.to_string())?;
    }
    let updater = builder
        .build()
        .map_err(|e| format!("cannot set up the updater: {e}"))?;
    let update = updater
        .check()
        .await
        .map_err(|e| format!("update check failed: {e}"))?;
    let info = update.as_ref().map(|u| UpdateInfo {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        date: u
            .raw_json
            .get("pub_date")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        notes: u.body.clone().filter(|notes| !notes.trim().is_empty()),
    });
    *state.pending.lock() = update;
    Ok(info)
}

/// Downloads, verifies and installs the update found by the last check.
/// The UI relaunches afterwards (Windows installers restart on their own).
#[tauri::command]
pub async fn update_install(
    state: State<'_, UpdaterState>,
    on_event: Channel<UpdateProgress>,
) -> IpcResult<()> {
    if !state.enabled() {
        return Err(NOT_CONFIGURED.to_string());
    }
    let update = state
        .pending
        .lock()
        .clone()
        .ok_or_else(|| "No update to install. Check for updates first.".to_string())?;
    let mut progress = DownloadProgress::default();
    let chunks = on_event.clone();
    update
        .download_and_install(
            move |len, total| {
                for event in progress.chunk(len, total) {
                    let _ = chunks.send(event);
                }
            },
            move || {
                let _ = on_event.send(UpdateProgress::Finished);
            },
        )
        .await
        .map_err(|e| format!("update failed: {e}"))?;
    state.pending.lock().take();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn committed_section() -> serde_json::Value {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        config
            .pointer("/plugins/updater")
            .cloned()
            .expect("tauri.conf.json has a plugins.updater section")
    }

    #[test]
    fn committed_config_is_ready_for_a_signing_key() {
        let mut section = committed_section();
        let current = UpdaterConfig::from_plugin_config(Some(&section));
        assert_eq!(current.problem, None);
        assert_eq!(current.endpoint(), DEFAULT_UPDATE_ENDPOINT);

        // Adding only a public key must be enough to turn updates on.
        section["pubkey"] = serde_json::json!("dW50cnVzdGVkIGNvbW1lbnQ=");
        assert!(UpdaterConfig::from_plugin_config(Some(&section)).enabled());
    }
}
