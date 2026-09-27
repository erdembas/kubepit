//! Error helpers shared by every Kubernetes-facing module.
//!
//! Core functions return [`anyhow::Result`]; the IPC edge renders them with
//! `format!("{e:#}")`. The one thing plain `anyhow` loses is the HTTP status
//! of an API failure, which several features branch on (403 → fall back to
//! configured namespaces, 404 → "metrics-server not installed", 429 → PDB
//! blocked an eviction). [`kube_error`] converts `kube::Error::Api` into an
//! [`ApiError`] that keeps the code *and* renders as the server's own
//! human-readable message instead of kube's verbose `Debug` dump.

use kube::runtime::watcher;

/// A failed Kubernetes API call, reduced to what users and callers need.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct ApiError {
    pub code: u16,
    pub reason: String,
    pub message: String,
}

/// Returned by every mutating command on a cluster marked `read_only`.
#[derive(Debug, Clone, thiserror::Error)]
#[error("Cluster \"{cluster}\" is read-only: {action} is not allowed")]
pub struct ReadOnlyError {
    pub cluster: String,
    pub action: String,
}

fn api_error_from_status(status: &kube::core::Status) -> ApiError {
    let message = if status.message.is_empty() {
        if status.reason.is_empty() {
            format!("request failed with HTTP {}", status.code)
        } else {
            format!("{} (HTTP {})", status.reason, status.code)
        }
    } else {
        status.message.clone()
    };
    ApiError {
        code: status.code,
        reason: status.reason.clone(),
        message,
    }
}

/// Convert a kube error into an `anyhow::Error`, keeping API status codes
/// inspectable through [`api_code`].
pub fn kube_error(err: kube::Error) -> anyhow::Error {
    match err {
        kube::Error::Api(status) => api_error_from_status(&status).into(),
        other => anyhow::Error::new(other),
    }
}

/// The HTTP status of the first API failure in `err`'s chain, if any.
pub fn api_code(err: &anyhow::Error) -> Option<u16> {
    err.chain().find_map(|cause| {
        if let Some(api) = cause.downcast_ref::<ApiError>() {
            return Some(api.code);
        }
        match cause.downcast_ref::<kube::Error>() {
            Some(kube::Error::Api(status)) => Some(status.code),
            _ => None,
        }
    })
}

pub fn is_not_found(err: &anyhow::Error) -> bool {
    api_code(err) == Some(404)
}

pub fn is_forbidden(err: &anyhow::Error) -> bool {
    api_code(err) == Some(403)
}

/// True when `err` is (or wraps) a [`ReadOnlyError`].
pub fn is_read_only(err: &anyhow::Error) -> bool {
    err.chain()
        .any(|c| c.downcast_ref::<ReadOnlyError>().is_some())
}

/// Human-readable message for a watcher failure (initial list, watch start,
/// server-sent error, stream failure).
pub fn watcher_error_message(err: &watcher::Error) -> String {
    match err {
        watcher::Error::InitialListFailed(e)
        | watcher::Error::WatchStartFailed(e)
        | watcher::Error::WatchFailed(e) => describe_kube_error(e),
        watcher::Error::WatchError(status) => api_error_from_status(status).message,
        watcher::Error::NoResourceVersion => {
            "the resource does not support watching (no resourceVersion)".to_string()
        }
    }
}

/// HTTP status of a watcher failure, when the server returned one.
pub fn watcher_error_code(err: &watcher::Error) -> Option<u16> {
    match err {
        watcher::Error::InitialListFailed(kube::Error::Api(s))
        | watcher::Error::WatchStartFailed(kube::Error::Api(s))
        | watcher::Error::WatchFailed(kube::Error::Api(s)) => Some(s.code),
        watcher::Error::WatchError(s) => Some(s.code),
        _ => None,
    }
}

/// Render a kube error with its full source chain (connection errors hide
/// the useful part — "connection refused", "certificate expired" — in
/// nested sources).
pub fn describe_kube_error(err: &kube::Error) -> String {
    match err {
        kube::Error::Api(status) => api_error_from_status(status).message,
        other => {
            let mut text = other.to_string();
            let mut source = std::error::Error::source(other);
            while let Some(cause) = source {
                let piece = cause.to_string();
                if !text.contains(&piece) {
                    text.push_str(": ");
                    text.push_str(&piece);
                }
                source = cause.source();
            }
            text
        }
    }
}

/// Render an error for the IPC boundary.
pub fn to_ipc(err: anyhow::Error) -> String {
    format!("{err:#}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::Context;

    fn status(code: u16, reason: &str, message: &str) -> kube::core::Status {
        let mut s = kube::core::Status::failure(message, reason);
        s.code = code;
        s
    }

    #[test]
    fn api_errors_keep_their_code_through_context() {
        let err = kube_error(kube::Error::Api(Box::new(status(
            403,
            "Forbidden",
            "namespaces is forbidden",
        ))));
        let wrapped = Err::<(), _>(err).context("listing namespaces").unwrap_err();
        assert_eq!(api_code(&wrapped), Some(403));
        assert!(is_forbidden(&wrapped));
        assert!(!is_not_found(&wrapped));
        assert_eq!(
            to_ipc(wrapped),
            "listing namespaces: namespaces is forbidden"
        );
    }

    #[test]
    fn empty_status_message_falls_back_to_reason() {
        let err = kube_error(kube::Error::Api(Box::new(status(404, "NotFound", ""))));
        assert_eq!(err.to_string(), "NotFound (HTTP 404)");
        assert!(is_not_found(&err));
    }

    #[test]
    fn read_only_errors_are_detectable() {
        let err: anyhow::Error = ReadOnlyError {
            cluster: "prod".into(),
            action: "delete".into(),
        }
        .into();
        assert!(is_read_only(&err));
        assert!(err.to_string().contains("is read-only"));
    }
}
