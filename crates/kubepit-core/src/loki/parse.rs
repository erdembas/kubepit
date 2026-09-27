//! Loki HTTP API responses.
//!
//! Log queries return streams whose values are `[ns, line]` pairs with the
//! timestamp as a decimal string of nanoseconds (Loki 3 may append a third
//! element with structured metadata, which is ignored here — by default it
//! is part of the stream labels):
//!
//! ```json
//! {"status":"success","data":{"resultType":"streams","result":[
//!   {"stream":{"namespace":"shop","pod":"web-1"},
//!    "values":[["1700000000123456789","GET / 200"]]}],"stats":{}}}
//! ```
//!
//! Metric queries (`count_over_time`, …) return Prometheus-style matrices,
//! parsed by [`crate::prometheus::parse`]. Label endpoints return
//! `{"status":"success","data":["app","namespace"]}`.

use std::collections::BTreeMap;

use anyhow::{anyhow, bail, Result};
use serde::Deserialize;
use serde_json::Value;

use crate::types::{LokiDirection, LokiLine, PromQuerySeries};

/// Parsed `data` of a successful query.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct LokiData {
    pub result_type: String,
    pub streams: Vec<BTreeMap<String, String>>,
    /// Merged over streams in the requested direction.
    pub lines: Vec<LokiLine>,
    pub series: Vec<PromQuerySeries>,
    pub warnings: Vec<String>,
}

#[derive(Deserialize)]
struct Envelope {
    status: String,
    #[serde(default)]
    data: Option<Value>,
    #[serde(default)]
    warnings: Vec<String>,
}

fn envelope(text: &str) -> Result<Envelope> {
    let envelope: Envelope = serde_json::from_str(text).map_err(|_| {
        anyhow!("the service did not answer like a Loki API (unexpected response body)")
    })?;
    if envelope.status != "success" {
        bail!(
            "{}",
            crate::prometheus::parse::error_message(text)
                .unwrap_or_else(|| "Loki returned an error".to_string())
        );
    }
    Ok(envelope)
}

/// Parse a 2xx `query_range` body; lines are merged over streams (newest
/// first for `backward`) and cut to `limit`.
pub fn parse_query(text: &str, direction: LokiDirection, limit: usize) -> Result<LokiData> {
    let envelope = envelope(text)?;
    let data = envelope
        .data
        .ok_or_else(|| anyhow!("the Loki response has no data"))?;
    let result_type = data
        .get("resultType")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("the Loki response has no result type"))?
        .to_string();
    if result_type != "streams" {
        // Metric queries answer like Prometheus.
        let prom = crate::prometheus::parse::parse_response(text)
            .map_err(|e| anyhow!("{}", e.to_string().replace("Prometheus", "Loki")))?;
        return Ok(LokiData {
            result_type,
            series: prom.series,
            warnings: envelope.warnings,
            ..Default::default()
        });
    }
    let mut streams = Vec::new();
    let mut entries: Vec<(i64, u32, String)> = Vec::new();
    for item in data
        .get("result")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        let labels: BTreeMap<String, String> = item
            .get("stream")
            .and_then(Value::as_object)
            .map(|m| {
                m.iter()
                    .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string())))
                    .collect()
            })
            .unwrap_or_default();
        let index = u32::try_from(streams.len()).unwrap_or(u32::MAX);
        let values = item
            .get("values")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();
        let before = entries.len();
        for value in values {
            if let Some((ts, line)) = entry(value) {
                entries.push((ts, index, line));
            }
        }
        if entries.len() > before {
            streams.push(labels);
        }
    }
    match direction {
        LokiDirection::Backward => entries.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1))),
        LokiDirection::Forward => entries.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1))),
    }
    entries.truncate(limit);
    Ok(LokiData {
        result_type,
        streams,
        lines: entries
            .into_iter()
            .map(|(ts, stream, line)| LokiLine {
                stream,
                ts: ts.to_string(),
                line,
            })
            .collect(),
        series: Vec::new(),
        warnings: envelope.warnings,
    })
}

/// `["1700000000123456789", "line", {…}?]` → `(ns, line)`.
fn entry(value: &Value) -> Option<(i64, String)> {
    let pair = value.as_array()?;
    let ts = match pair.first()? {
        Value::String(s) => s.trim().parse::<i64>().ok()?,
        Value::Number(n) => n.as_i64()?,
        _ => return None,
    };
    let line = pair.get(1)?.as_str()?;
    // Lines keep their text; a trailing newline would render as a blank row.
    Some((ts, line.trim_end_matches(['\n', '\r']).to_string()))
}

