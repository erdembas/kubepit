//! Loki HTTP API requests: parameters of `query_range`, `labels` and
//! `label/{name}/values`, validation of what the UI sends, the tenant
//! header and the error of a non-2xx answer. Everything is a GET through
//! the service proxy ([`crate::service_proxy`]).

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{bail, Result};
use kube::Client;

use crate::error::ApiError;
use crate::service_proxy::{self, Endpoint};
use crate::types::{LokiDirection, LokiQuery, LokiService};

/// Upper bound for one range query (a week of logs can take a while).
pub const QUERY_TIMEOUT: Duration = Duration::from_secs(60);
/// Upper bound for label and label value requests.
pub const LABELS_TIMEOUT: Duration = Duration::from_secs(20);
/// Upper bound for the detection probe of one candidate.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(6);
/// Lines per query when the UI does not say.
pub const DEFAULT_LIMIT: u32 = 1_000;
/// Loki's default `max_entries_limit_per_query`.
pub const MAX_LIMIT: u32 = 5_000;
/// Longest accepted LogQL expression.
pub const MAX_QUERY_LEN: usize = 16 * 1024;
/// Points a metric query may ask for (Loki refuses more than 11 000).
const MAX_POINTS: i64 = 11_000;
/// `ApiError::reason` of errors Loki itself returned (bad query, tenant, …).
pub const LOKI_REASON: &str = "Loki";

pub const QUERY_RANGE_PATH: &str = "/loki/api/v1/query_range";
pub const LABELS_PATH: &str = "/loki/api/v1/labels";

const NANOS_PER_SEC: i64 = 1_000_000_000;

impl LokiService {
    /// Where the service proxy sends requests for this service.
    pub fn endpoint(&self) -> Endpoint<'_> {
        Endpoint {
            namespace: &self.namespace,
            service: &self.service,
            port: self.port,
            scheme: self.scheme,
            path_prefix: &self.path_prefix,
        }
    }
}

/// Now as a nanosecond Unix epoch.
pub fn now_ns() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_nanos()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}

/// A nanosecond Unix epoch sent by the UI as a decimal string.
pub fn parse_ns(value: &str, what: &str) -> Result<i64> {
    let value = value.trim();
    if value.is_empty() || value.len() > 19 || !value.bytes().all(|b| b.is_ascii_digit()) {
        bail!("the {what} time must be a nanosecond Unix timestamp");
    }
    Ok(value.parse()?)
}

/// `[a-zA-Z_][a-zA-Z0-9_]*`, the label names Loki accepts.
pub fn valid_label(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Validated `(start, end)` in nanoseconds.
pub fn range_ns(start: &str, end: &str) -> Result<(i64, i64)> {
    let start = parse_ns(start, "start")?;
    let end = parse_ns(end, "end")?;
    if end <= start {
        bail!("the time range is empty (end must be after start)");
    }
    Ok((start, end))
}

/// The line limit of `query` (default [`DEFAULT_LIMIT`], at most [`MAX_LIMIT`]).
pub fn effective_limit(query: &LokiQuery) -> u32 {
    query.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT)
}

/// Parameters of `/loki/api/v1/query_range` for `query`.
pub fn query_range_params(query: &LokiQuery) -> Result<Vec<(&'static str, String)>> {
    let logql = query.query.trim();
    if logql.is_empty() {
        bail!("enter a LogQL query");
    }
    if logql.len() > MAX_QUERY_LEN {
        bail!(
            "the query is too long (at most {} KiB)",
            MAX_QUERY_LEN / 1024
        );
    }
    let (start, end) = range_ns(&query.start, &query.end)?;
    let direction = match query.direction {
        LokiDirection::Backward => "backward",
        LokiDirection::Forward => "forward",
    };
    let mut params = vec![
        ("query", logql.to_string()),
        ("start", start.to_string()),
        ("end", end.to_string()),
        ("limit", effective_limit(query).to_string()),
        ("direction", direction.to_string()),
    ];
    if let Some(step) = query.step {
        // Never more points than Loki accepts for the range.
        let span_secs = (end - start) / NANOS_PER_SEC;
        let min_step = (span_secs + MAX_POINTS - 1) / MAX_POINTS;
        params.push(("step", step.max(min_step.max(1) as u64).to_string()));
    }
    Ok(params)
}

