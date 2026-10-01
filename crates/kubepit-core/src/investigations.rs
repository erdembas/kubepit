//! Saved incident investigations: bounded, frozen, redacted evidence in a
//! versioned local file. Nothing here changes a Kubernetes resource.

mod capture;
mod storage;

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

use crate::types::Gvk;

pub const MAX_BUNDLE_BYTES: usize = 1024 * 1024;
pub const MAX_EVIDENCE_BYTES: usize = 64 * 1024;
pub const MAX_EVIDENCE: usize = 32;
pub const MAX_INVESTIGATIONS: usize = 50;
pub const MAX_TITLE_BYTES: usize = 200;
pub const MAX_NOTES_BYTES: usize = 32 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InvestigationCaptureRequest {
    pub gvk: Gvk,
    pub namespace: String,
    pub name: String,
    pub title: String,
    pub lookback_minutes: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EvidenceKind {
    Object,
    Pods,
    Events,
    Logs,
    Changes,
    Metrics,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EvidenceStatus {
    Captured,
    Empty,
    Unavailable,
    Truncated,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EvidenceFormat {
    Yaml,
    Json,
    Text,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EvidenceReason {
    Timeout,
    Forbidden,
    NotFound,
    NotAvailable,
    NoPods,
    NotRecording,
    CaptureLimit,
    RequestFailed,
    NoSelector,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InvestigationEvidence {
    pub id: String,
    pub kind: EvidenceKind,
    pub label: String,
    pub status: EvidenceStatus,
    pub format: EvidenceFormat,
    pub content: String,
    pub reason: Option<EvidenceReason>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InvestigationTarget {
    pub api_version: String,
    pub kind: String,
    pub namespace: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InvestigationSummary {
    pub id: String,
    pub title: String,
    pub cluster_id: Option<String>,
    pub cluster_name: String,
    pub target: InvestigationTarget,
    pub captured_at: i64,
    pub updated_at: i64,
    pub imported: bool,
    pub evidence_count: usize,
    pub incomplete_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Investigation {
    pub version: u32,
    pub id: String,
    pub title: String,
    pub cluster_id: Option<String>,
    pub cluster_name: String,
    pub target: InvestigationTarget,
    pub captured_at: i64,
    pub updated_at: i64,
    pub imported: bool,
    pub evidence_count: usize,
    pub incomplete_count: usize,
    pub notes: String,
    pub lookback_minutes: u32,
    pub evidence: Vec<InvestigationEvidence>,
}

impl Investigation {
    pub fn summary(&self) -> InvestigationSummary {
        InvestigationSummary {
            id: self.id.clone(),
            title: self.title.clone(),
            cluster_id: self.cluster_id.clone(),
            cluster_name: self.cluster_name.clone(),
            target: self.target.clone(),
            captured_at: self.captured_at,
            updated_at: self.updated_at,
            imported: self.imported,
            evidence_count: self.evidence.len(),
            incomplete_count: self
                .evidence
                .iter()
                .filter(|e| {
                    matches!(
                        e.status,
                        EvidenceStatus::Unavailable | EvidenceStatus::Truncated
                    )
                })
                .count(),
        }
    }

    fn refresh_counts(&mut self) {
        let summary = self.summary();
        self.evidence_count = summary.evidence_count;
        self.incomplete_count = summary.incomplete_count;
    }
}

fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn validate_text(value: &str, max: usize, required: bool) -> Result<()> {
    if value.len() > max || (required && value.trim().is_empty()) || value.contains('\0') {
        bail!("investigations:invalid-data");
    }
    Ok(())
}
