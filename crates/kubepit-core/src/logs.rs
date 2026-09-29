//! Pod log streaming.
//!
//! `Api<Pod>::log_stream` yields raw bytes. They are batched into
//! [`LogChunk`]s — flushed 50 ms after the first unflushed byte or once 64 KB
//! are buffered — so a chatty pod produces a handful of IPC messages per
//! second instead of one per line. Chunks are cut on UTF-8 character
//! boundaries ([`Utf8Accumulator`]) so a multi-byte character split across
//! two network reads is never turned into replacement characters.
//!
//! The last chunk has `done: true`, with `error` set when the stream failed
//! (pod gone, container not found, no previous instance…).

use std::time::Duration;

use anyhow::{Context, Result};
use futures::AsyncReadExt;
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, LogParams};
use tokio::time::Instant;

use crate::app::Kubepit;
use crate::error::{describe_kube_error, kube_error};
use crate::types::{LogChunk, LogOptions};

/// Flush pending log text this long after its first byte arrived.
pub const LOG_FLUSH_INTERVAL: Duration = Duration::from_millis(50);
/// Flush as soon as this much text is pending.
pub const LOG_FLUSH_BYTES: usize = 64 * 1024;
const READ_BUF: usize = 16 * 1024;
/// Bytes [`Kubepit::pod_logs_tail`] reads at most.
pub const MAX_TAIL_BYTES: i64 = 1024 * 1024;

/// Byte buffer that only ever releases complete UTF-8 characters (invalid
/// sequences are replaced lossily; an incomplete trailing sequence waits for
/// the next read).
#[derive(Default)]
pub struct Utf8Accumulator {
    buf: Vec<u8>,
}

impl Utf8Accumulator {
    pub fn push(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
    }

    pub fn len(&self) -> usize {
        self.buf.len()
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }

    /// Text up to the last complete character; the remainder stays buffered.
    pub fn take_complete(&mut self) -> String {
        let cut = complete_prefix_len(&self.buf);
        let rest = self.buf.split_off(cut);
        let text = String::from_utf8_lossy(&self.buf).into_owned();
        self.buf = rest;
        text
    }

    /// Everything, including a dangling partial character (end of stream).
    pub fn take_all(&mut self) -> String {
        let text = String::from_utf8_lossy(&self.buf).into_owned();
        self.buf.clear();
        text
    }
}

/// Length of the prefix of `buf` that does not end inside a multi-byte
/// UTF-8 sequence.
fn complete_prefix_len(buf: &[u8]) -> usize {
    let len = buf.len();
    for back in 1..=len.min(4) {
        let i = len - back;
        let byte = buf[i];
        if byte & 0xC0 == 0x80 {
            continue; // continuation byte, keep looking for the lead byte
        }
        let needed = match byte {
            b if b < 0x80 => 1,
            b if b & 0xE0 == 0xC0 => 2,
            b if b & 0xF0 == 0xE0 => 3,
            b if b & 0xF8 == 0xF0 => 4,
            _ => 1, // invalid lead byte: let the lossy decoder handle it
        };
        return if back < needed { i } else { len };
    }
    len
}

pub fn log_params(container: Option<String>, options: &LogOptions) -> LogParams {
    LogParams {
        container: container.filter(|c| !c.is_empty()),
        follow: options.follow,
        tail_lines: options.tail_lines.filter(|n| *n >= 0),
        since_seconds: options.since_seconds.filter(|n| *n > 0),
        timestamps: options.timestamps,
        previous: options.previous,
        ..LogParams::default()
    }
}

async fn run_logs<F>(api: Api<Pod>, pod: String, params: LogParams, stream_id: String, sink: F)
where
    F: Fn(LogChunk) -> bool + Send + Sync + 'static,
{
    let chunk = |data: String, done: bool, error: Option<String>| LogChunk {
        stream_id: stream_id.clone(),
        data,
        done,
        error,
    };
    let reader = match api.log_stream(&pod, &params).await {
        Ok(reader) => reader,
        Err(e) => {
            sink(chunk(String::new(), true, Some(describe_kube_error(&e))));
            return;
        }
    };
    let mut reader = Box::pin(reader);
    let mut acc = Utf8Accumulator::default();
    let mut deadline: Option<Instant> = None;
    let mut buf = vec![0u8; READ_BUF];

    loop {
        let wait = async {
            match deadline {
                Some(at) => tokio::time::sleep_until(at).await,
                None => futures::future::pending::<()>().await,
            }
        };
        tokio::select! {
            read = reader.read(&mut buf) => match read {
                Ok(0) => {
                    sink(chunk(acc.take_all(), true, None));
                    return;
                }
                Ok(n) => {
                    acc.push(&buf[..n]);
                    if deadline.is_none() {
                        deadline = Some(Instant::now() + LOG_FLUSH_INTERVAL);
                    }
                    if acc.len() >= LOG_FLUSH_BYTES {
                        deadline = None;
                        let text = acc.take_complete();
                        if !text.is_empty() && !sink(chunk(text, false, None)) {
                            return;
                        }
                    }
                }
                Err(e) => {
                    sink(chunk(acc.take_all(), true, Some(format!("log stream failed: {e}"))));
                    return;
                }
            },
            _ = wait => {
                deadline = None;
                let text = acc.take_complete();
                if !text.is_empty() && !sink(chunk(text, false, None)) {
                    return;
                }
            }
        }
    }
}

