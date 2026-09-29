use std::sync::Arc;

use kubepit_core::secrets::KeyringSecretStore;
use kubepit_core::{EventSink, Kubepit, Paths};
use tauri::{Emitter, Manager};

use crate::app_state::{AppState, TauriEventSink, TerminalExit, EVENT_TERMINAL_EXIT};
use crate::terminal::TerminalManager;

pub(crate) fn setup_app(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    // Finder/Dock launches inherit launchd's minimal PATH; kubectl, helm and
    // kubeconfig exec plugins (aws, gke-gcloud-auth-plugin, kubelogin) live
    // in Homebrew / tool-manager directories. Must run before any spawn.
    kubepit_core::shell_env::import_login_shell_path();

    let paths = Paths::from_env()?;
    let sink: Arc<dyn EventSink> = Arc::new(TauriEventSink::new(app.handle().clone()));
    // Keychain mode keeps pasted kubeconfigs in the OS credential store.
    let core = Arc::new(Kubepit::open_with_secrets(
        paths,
        sink,
        Arc::new(KeyringSecretStore),
    )?);
    // The desktop app watches connected clusters for alerts (see `alerts.rs`).
    core.set_alert_monitoring(true);
    // ... and records their change timeline (see `change_journal.rs`).
    core.set_change_journal_recording(true);
    // ... and keeps the audit log and opted-in persistent history (see `history.rs`).
    core.set_history_recording(true);
    // ... and samples metrics-server usage for charts (see `metrics_history.rs`).
    core.set_metrics_sampling(true);
    // ... and scans opted-in clusters for recommendations in the background
    // (see `recommendations/schedule.rs`; never in tests or other binaries).
    core.set_recommendation_scans(true);
    tracing::info!(data_dir = %core.paths().root().display(), "kubepit core ready");
    core.start_kubeconfig_watch();

    let handle = app.handle().clone();
    let terminals = TerminalManager::with_exit_hook(Arc::new(move |id, code| {
        let _ = handle.emit(EVENT_TERMINAL_EXIT, TerminalExit { id, code });
    }));

    app.manage(AppState {
        core,
        terminals,
        window_terminals: Default::default(),
        window_watches: Default::default(),
    });
    Ok(())
}

/// Best-effort cleanup when the app exits. Core goes first: it deletes
/// node-shell helper pods *synchronously* (bounded), whereas a terminal's
/// own cleanup hook only queues the delete, which would not finish before
/// the process exits. Then every PTY is killed.
pub(crate) fn shutdown(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let core = state.core.clone();
    tauri::async_runtime::block_on(async move {
        core.shutdown().await;
    });
    state.terminals.destroy_all();
}