/// Parse a 2xx label or label values body (sorted, deduplicated).
pub fn parse_labels(text: &str) -> Result<Vec<String>> {
    let envelope = envelope(text)?;
    let mut labels: Vec<String> = match envelope.data {
        Some(Value::Array(items)) => items
            .into_iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect(),
        // An empty store answers without `data`.
        None | Some(Value::Null) => Vec::new(),
        Some(_) => bail!("the Loki response has no label list"),
    };
    labels.sort();
    labels.dedup();
    Ok(labels)
}

#[cfg(test)]
mod tests {
    use super::*;

    const STREAMS: &str = r#"{"status":"success","data":{"resultType":"streams","result":[
        {"stream":{"namespace":"shop","pod":"web-1","container":"nginx"},
         "values":[["1700000000300000001","GET /b 200\n"],["1700000000100000000","GET /a 200"]]},
        {"stream":{"namespace":"shop","pod":"web-2","container":"nginx"},
         "values":[["1700000000200000000","{\"level\":\"error\",\"msg\":\"boom\"}",{"structuredMetadata":{"trace_id":"abc"}}],
                   ["1700000000300000001","same nanosecond"],["bad","skipped"]]},
        {"stream":{"namespace":"shop","pod":"empty"},"values":[]}
    ],"stats":{"summary":{"bytesProcessedPerSecond":1}}}}"#;

    #[test]
    fn streams_merge_by_nanosecond_timestamp() {
        let data = parse_query(STREAMS, LokiDirection::Backward, 100).unwrap();
        assert_eq!(data.result_type, "streams");
        assert_eq!(data.streams.len(), 2, "streams without lines are dropped");
        assert_eq!(data.streams[1]["pod"], "web-2");
        let lines: Vec<(&str, u32, &str)> = data
            .lines
            .iter()
            .map(|l| (l.ts.as_str(), l.stream, l.line.as_str()))
            .collect();
        assert_eq!(
            lines,
            vec![
                ("1700000000300000001", 0, "GET /b 200"),
                ("1700000000300000001", 1, "same nanosecond"),
                (
                    "1700000000200000000",
                    1,
                    r#"{"level":"error","msg":"boom"}"#
                ),
                ("1700000000100000000", 0, "GET /a 200"),
            ]
        );
        let forward = parse_query(STREAMS, LokiDirection::Forward, 2).unwrap();
        assert_eq!(forward.lines.len(), 2, "cut to the limit");
        assert_eq!(forward.lines[0].ts, "1700000000100000000");
        assert_eq!(forward.lines[1].ts, "1700000000200000000");
    }

    #[test]
    fn metric_queries_return_series_in_milliseconds() {
        let body = r#"{"status":"success","data":{"resultType":"matrix","result":[
            {"metric":{"level":"error"},"values":[[1700000000,"3"],[1700000060.5,"0"]]}
        ]},"warnings":["query timed out partially"]}"#;
        let data = parse_query(body, LokiDirection::Backward, 10).unwrap();
        assert_eq!(data.result_type, "matrix");
        assert!(data.lines.is_empty());
        assert_eq!(data.series.len(), 1);
        assert_eq!(data.series[0].labels["level"], "error");
        assert_eq!(
            data.series[0].points,
            vec![(1_700_000_000_000, 3.0), (1_700_000_060_500, 0.0)]
        );
        assert_eq!(data.warnings, vec!["query timed out partially".to_string()]);
    }

    #[test]
    fn labels_and_errors() {
        assert_eq!(
            parse_labels(r#"{"status":"success","data":["pod","app","pod"]}"#).unwrap(),
            vec!["app", "pod"]
        );
        assert!(parse_labels(r#"{"status":"success"}"#).unwrap().is_empty());
        assert!(parse_labels(r#"{"status":"success","data":{"x":1}}"#).is_err());
        let err = parse_labels("<html>Grafana</html>")
            .unwrap_err()
            .to_string();
        assert!(err.contains("Loki API"), "{err}");
        let err = parse_query(
            r#"{"status":"error","errorType":"bad_data","error":"parse error"}"#,
            LokiDirection::Backward,
            1,
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("parse error"), "{err}");
        assert!(parse_query(r#"{"status":"success"}"#, LokiDirection::Backward, 1).is_err());
        let err = parse_query(
            r#"{"status":"success","data":{"resultType":"table","result":[]}}"#,
            LokiDirection::Backward,
            1,
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("Loki result type"), "{err}");
    }
}