impl Kubepit {
    /// `pod_logs_stream`: start streaming and return the stream id. Failures
    /// to open the stream arrive as the final chunk's `error`.
    pub async fn pod_logs_stream<F>(
        &self,
        cluster_id: &str,
        namespace: &str,
        pod: &str,
        container: Option<String>,
        options: LogOptions,
        sink: F,
    ) -> Result<String>
    where
        F: Fn(LogChunk) -> bool + Send + Sync + 'static,
    {
        let client = self.client(cluster_id).await?;
        let api: Api<Pod> = Api::namespaced(client, namespace);
        let params = log_params(container, &options);
        let stream_id = uuid::Uuid::new_v4().to_string();
        self.log_streams.spawn(
            &stream_id,
            cluster_id,
            run_logs(api, pod.to_string(), params, stream_id.clone(), sink),
        );
        Ok(stream_id)
    }

    /// `pod_logs_stop`. Unknown ids are ignored.
    pub fn pod_logs_stop(&self, stream_id: &str) {
        self.log_streams.stop(stream_id);
    }

    /// The last `tail_lines` lines of a container's log, once (no follow),
    /// with timestamps, at most [`MAX_TAIL_BYTES`] (the assistant's
    /// `get_pod_logs` tool). A character cut by the byte limit is dropped.
    pub async fn pod_logs_tail(
        &self,
        cluster_id: &str,
        namespace: &str,
        pod: &str,
        container: Option<&str>,
        tail_lines: i64,
        previous: bool,
    ) -> Result<String> {
        let client = self.client(cluster_id).await?;
        let api: Api<Pod> = Api::namespaced(client, namespace);
        let options = LogOptions {
            follow: false,
            tail_lines: Some(tail_lines),
            since_seconds: None,
            timestamps: true,
            previous,
        };
        let mut params = log_params(container.map(str::to_string), &options);
        params.limit_bytes = Some(MAX_TAIL_BYTES);
        let reader = api
            .log_stream(pod, &params)
            .await
            .map_err(kube_error)
            .with_context(|| format!("failed to read the logs of pod {namespace}/{pod}"))?;
        let mut bytes = Vec::new();
        Box::pin(reader)
            .take(MAX_TAIL_BYTES as u64)
            .read_to_end(&mut bytes)
            .await
            .with_context(|| format!("failed to read the logs of pod {namespace}/{pod}"))?;
        let mut acc = Utf8Accumulator::default();
        acc.push(&bytes);
        Ok(acc.take_complete())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_multibyte_characters_wait_for_completion() {
        let text = "héllo → 世界 🚀\n";
        let bytes = text.as_bytes();
        // Feed one byte at a time; every emitted prefix must be valid and the
        // concatenation must equal the input exactly (no U+FFFD).
        let mut acc = Utf8Accumulator::default();
        let mut out = String::new();
        for b in bytes {
            acc.push(std::slice::from_ref(b));
            out.push_str(&acc.take_complete());
        }
        out.push_str(&acc.take_all());
        assert_eq!(out, text);
    }

    #[test]
    fn complete_prefix_boundaries() {
        assert_eq!(complete_prefix_len(b""), 0);
        assert_eq!(complete_prefix_len(b"abc"), 3);
        let euro = "€".as_bytes(); // 3 bytes
        assert_eq!(complete_prefix_len(&euro[..1]), 0);
        assert_eq!(complete_prefix_len(&euro[..2]), 0);
        assert_eq!(complete_prefix_len(euro), 3);
        let mut mixed = b"ok".to_vec();
        mixed.extend_from_slice(&"🚀".as_bytes()[..3]);
        assert_eq!(complete_prefix_len(&mixed), 2);
    }

    #[test]
    fn invalid_bytes_are_replaced_not_stuck() {
        let mut acc = Utf8Accumulator::default();
        acc.push(&[b'a', 0xFF, b'b']);
        assert_eq!(acc.take_complete(), "a\u{FFFD}b");
        assert!(acc.is_empty());
    }

    #[test]
    fn log_params_map_options() {
        let params = log_params(
            Some("app".into()),
            &LogOptions {
                follow: true,
                tail_lines: Some(100),
                since_seconds: Some(0),
                timestamps: true,
                previous: false,
            },
        );
        assert_eq!(params.container.as_deref(), Some("app"));
        assert!(params.follow && params.timestamps && !params.previous);
        assert_eq!(params.tail_lines, Some(100));
        assert_eq!(params.since_seconds, None);
        assert_eq!(
            log_params(Some(String::new()), &LogOptions::default()).container,
            None
        );
    }
}
