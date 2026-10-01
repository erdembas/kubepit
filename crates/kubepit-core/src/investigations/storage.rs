use std::collections::HashSet;
use std::io::Read;
use std::sync::LazyLock;

use anyhow::{bail, Context, Result};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::*;
use crate::ai::redact::{
    redact_manifest_text, redact_message, redact_value, Pseudonyms, RedactOptions, SECRET_MARKER,
};
use crate::paths::{atomic_write, validate_id};
use crate::Kubepit;

const MAX_STORE_BYTES: usize = 20 * 1024 * 1024;
// Local operations are short, synchronous and serialized across app windows.
// The Tauri adapter runs them on the blocking pool. Capture holds no lock
// while talking to Kubernetes. Paths are read afresh, so restarts and two
// Kubepit instances in a fixture see the same persisted records.
static MUTATION: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
const REDACTION: RedactOptions = RedactOptions {
    tokens: true,
    ips: false,
    hostnames: false,
};

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct InvestigationFile {
    version: u32,
    items: Vec<Investigation>,
}

pub(super) fn safe_text(text: &str) -> String {
    redact_message(text, &REDACTION, &mut Pseudonyms::default()).0
}

/// Capture never needs literal environment values or arbitrary annotations.
/// Remove them even when their names do not look credential-related.
fn strip_literals(value: &mut Value) {
    match value {
        Value::Object(map) => {
            if let Some(meta) = map.get_mut("metadata").and_then(Value::as_object_mut) {
                meta.remove("annotations");
                meta.remove("managedFields");
            }
            if let Some(env) = map.get_mut("env").and_then(Value::as_array_mut) {
                for entry in env {
                    if let Some(entry) = entry.as_object_mut() {
                        if entry.contains_key("value") {
                            entry.insert("value".into(), Value::String(SECRET_MARKER.into()));
                        }
                    }
                }
            }
            for value in map.values_mut() {
                strip_literals(value);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(strip_literals),
        _ => {}
    }
}

pub(super) fn safe_value(value: &Value) -> Value {
    let mut value = value.clone();
    strip_literals(&mut value);
    redact_value(&value, &REDACTION, &mut Pseudonyms::default()).0
}

pub(super) fn limit_content(text: &mut String) -> bool {
    if text.len() <= MAX_EVIDENCE_BYTES {
        return false;
    }
    let mut boundary = MAX_EVIDENCE_BYTES;
    while !text.is_char_boundary(boundary) {
        boundary -= 1;
    }
    text.truncate(boundary);
    true
}

fn validate(record: &Investigation) -> Result<()> {
    if record.version != 1 {
        bail!("investigations:unsupported-version");
    }
    validate_id(&record.id).map_err(|_| anyhow::anyhow!("investigations:invalid-data"))?;
    if let Some(id) = &record.cluster_id {
        validate_text(id, 128, true)?;
    }
    validate_text(&record.title, MAX_TITLE_BYTES, true)?;
    validate_text(&record.notes, MAX_NOTES_BYTES, false)?;
    validate_text(&record.cluster_name, 256, true)?;
    for value in [
        &record.target.api_version,
        &record.target.kind,
        &record.target.namespace,
        &record.target.name,
    ] {
        validate_text(value, 256, true)?;
    }
    if !matches!(record.lookback_minutes, 15 | 60)
        || record.captured_at < 0
        || record.captured_at > now() + 86_400_000
        || record.updated_at < 0
        || record.updated_at > now() + 86_400_000
        || record.evidence.is_empty()
        || record.evidence.len() > MAX_EVIDENCE
    {
        bail!("investigations:invalid-data");
    }
    let mut ids = HashSet::new();
    for evidence in &record.evidence {
        validate_text(&evidence.id, 128, true)?;
        validate_text(&evidence.label, 512, true)?;
        validate_text(&evidence.content, MAX_EVIDENCE_BYTES, false)?;
        if !ids.insert(&evidence.id)
            || (matches!(
                evidence.status,
                EvidenceStatus::Unavailable | EvidenceStatus::Empty
            ) && !evidence.content.is_empty())
        {
            bail!("investigations:invalid-data");
        }
    }
    if serde_json::to_vec(record)?.len() > MAX_BUNDLE_BYTES {
        bail!("investigations:bundle-too-large");
    }
    Ok(())
}

/// Imports cannot claim they were already redacted. Every textual surface,
/// including title, notes and source labels, goes through the same policy.
pub(super) fn sanitize(mut record: Investigation) -> Result<Investigation> {
    validate(&record)?;
    record.title = safe_text(&record.title);
    record.notes = safe_text(&record.notes);
    record.cluster_name = safe_text(&record.cluster_name);
    record.target.api_version = safe_text(&record.target.api_version);
    record.target.kind = safe_text(&record.target.kind);
    record.target.namespace = safe_text(&record.target.namespace);
    record.target.name = safe_text(&record.target.name);
    for evidence in &mut record.evidence {
        evidence.id = safe_text(&evidence.id);
        evidence.label = safe_text(&evidence.label);
        evidence.content = match evidence.format {
            EvidenceFormat::Text => safe_text(&evidence.content),
            EvidenceFormat::Json => match serde_json::from_str::<Value>(&evidence.content) {
                Ok(value) => serde_json::to_string_pretty(&safe_value(&value))?,
                Err(_) => {
                    redact_manifest_text(&evidence.content, &REDACTION, &mut Pseudonyms::default())
                        .0
                }
            },
            EvidenceFormat::Yaml => match serde_yaml::from_str::<Value>(&evidence.content) {
                Ok(value) if !evidence.content.is_empty() => {
                    serde_yaml::to_string(&safe_value(&value))?
                }
                _ => {
                    redact_manifest_text(&evidence.content, &REDACTION, &mut Pseudonyms::default())
                        .0
                }
            },
        };
        if limit_content(&mut evidence.content) {
            evidence.status = EvidenceStatus::Truncated;
            evidence.reason = Some(EvidenceReason::CaptureLimit);
        }
    }
    record.refresh_counts();
    validate(&record)?;
    Ok(record)
}

impl Kubepit {
    fn read_investigations(&self) -> Result<InvestigationFile> {
        let path = self.paths().root().join("investigations.json");
        let file = match std::fs::File::open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(InvestigationFile {
                    version: 1,
                    items: Vec::new(),
                })
            }
            Err(error) => return Err(error.into()),
        };
        let mut bytes = Vec::new();
        file.take(MAX_STORE_BYTES as u64 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > MAX_STORE_BYTES {
            bail!("investigations:store-too-large");
        }
        let mut data: InvestigationFile =
            serde_json::from_slice(&bytes).context("investigations:invalid-data")?;
        if data.version != 1 {
            bail!("investigations:unsupported-version");
        }
        if data.items.len() > MAX_INVESTIGATIONS {
            bail!("investigations:store-too-large");
        }
        let mut ids = HashSet::new();
        for item in &data.items {
            validate(item)?;
            if !ids.insert(&item.id) {
                bail!("investigations:invalid-data");
            }
        }
        // Treat a locally edited file exactly like an imported one.
        data.items = data
            .items
            .into_iter()
            .map(sanitize)
            .collect::<Result<_>>()?;
        Ok(data)
    }

    fn write_investigations(&self, data: &InvestigationFile) -> Result<()> {
        let bytes = serde_json::to_vec(data)?;
        if bytes.len() > MAX_STORE_BYTES {
            bail!("investigations:store-too-large");
        }
        atomic_write(
            &self.paths().root().join("investigations.json"),
            &bytes,
            true,
        )
    }

    pub(super) fn save_investigation(&self, record: Investigation) -> Result<Investigation> {
        let record = sanitize(record)?;
        let _guard = MUTATION.lock();
        let mut data = self.read_investigations()?;
        if data.items.len() >= MAX_INVESTIGATIONS {
            bail!("investigations:limit-reached");
        }
        data.items.push(record.clone());
        self.write_investigations(&data)?;
        Ok(record)
    }

    pub fn investigations_list(
        &self,
        cluster_id: Option<&str>,
    ) -> Result<Vec<InvestigationSummary>> {
        let _guard = MUTATION.lock();
        let data = self.read_investigations()?;
        let mut records: Vec<_> = data
            .items
            .iter()
            .filter(|item| {
                cluster_id.is_none()
                    || item.cluster_id.is_none()
                    || item.cluster_id.as_deref() == cluster_id
            })
            .map(Investigation::summary)
            .collect();
        records.sort_by_key(|item| std::cmp::Reverse(item.updated_at));
        Ok(records)
    }

    pub fn investigation_get(&self, id: &str) -> Result<Investigation> {
        let _guard = MUTATION.lock();
        self.read_investigations()?
            .items
            .into_iter()
            .find(|record| record.id == id)
            .context("investigations:not-found")
    }

    pub fn investigation_update(
        &self,
        id: &str,
        title: &str,
        notes: &str,
    ) -> Result<Investigation> {
        validate_text(title, MAX_TITLE_BYTES, true)?;
        validate_text(notes, MAX_NOTES_BYTES, false)?;
        let _guard = MUTATION.lock();
        let mut data = self.read_investigations()?;
        let index = data
            .items
            .iter()
            .position(|record| record.id == id)
            .context("investigations:not-found")?;
        // Evidence never changes when notes or a title are edited.
        let record = &mut data.items[index];
        record.title = safe_text(title.trim());
        record.notes = safe_text(notes);
        record.updated_at = now();
        validate(record)?;
        let record = record.clone();
        self.write_investigations(&data)?;
        Ok(record)
    }

    pub fn investigation_delete(&self, id: &str) -> Result<()> {
        let _guard = MUTATION.lock();
        let mut data = self.read_investigations()?;
        data.items.retain(|record| record.id != id);
        self.write_investigations(&data)
    }

    pub fn investigation_export(
        &self,
        id: &str,
        evidence_ids: Option<&[String]>,
    ) -> Result<String> {
        let mut record = sanitize(self.investigation_get(id)?)?;
        if let Some(ids) = evidence_ids {
            if ids.is_empty()
                || ids.len() > MAX_EVIDENCE
                || ids
                    .iter()
                    .any(|id| !record.evidence.iter().any(|evidence| &evidence.id == id))
            {
                bail!("investigations:invalid-data");
            }
            record
                .evidence
                .retain(|evidence| ids.contains(&evidence.id));
            record.refresh_counts();
        }
        // The portable bundle carries the display name, never credentials,
        // source paths or a local cluster registry association.
        record.cluster_id = None;
        let text = serde_json::to_string_pretty(&record)?;
        if text.len() > MAX_BUNDLE_BYTES {
            bail!("investigations:bundle-too-large");
        }
        Ok(text)
    }

    pub fn investigation_import(&self, bundle: &str) -> Result<Investigation> {
        if bundle.len() > MAX_BUNDLE_BYTES {
            bail!("investigations:bundle-too-large");
        }
        let mut record: Investigation =
            serde_json::from_str(bundle).context("investigations:invalid-data")?;
        validate(&record)?;
        record.id = uuid::Uuid::new_v4().to_string();
        record.cluster_id = None;
        record.imported = true;
        record.updated_at = now();
        self.save_investigation(record)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{NullSink, Paths};
    use serde_json::json;
    use std::sync::Arc;

    fn sample() -> Investigation {
        Investigation {
            version: 1, id: "one".into(), title: "Checkout".into(), cluster_id: Some("cluster".into()), cluster_name: "Production".into(),
            target: InvestigationTarget { api_version: "v1".into(), kind: "Pod".into(), namespace: "checkout".into(), name: "api".into() },
            captured_at: now(), updated_at: now(), imported: false, evidence_count: 1, incomplete_count: 0, notes: String::new(), lookback_minutes: 15,
            evidence: vec![InvestigationEvidence { id: "object".into(), kind: EvidenceKind::Object, label: "Pod/api".into(), status: EvidenceStatus::Captured, format: EvidenceFormat::Json,
                content: json!({"apiVersion":"v1","kind":"Pod","metadata":{"name":"api","annotations":{"anything":"annotation-secret"}},"spec":{"containers":[{"name":"app","env":[{"name":"NONOBVIOUS","value":"literal-secret"},{"name":"PASSWORD","value":"password-secret"}]}]}}).to_string(), reason: None }],
        }
    }

    #[test]
    fn reopen_edit_and_export_keep_frozen_redacted_evidence() {
        let dir = tempfile::tempdir().unwrap();
        let core = Kubepit::open(Paths::new(dir.path()), Arc::new(NullSink)).unwrap();
        let saved = core.save_investigation(sample()).unwrap();
        let contents = std::fs::read_to_string(dir.path().join("investigations.json")).unwrap();
        for secret in ["literal-secret", "password-secret", "annotation-secret"] {
            assert!(!contents.contains(secret));
        }
        drop(core);
        let core = Kubepit::open(Paths::new(dir.path()), Arc::new(NullSink)).unwrap();
        let edited = core
            .investigation_update(&saved.id, "Reviewed", "password=note-secret")
            .unwrap();
        assert_eq!(edited.evidence[0].content, saved.evidence[0].content);
        assert!(!edited.notes.contains("note-secret"));
        let export = core.investigation_export(&saved.id, None).unwrap();
        let imported = core.investigation_import(&export).unwrap();
        assert_ne!(imported.id, saved.id);
        assert!(imported.cluster_id.is_none());
        assert!(imported.imported);
        assert_eq!(core.investigations_list(None).unwrap().len(), 2);
        core.investigation_delete(&saved.id).unwrap();
        assert!(core.investigation_get(&saved.id).is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(dir.path().join("investigations.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn imports_are_validated_and_redacted_again() {
        let dir = tempfile::tempdir().unwrap();
        let core = Kubepit::open(Paths::new(dir.path()), Arc::new(NullSink)).unwrap();
        let mut record = sample();
        record.evidence[0].content = json!({"kind":"Secret","data":{"key":"c2VjcmV0"}}).to_string();
        let imported = core
            .investigation_import(&serde_json::to_string(&record).unwrap())
            .unwrap();
        assert!(!imported.evidence[0].content.contains("c2VjcmV0"));
        record.version = 2;
        assert!(core
            .investigation_import(&serde_json::to_string(&record).unwrap())
            .is_err());
        record.version = 1;
        record.evidence.push(record.evidence[0].clone());
        assert!(core
            .investigation_import(&serde_json::to_string(&record).unwrap())
            .is_err());
        assert!(core
            .investigation_import(&"x".repeat(MAX_BUNDLE_BYTES + 1))
            .is_err());
        assert_eq!(core.investigations_list(None).unwrap().len(), 1);
    }

    #[test]
    fn corrupt_store_is_preserved_and_unicode_truncates_safely() {
        let dir = tempfile::tempdir().unwrap();
        let core = Kubepit::open(Paths::new(dir.path()), Arc::new(NullSink)).unwrap();
        std::fs::write(dir.path().join("investigations.json"), "{bad").unwrap();
        assert!(core.save_investigation(sample()).is_err());
        assert_eq!(
            std::fs::read_to_string(dir.path().join("investigations.json")).unwrap(),
            "{bad"
        );
        let mut text = "ışık".repeat(MAX_EVIDENCE_BYTES);
        assert!(limit_content(&mut text));
        assert!(text.len() <= MAX_EVIDENCE_BYTES);
    }
}
