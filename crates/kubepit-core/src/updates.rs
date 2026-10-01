//! In-app updates: build configuration, IPC types and download progress.
//!
//! The desktop shell owns the updater itself (`tauri-plugin-updater`); this
//! module keeps the parts that are worth testing without a Tauri runtime:
//!
//! - [`UpdaterConfig`] decides whether a build can update at all. Updates
//!   stay **inert until release signing is configured**: without a minisign
//!   public key in `tauri.conf.json` → `plugins.updater.pubkey` the plugin
//!   is not even registered and every check reports "not configured".
//! - [`UpdaterStatus`], [`UpdateInfo`] and [`UpdateProgress`] cross IPC.
//! - [`DownloadProgress`] turns the plugin's per-chunk callback into a few
//!   progress events (one per percent) instead of one per network read.
//!
//! See `docs/RELEASING.md` for keys, artifacts and the `latest.json` feed.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Update feed used when `plugins.updater.endpoints` is empty.
pub const DEFAULT_UPDATE_ENDPOINT: &str = "https://erdembas.github.io/kubepit/updates/latest.json";

/// Progress events are sent at most every this many bytes when the size is unknown.
const UNKNOWN_SIZE_STEP: u64 = 256 * 1024;

/// The updater section of the bundled config (`plugins.updater`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UpdaterConfig {
    /// Minisign public key (the content of `kubepit.key.pub`), trimmed.
    pub pubkey: Option<String>,
    /// Configured endpoints; empty = [`DEFAULT_UPDATE_ENDPOINT`].
    pub endpoints: Vec<String>,
    /// Why updates are off although a key is present (invalid endpoints).
    pub problem: Option<String>,
}

impl UpdaterConfig {
    /// Reads `plugins.updater` (`None` when the section is absent).
    ///
    /// Updates are enabled only when `pubkey` is a non-empty string and every
    /// endpoint is an `https://` URL — the plugin itself rejects anything
    /// else at startup, and a failing plugin would stop the whole app.
    pub fn from_plugin_config(section: Option<&Value>) -> Self {
        let Some(section) = section.and_then(Value::as_object) else {
            return Self::default();
        };
        let pubkey = section
            .get("pubkey")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|key| !key.is_empty())
            .map(str::to_string);
        let raw_endpoints = section.get("endpoints").and_then(Value::as_array);
        let endpoints: Vec<String> = raw_endpoints
            .map(|list| {
                list.iter()
                    .filter_map(Value::as_str)
                    .map(|url| url.trim().to_string())
                    .collect()
            })
            .unwrap_or_default();
        let invalid = raw_endpoints.is_some_and(|list| {
            list.len() != endpoints.len()
                || endpoints
                    .iter()
                    .any(|url| !url.starts_with("https://") || url.len() <= "https://".len())
        });
        let problem = (pubkey.is_some() && invalid)
            .then(|| "plugins.updater.endpoints must be https:// URLs".to_string());
        Self {
            pubkey,
            endpoints,
            problem,
        }
    }

    /// True when the build is signed for updates and the updater plugin runs.
    pub fn enabled(&self) -> bool {
        self.pubkey.is_some() && self.problem.is_none()
    }

    /// The feed a check asks first.
    pub fn endpoint(&self) -> &str {
        self.endpoints
            .first()
            .map(String::as_str)
            .unwrap_or(DEFAULT_UPDATE_ENDPOINT)
    }
}

/// `update_status`: what the About & Updates page shows before any check.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdaterStatus {
    /// False for builds without a release signing key: checks are refused.
    pub configured: bool,
    pub current_version: String,
    pub endpoint: String,
}

/// An available update announced by the feed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    /// `pub_date` of the feed (RFC 3339), when present.
    pub date: Option<String>,
    /// Release notes (`notes` of the feed), usually Markdown.
    pub notes: Option<String>,
}

/// Download progress of `update_install`, streamed on its channel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum UpdateProgress {
    Started {
        total: Option<u64>,
    },
    Progress {
        downloaded: u64,
        total: Option<u64>,
    },
    /// Downloaded and verified; the installer runs next.
    Finished,
}

/// Throttles the plugin's chunk callback into [`UpdateProgress`] events.
#[derive(Debug, Default)]
pub struct DownloadProgress {
    downloaded: u64,
    total: Option<u64>,
    started: bool,
    /// Percent (known size) or byte step (unknown size) of the last event.
    last_mark: Option<u64>,
}

