//! Prometheus HTTP API responses (`/api/v1/query`, `/api/v1/query_range`).
//!
//! ```json
//! {"status":"success","data":{"resultType":"matrix","result":[
//!   {"metric":{"pod":"web-1"},"values":[[1700000000,"0.25"],[1700000015,"NaN"]]}]},
//!  "warnings":["…"]}
//! ```
//!
//! Sample values are strings; `NaN` and `±Inf` are dropped so they show up
//! as gaps instead of breaking JSON (serde would turn them into `null`).
//! Timestamps are float seconds and become epoch milliseconds. Errors
//! (`{"status":"error","errorType":"bad_data","error":"…"}`) become the
//! server's own message.

use std::collections::BTreeMap;

use anyhow::{anyhow, bail, Result};
use serde::Deserialize;
use serde_json::Value;

use crate::types::{PromPoint, PromQuerySeries};

/// Parsed `data` of a successful response.
#[derive(Debug, Clone, PartialEq)]
pub struct PromData {
    pub result_type: String,
    pub series: Vec<PromQuerySeries>,
    pub warnings: Vec<String>,
}

#[derive(Deserialize)]
struct Envelope {
    status: String,
    #[serde(default)]
    data: Option<Data>,
    #[serde(default, rename = "errorType")]
    error_type: Option<String>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    warnings: Vec<String>,
}

#[derive(Deserialize)]
struct Data {
    #[serde(rename = "resultType")]
    result_type: String,
    #[serde(default)]
    result: Value,
}

/// The `error` of a Prometheus error body, if `text` is one.
pub fn error_message(text: &str) -> Option<String> {
    let envelope: Envelope = serde_json::from_str(text).ok()?;
    if envelope.status != "error" {
        return None;
    }
    let message = envelope.error.unwrap_or_default();
    Some(match envelope.error_type {
        Some(kind) if !kind.is_empty() && !message.is_empty() => format!("{kind}: {message}"),
        _ if !message.is_empty() => message,
        _ => "Prometheus returned an error".to_string(),
    })
}

/// Parse a 2xx response body.
pub fn parse_response(text: &str) -> Result<PromData> {
    let envelope: Envelope = serde_json::from_str(text).map_err(|_| {
        anyhow!("the service did not answer like a Prometheus API (unexpected response body)")
    })?;
    if envelope.status != "success" {
        bail!(
            "{}",
            error_message(text).unwrap_or_else(|| "Prometheus returned an error".to_string())
        );
    }
    let data = envelope
        .data
        .ok_or_else(|| anyhow!("the Prometheus response has no data"))?;
    let series = match data.result_type.as_str() {
        "matrix" => items(&data.result)
            .iter()
            .map(|item| series(item, item.get("values").map(samples).unwrap_or_default()))
            .collect(),
        "vector" => items(&data.result)
            .iter()
            .map(|item| {
                series(
                    item,
                    item.get("value").and_then(sample).into_iter().collect(),
                )
            })
            .collect(),
        "scalar" => vec![PromQuerySeries {
            labels: BTreeMap::new(),
            points: sample(&data.result).into_iter().collect(),
        }],
        // Strings have no numeric value to chart.
        "string" => Vec::new(),
        other => bail!("unsupported Prometheus result type \"{other}\""),
    };
    Ok(PromData {
        result_type: data.result_type,
        series,
        warnings: envelope.warnings,
    })
}

fn items(result: &Value) -> &[Value] {
    result.as_array().map(Vec::as_slice).unwrap_or_default()
}

fn series(item: &Value, points: Vec<PromPoint>) -> PromQuerySeries {
    let labels = item
        .get("metric")
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string())))
                .collect()
        })
        .unwrap_or_default();
    PromQuerySeries { labels, points }
}

fn samples(values: &Value) -> Vec<PromPoint> {
    items(values).iter().filter_map(sample).collect()
}

/// `[1700000000.123, "0.5"]` → `(1700000000123, 0.5)`; non-finite → `None`.
fn sample(pair: &Value) -> Option<PromPoint> {
    let pair = pair.as_array()?;
    let ts = pair.first()?.as_f64()?;
    let value = match pair.get(1)? {
        Value::String(s) => parse_value(s)?,
        Value::Number(n) => n.as_f64()?,
        _ => return None,
    };
    value
        .is_finite()
        .then_some(((ts * 1000.0).round() as i64, value))
}

fn parse_value(text: &str) -> Option<f64> {
    match text {
        "NaN" | "+Inf" | "-Inf" | "Inf" => None,
        _ => text.parse().ok(),
    }
}