/// Parameters of the label endpoints (`query` narrows them to a selector).
pub fn labels_params(start: i64, end: i64, query: Option<&str>) -> Vec<(&'static str, String)> {
    let mut params = vec![("start", start.to_string()), ("end", end.to_string())];
    if let Some(query) = query.map(str::trim).filter(|q| !q.is_empty()) {
        params.push(("query", query.to_string()));
    }
    params
}

/// `/loki/api/v1/label/{name}/values`.
pub fn label_values_path(label: &str) -> Result<String> {
    if !valid_label(label) {
        bail!("\"{label}\" is not a valid label name");
    }
    Ok(format!("/loki/api/v1/label/{label}/values"))
}

/// Headers of every request: `X-Scope-OrgID` for a multi-tenant Loki.
pub fn tenant_headers(tenant: &str) -> Vec<(&'static str, &str)> {
    let tenant = tenant.trim();
    if tenant.is_empty() {
        Vec::new()
    } else {
        vec![("X-Scope-OrgID", tenant)]
    }
}

/// GET `path` and return the body of a 2xx answer; anything else becomes
/// an [`ApiError`] with the most useful message.
pub async fn get_json(
    client: &Client,
    path: &str,
    tenant: &str,
    timeout: Duration,
) -> Result<String> {
    let headers = tenant_headers(tenant);
    let response = service_proxy::get(client, path, &headers, timeout, "Loki").await?;
    if response.is_success() {
        return Ok(response.body);
    }
    Err(http_error(response.status, &response.body).into())
}

