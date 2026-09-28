//! The deprecated-API table (`deprecated_apis.json`, shared with the UI)
//! and the version arithmetic around it.
//!
//! Versions are Kubernetes minors (`1.22`); everything below compares
//! `(major, minor)` pairs, so `v1.31.4-eks-2d98532` and `1.31` are equal.

use std::sync::LazyLock;

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

/// One deprecated `apiVersion` + `kind`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeprecatedApi {
    pub api_version: String,
    pub kind: String,
    /// Plural resource name (what `apiserver_requested_deprecated_apis` reports).
    pub resource: String,
    pub deprecated_in: String,
    /// `None` while no removal is scheduled.
    pub removed_in: Option<String>,
    /// Replacement `apiVersion`; `None` when the API has no successor.
    pub replacement: Option<String>,
    /// Set when the replacement is a different kind (`Endpoints` → `EndpointSlice`).
    #[serde(default)]
    pub replacement_kind: Option<String>,
    /// Note codes the UI explains (`ingress_fields`, `psa`, …).
    #[serde(default)]
    pub notes: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct TableFile {
    updated: String,
    checked_through: String,
    no_removals: Vec<String>,
    entries: Vec<DeprecatedApi>,
}

static TABLE: LazyLock<TableFile> = LazyLock::new(|| {
    serde_json::from_str(include_str!("deprecated_apis.json"))
        .expect("deprecated_apis.json is valid (checked by tests)")
});

/// Every entry of the table.
pub fn table() -> &'static [DeprecatedApi] {
    &TABLE.entries
}

/// When the table was last reviewed (`YYYY-MM-DD`).
pub fn table_updated() -> &'static str {
    &TABLE.updated
}

/// The newest minor whose deprecation guide and release notes were checked
/// (`1.37`); later minors may remove APIs the table does not list yet.
pub fn table_checked_through() -> &'static str {
    &TABLE.checked_through
}

/// Minors checked and found to stop serving no beta or GA API.
pub fn no_removals() -> &'static [String] {
    &TABLE.no_removals
}

/// The entry for exactly this `apiVersion` + `kind`.
pub fn lookup(api_version: &str, kind: &str) -> Option<&'static DeprecatedApi> {
    table()
        .iter()
        .find(|e| e.api_version == api_version && e.kind == kind)
}

/// The entry for an `apiVersion` + plural resource (metrics labels).
pub fn lookup_resource(api_version: &str, resource: &str) -> Option<&'static DeprecatedApi> {
    table()
        .iter()
        .find(|e| e.api_version == api_version && e.resource == resource)
}

/// A Kubernetes minor version.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Minor {
    pub major: u32,
    pub minor: u32,
}

impl Minor {
    pub const fn new(major: u32, minor: u32) -> Self {
        Self { major, minor }
    }

    /// `v1.31.4-eks-2d98532`, `1.31`, `1.31.0`, `v1.31+` → `1.31`.
    pub fn parse(raw: &str) -> Option<Self> {
        let v = raw.trim().trim_start_matches(['v', 'V']);
        let mut parts = v.split('.');
        let major = digits(parts.next()?)?;
        let minor = digits(parts.next()?)?;
        Some(Self { major, minor })
    }

    /// The release after this one.
    pub fn next(self) -> Self {
        Self::new(self.major, self.minor + 1)
    }
}

/// Leading digits of a version part (`31+` and `31-gke` → 31).
fn digits(part: &str) -> Option<u32> {
    let end = part
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(part.len());
    part[..end].parse().ok()
}

impl std::fmt::Display for Minor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}", self.major, self.minor)
    }
}

/// A target version as the user typed it; must name a 1.x minor.
pub fn parse_target(raw: &str) -> Result<Minor> {
    match Minor::parse(raw) {
        Some(m) if m.major == 1 && m.minor <= 99 => Ok(m),
        _ => bail!(
            "invalid target version \"{}\": use a version such as 1.32",
            raw.trim()
        ),
    }
}

/// How an entry affects an upgrade to `target`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Impact {
    /// No longer served in `target`.
    Removed {
        /// Already not served by the current version.
        already: bool,
    },
    /// Still served in `target`, but deprecated by then.
    Deprecated,
}