/// Add series together per timestamp (a preset query should return one
/// series; stray label sets must not duplicate points).
pub fn sum_series(series: &[PromQuerySeries]) -> Vec<PromPoint> {
    match series {
        [] => Vec::new(),
        [only] => only.points.clone(),
        many => {
            let mut totals: BTreeMap<i64, f64> = BTreeMap::new();
            for s in many {
                for &(ts, v) in &s.points {
                    *totals.entry(ts).or_default() += v;
                }
            }
            totals.into_iter().collect()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matrix_with_nan_and_inf_leaves_gaps() {
        let body = r#"{"status":"success","data":{"resultType":"matrix","result":[
            {"metric":{"__name__":"up","pod":"web-1"},
             "values":[[1700000000,"1"],[1700000015,"NaN"],[1700000030.5,"+Inf"],[1700000045,"0.25"]]},
            {"metric":{},"values":[]}
        ]}}"#;
        let data = parse_response(body).unwrap();
        assert_eq!(data.result_type, "matrix");
        assert_eq!(data.series.len(), 2);
        let first = &data.series[0];
        assert_eq!(first.labels.get("pod").map(String::as_str), Some("web-1"));
        assert_eq!(first.labels.get("__name__").map(String::as_str), Some("up"));
        assert_eq!(
            first.points,
            vec![(1_700_000_000_000, 1.0), (1_700_000_045_000, 0.25)]
        );
        assert!(data.series[1].points.is_empty());
    }

    #[test]
    fn vector_scalar_and_string_results() {
        let vector = r#"{"status":"success","data":{"resultType":"vector","result":[
            {"metric":{"node":"n1"},"value":[1700000000.25,"3.5"]},
            {"metric":{"node":"n2"},"value":[1700000000.25,"-Inf"]}
        ]}}"#;
        let data = parse_response(vector).unwrap();
        assert_eq!(data.series.len(), 2);
        assert_eq!(data.series[0].points, vec![(1_700_000_000_250, 3.5)]);
        assert!(data.series[1].points.is_empty(), "-Inf is dropped");

        let scalar =
            r#"{"status":"success","data":{"resultType":"scalar","result":[1700000000,"1"]}}"#;
        let data = parse_response(scalar).unwrap();
        assert_eq!(data.series.len(), 1);
        assert!(data.series[0].labels.is_empty());
        assert_eq!(data.series[0].points, vec![(1_700_000_000_000, 1.0)]);

        let string = r#"{"status":"success","data":{"resultType":"string","result":[1,"hi"]}}"#;
        assert!(parse_response(string).unwrap().series.is_empty());
    }

    #[test]
    fn empty_results_and_warnings() {
        let body = r#"{"status":"success","data":{"resultType":"matrix","result":[]},
                       "warnings":["partial response"]}"#;
        let data = parse_response(body).unwrap();
        assert!(data.series.is_empty());
        assert_eq!(data.warnings, vec!["partial response".to_string()]);
    }

    #[test]
    fn errors_use_the_server_message() {
        let body = r#"{"status":"error","errorType":"bad_data","error":"1:5: parse error: unexpected end of input"}"#;
        assert_eq!(
            error_message(body).as_deref(),
            Some("bad_data: 1:5: parse error: unexpected end of input")
        );
        let err = parse_response(body).unwrap_err().to_string();
        assert!(err.contains("parse error"), "{err}");
        assert!(error_message(r#"{"status":"success"}"#).is_none());
        assert!(error_message("<html>").is_none());

        let err = parse_response("<html>Grafana</html>")
            .unwrap_err()
            .to_string();
        assert!(err.contains("Prometheus API"), "{err}");
        assert!(parse_response(r#"{"status":"success"}"#).is_err());
        assert!(parse_response(
            r#"{"status":"success","data":{"resultType":"table","result":[]}}"#
        )
        .is_err());
    }

    #[test]
    fn stray_series_are_summed_per_timestamp() {
        let s = |points: Vec<PromPoint>| PromQuerySeries {
            labels: BTreeMap::new(),
            points,
        };
        assert!(sum_series(&[]).is_empty());
        assert_eq!(sum_series(&[s(vec![(1, 2.0)])]), vec![(1, 2.0)]);
        assert_eq!(
            sum_series(&[s(vec![(1, 2.0), (2, 1.0)]), s(vec![(2, 3.0), (3, 1.0)])]),
            vec![(1, 2.0), (2, 4.0), (3, 1.0)]
        );
    }
}