/// The error of a non-2xx answer. Loki answers bad queries, missing tenants
/// and limits with a plain-text (or JSON envelope) body; everything else —
/// Kubernetes `Status` bodies, gateway pages, 404/5xx — is the proxy path's.
pub fn http_error(code: u16, body: &str) -> ApiError {
    if let Some(message) = crate::prometheus::parse::error_message(body) {
        return ApiError {
            code,
            reason: LOKI_REASON.to_string(),
            message,
        };
    }
    let plain = !body.trim_start().starts_with(['{', '<']);
    if plain && matches!(code, 400 | 401 | 413 | 422 | 429) && !body.trim().is_empty() {
        let message: String = body
            .trim()
            .chars()
            .take(service_proxy::MAX_ERROR_BODY)
            .collect();
        return ApiError {
            code,
            reason: LOKI_REASON.to_string(),
            message,
        };
    }
    service_proxy::proxy_error(code, body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{LokiKind, PromScheme};

    fn query(q: &str, start: &str, end: &str) -> LokiQuery {
        LokiQuery {
            query: q.into(),
            start: start.into(),
            end: end.into(),
            limit: None,
            direction: LokiDirection::Backward,
            step: None,
        }
    }

    #[test]
    fn query_range_requests_are_built_with_nanosecond_bounds() {
        let service = LokiService {
            kind: LokiKind::Gateway,
            namespace: "loki".into(),
            service: "loki-gateway".into(),
            port: 80,
            scheme: PromScheme::Http,
            path_prefix: String::new(),
        };
        let q = query(
            r#" {namespace="shop", pod=~"web-.+"} |= "error" | json "#,
            "1700000000000000000",
            "1700003600123456789",
        );
        let params = query_range_params(&q).unwrap();
        let path = service_proxy::proxy_path(&service.endpoint(), QUERY_RANGE_PATH, &params);
        assert_eq!(
            path,
            "/api/v1/namespaces/loki/services/http:loki-gateway:80/proxy/loki/api/v1/query_range\
             ?query=%7Bnamespace%3D%22shop%22%2C%20pod%3D~%22web-.%2B%22%7D%20%7C%3D%20%22error%22%20%7C%20json\
             &start=1700000000000000000&end=1700003600123456789&limit=1000&direction=backward"
        );

        let forward = LokiQuery {
            limit: Some(99_999),
            direction: LokiDirection::Forward,
            step: Some(60),
            ..query("sum(count_over_time({a=\"b\"}[1m]))", "0", "86400000000000")
        };
        let params = query_range_params(&forward).unwrap();
        assert!(params.contains(&("limit", "5000".to_string())), "clamped");
        assert!(params.contains(&("direction", "forward".to_string())));
        assert!(params.contains(&("step", "60".to_string())));
        // A step too small for the range is raised (≤ 11 000 points).
        let week = LokiQuery {
            step: Some(1),
            ..query("x", "0", &(7 * 86_400 * NANOS_PER_SEC).to_string())
        };
        let params = query_range_params(&week).unwrap();
        assert!(params.contains(&("step", "55".to_string())), "{params:?}");
        let limit_zero = LokiQuery {
            limit: Some(0),
            ..query("x", "1", "2")
        };
        assert_eq!(effective_limit(&limit_zero), 1);
    }

    #[test]
    fn bad_queries_and_ranges_are_rejected() {
        assert!(query_range_params(&query("  ", "1", "2")).is_err());
        assert!(query_range_params(&query("x", "2", "1")).is_err());
        assert!(query_range_params(&query("x", "1.5", "2")).is_err());
        assert!(query_range_params(&query("x", "-1", "2")).is_err());
        assert!(query_range_params(&query("x", "1", "99999999999999999999")).is_err());
        let long = "x".repeat(MAX_QUERY_LEN + 1);
        assert!(query_range_params(&query(&long, "1", "2"))
            .unwrap_err()
            .to_string()
            .contains("too long"));
    }

    #[test]
    fn label_requests_and_tenant_headers() {
        assert_eq!(
            labels_params(1, 2, Some(r#" {namespace="a"} "#)),
            vec![
                ("start", "1".to_string()),
                ("end", "2".to_string()),
                ("query", r#"{namespace="a"}"#.to_string())
            ]
        );
        assert_eq!(labels_params(1, 2, Some("  ")).len(), 2);
        assert_eq!(
            label_values_path("namespace").unwrap(),
            "/loki/api/v1/label/namespace/values"
        );
        assert!(label_values_path("../x").is_err());
        assert!(label_values_path("9lives").is_err());
        assert!(valid_label("_a1"));
        assert!(tenant_headers("  ").is_empty());
        assert_eq!(
            tenant_headers(" team-a "),
            vec![("X-Scope-OrgID", "team-a")]
        );
        assert!(now_ns() > 1_600_000_000 * NANOS_PER_SEC);
    }

    #[test]
    fn errors_tell_loki_from_the_proxy_path() {
        let parse = http_error(
            400,
            "parse error at line 1, col 9: syntax error: unexpected IDENTIFIER\n",
        );
        assert_eq!(parse.reason, LOKI_REASON);
        assert!(parse.message.starts_with("parse error"));
        let tenant = http_error(401, "no org id");
        assert_eq!(tenant.reason, LOKI_REASON);
        let envelope = http_error(
            422,
            r#"{"status":"error","errorType":"bad_data","error":"max entries limit"}"#,
        );
        assert_eq!(envelope.reason, LOKI_REASON);
        assert_eq!(envelope.message, "bad_data: max entries limit");

        let gone = http_error(
            503,
            r#"{"kind":"Status","message":"no endpoints available for service \"loki-gateway\"","code":503}"#,
        );
        assert_eq!(gone.reason, service_proxy::PROXY_REASON);
        assert!(gone.message.contains("no endpoints"));
        let nginx = http_error(404, "<html>404 Not Found</html>");
        assert_eq!(nginx.reason, service_proxy::PROXY_REASON);
        let forbidden = http_error(
            403,
            r#"{"kind":"Status","message":"services \"loki:80\" is forbidden","code":403}"#,
        );
        assert_eq!(forbidden.reason, service_proxy::PROXY_REASON);
        assert_eq!(http_error(400, "").message, "HTTP 400");
    }
}