/// `None` when the entry is not deprecated yet in `target`.
pub fn impact(entry: &DeprecatedApi, current: Minor, target: Minor) -> Option<Impact> {
    if let Some(removed) = entry.removed_in.as_deref().and_then(Minor::parse) {
        if removed <= target {
            return Some(Impact::Removed {
                already: removed <= current,
            });
        }
    }
    let deprecated = Minor::parse(&entry.deprecated_in)?;
    (deprecated <= target).then_some(Impact::Deprecated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn table_is_consistent() {
        assert!(table().len() >= 50);
        assert!(table_updated().len() == 10, "{}", table_updated());
        let mut seen = HashSet::new();
        for e in table() {
            assert!(
                seen.insert((e.api_version.as_str(), e.kind.as_str())),
                "duplicate {} {}",
                e.api_version,
                e.kind
            );
            let deprecated = Minor::parse(&e.deprecated_in).expect("deprecated_in");
            if let Some(removed) = &e.removed_in {
                let removed = Minor::parse(removed).expect("removed_in");
                assert!(deprecated < removed, "{} {}", e.api_version, e.kind);
            }
            assert!(!e.resource.is_empty() && e.resource == e.resource.to_lowercase());
            if let Some(r) = &e.replacement {
                assert_ne!(r, &e.api_version);
            }
        }
        // Spot checks against the deprecation guide.
        let ingress = lookup("extensions/v1beta1", "Ingress").unwrap();
        assert_eq!(ingress.removed_in.as_deref(), Some("1.22"));
        assert_eq!(ingress.replacement.as_deref(), Some("networking.k8s.io/v1"));
        let psp = lookup("policy/v1beta1", "PodSecurityPolicy").unwrap();
        assert_eq!(psp.replacement, None);
        assert_eq!(
            lookup_resource("batch/v1beta1", "cronjobs").unwrap().kind,
            "CronJob"
        );
        assert_eq!(
            lookup("flowcontrol.apiserver.k8s.io/v1beta3", "FlowSchema")
                .unwrap()
                .removed_in
                .as_deref(),
            Some("1.32")
        );
        assert!(lookup("apps/v1", "Deployment").is_none());
    }

    #[test]
    fn table_accounts_for_every_minor() {
        let through = Minor::parse(table_checked_through()).expect("checked_through parses");
        let removed: HashSet<String> = table()
            .iter()
            .filter_map(|e| e.removed_in.clone())
            .collect();
        let quiet: HashSet<&str> = no_removals().iter().map(String::as_str).collect();
        let newest = table()
            .iter()
            .flat_map(|e| [Some(&e.deprecated_in), e.removed_in.as_ref()])
            .flatten()
            .filter_map(|v| Minor::parse(v))
            .max()
            .unwrap();
        assert!(
            through >= newest,
            "checked_through {through} is older than {newest}"
        );
        let mut minor = Minor::parse("1.16").unwrap();
        while minor <= through {
            let v = minor.to_string();
            assert!(
                removed.contains(&v) ^ quiet.contains(v.as_str()),
                "{v}: removed_in xor no_removals"
            );
            minor = minor.next();
        }
        assert!(quiet
            .iter()
            .all(|v| Minor::parse(v).is_some_and(|m| m <= through)));
    }

    #[test]
    fn versions_parse_and_compare() {
        assert_eq!(Minor::parse("v1.31.4-eks-2d98532"), Some(Minor::new(1, 31)));
        assert_eq!(Minor::parse("1.31"), Some(Minor::new(1, 31)));
        assert_eq!(Minor::parse("v1.30+"), Some(Minor::new(1, 30)));
        assert_eq!(Minor::parse("v1.29.6+a3bd6e5"), Some(Minor::new(1, 29)));
        assert_eq!(Minor::parse("garbage"), None);
        assert!(Minor::new(1, 9) < Minor::new(1, 16));
        assert_eq!(Minor::new(1, 31).next().to_string(), "1.32");
        assert_eq!(parse_target(" v1.33 ").unwrap(), Minor::new(1, 33));
        assert!(parse_target("2.0").is_err());
        assert!(parse_target("latest").is_err());
    }

    #[test]
    fn impact_depends_on_current_and_target() {
        let cronjob = lookup("batch/v1beta1", "CronJob").unwrap();
        let (v124, v125, v126) = (Minor::new(1, 24), Minor::new(1, 25), Minor::new(1, 26));
        assert_eq!(
            impact(cronjob, v124, v125),
            Some(Impact::Removed { already: false })
        );
        assert_eq!(
            impact(cronjob, v125, v126),
            Some(Impact::Removed { already: true })
        );
        assert_eq!(
            impact(cronjob, Minor::new(1, 22), Minor::new(1, 23)),
            Some(Impact::Deprecated)
        );
        assert_eq!(impact(cronjob, Minor::new(1, 19), Minor::new(1, 20)), None);
        let endpoints = lookup("v1", "Endpoints").unwrap();
        assert_eq!(
            impact(endpoints, Minor::new(1, 33), Minor::new(1, 34)),
            Some(Impact::Deprecated)
        );
        assert_eq!(
            impact(endpoints, Minor::new(1, 31), Minor::new(1, 32)),
            None
        );
    }
}