impl DownloadProgress {
    /// Records one downloaded chunk and returns the events to send: a
    /// `Started` first, then at most one `Progress` per percent (or per
    /// 256 KiB while the size is unknown).
    pub fn chunk(&mut self, len: usize, total: Option<u64>) -> Vec<UpdateProgress> {
        let mut events = Vec::new();
        if total.is_some() {
            self.total = total;
        }
        if !self.started {
            self.started = true;
            events.push(UpdateProgress::Started { total: self.total });
        }
        self.downloaded = self.downloaded.saturating_add(len as u64);
        let mark = match self.total {
            Some(total) if total > 0 => self.downloaded.min(total).saturating_mul(100) / total,
            _ => self.downloaded / UNKNOWN_SIZE_STEP,
        };
        if self.last_mark != Some(mark) {
            self.last_mark = Some(mark);
            events.push(UpdateProgress::Progress {
                downloaded: self.downloaded,
                total: self.total,
            });
        }
        events
    }

    /// Bytes received so far.
    pub fn downloaded(&self) -> u64 {
        self.downloaded
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn missing_or_empty_pubkey_keeps_updates_off() {
        assert!(!UpdaterConfig::from_plugin_config(None).enabled());
        assert!(!UpdaterConfig::from_plugin_config(Some(&json!(null))).enabled());
        let blank = json!({ "pubkey": "   ", "endpoints": [DEFAULT_UPDATE_ENDPOINT] });
        let config = UpdaterConfig::from_plugin_config(Some(&blank));
        assert!(!config.enabled());
        assert_eq!(config.pubkey, None);
        assert_eq!(config.problem, None);
    }

    #[test]
    fn a_pubkey_enables_updates_with_the_default_endpoint() {
        let section = json!({ "pubkey": " dW50cnVzdGVkIGNvbW1lbnQ= \n" });
        let config = UpdaterConfig::from_plugin_config(Some(&section));
        assert!(config.enabled());
        assert_eq!(config.pubkey.as_deref(), Some("dW50cnVzdGVkIGNvbW1lbnQ="));
        assert_eq!(config.endpoint(), DEFAULT_UPDATE_ENDPOINT);
    }

    #[test]
    fn configured_endpoints_win_and_must_be_https() {
        let section = json!({
            "pubkey": "key",
            "endpoints": ["https://example.com/latest.json", "https://mirror.example.com/l.json"]
        });
        let config = UpdaterConfig::from_plugin_config(Some(&section));
        assert!(config.enabled());
        assert_eq!(config.endpoint(), "https://example.com/latest.json");

        let insecure = json!({ "pubkey": "key", "endpoints": ["http://example.com/latest.json"] });
        let config = UpdaterConfig::from_plugin_config(Some(&insecure));
        assert!(!config.enabled());
        assert!(config.problem.is_some());

        let garbage = json!({ "pubkey": "key", "endpoints": [42] });
        assert!(!UpdaterConfig::from_plugin_config(Some(&garbage)).enabled());
    }

    #[test]
    fn progress_is_throttled_to_one_event_per_percent() {
        let mut progress = DownloadProgress::default();
        let first = progress.chunk(10, Some(1000));
        assert_eq!(
            first,
            vec![
                UpdateProgress::Started { total: Some(1000) },
                UpdateProgress::Progress {
                    downloaded: 10,
                    total: Some(1000)
                },
            ]
        );
        // 10 → 15 bytes stays at 1 %: nothing to send.
        assert!(progress.chunk(5, Some(1000)).is_empty());
        let events = progress.chunk(985, Some(1000));
        assert_eq!(
            events,
            vec![UpdateProgress::Progress {
                downloaded: 1000,
                total: Some(1000)
            }]
        );
        assert_eq!(progress.downloaded(), 1000);
    }

    #[test]
    fn unknown_size_reports_in_steps() {
        let mut progress = DownloadProgress::default();
        let events = progress.chunk(1024, None);
        assert_eq!(events.len(), 2, "started + first progress");
        assert!(progress.chunk(1024, None).is_empty());
        let step = UNKNOWN_SIZE_STEP as usize;
        assert_eq!(progress.chunk(step, None).len(), 1);
    }

    #[test]
    fn progress_serializes_with_an_event_tag() {
        let value = serde_json::to_value(UpdateProgress::Progress {
            downloaded: 5,
            total: None,
        })
        .unwrap();
        assert_eq!(
            value,
            json!({ "event": "progress", "downloaded": 5, "total": null })
        );
        assert_eq!(
            serde_json::to_value(UpdateProgress::Finished).unwrap(),
            json!({ "event": "finished" })
        );
    }
}
