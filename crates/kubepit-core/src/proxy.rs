//! Per-cluster proxies.
//!
//! A cluster's connections go through, in order of precedence:
//!
//! 1. `ClusterDef::proxy_url`, set in the cluster editor;
//! 2. the `proxy-url` of the context's cluster in the kubeconfig;
//! 3. `HTTPS_PROXY` / `https_proxy` of the Kubepit process (kube's and
//!    client-go's own fallback, not reported by [`effective`]).
//!
//! The effective URL is written into the single-context kubeconfig built for
//! the cluster ([`apply`]), so the Rust client and `run/<id>.kubeconfig`
//! (kubectl, helm, terminals) always agree. `socks5h://` is accepted as an
//! alias and written as `socks5://`: client-go only accepts `socks5`, and
//! both client-go and kube already resolve host names through the SOCKS
//! proxy for it (which is what `socks5h` means elsewhere).

use anyhow::{bail, Result};
use kube::config::{Cluster, Kubeconfig};

use crate::types::{ClusterProxyInfo, ProxySource};

/// Schemes accepted in a proxy URL.
pub const SCHEMES: [&str; 4] = ["http", "https", "socks5", "socks5h"];

/// Trim a user-entered proxy URL; blank means "no override". Invalid URLs
/// are rejected with a message that names the problem.
pub fn normalize(raw: Option<&str>) -> Result<Option<String>> {
    let Some(url) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    validate(url)?;
    Ok(Some(url.to_string()))
}

/// Check `scheme://[user[:password]@]host[:port][/]`.
pub fn validate(url: &str) -> Result<()> {
    if url.chars().any(char::is_whitespace) {
        bail!("proxy URL must not contain spaces");
    }
    let Some((scheme, rest)) = url.split_once("://") else {
        bail!("proxy URL must start with http://, https://, socks5:// or socks5h://");
    };
    if !SCHEMES.contains(&scheme.to_ascii_lowercase().as_str()) {
        bail!("unsupported proxy scheme \"{scheme}\" (use http, https, socks5 or socks5h)");
    }
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(end);
    if !(tail.is_empty() || tail == "/") {
        bail!("proxy URL must not have a path, query or fragment");
    }
    let host_port = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let (host, port) = if let Some(v6) = host_port.strip_prefix('[') {
        let Some((host, after)) = v6.split_once(']') else {
            bail!("proxy URL has an unterminated IPv6 address");
        };
        let port = match after {
            "" => None,
            p => match p.strip_prefix(':') {
                Some(port) => Some(port),
                None => bail!("proxy URL has an invalid host"),
            },
        };
        (host, port)
    } else {
        match host_port.rsplit_once(':') {
            Some((host, port)) => (host, Some(port)),
            None => (host_port, None),
        }
    };
    if host.is_empty() {
        bail!("proxy URL needs a host");
    }
    if let Some(port) = port {
        match port.parse::<u16>() {
            Ok(p) if p > 0 => {}
            _ => bail!("proxy URL has an invalid port \"{port}\""),
        }
    }
    Ok(())
}

/// The URL clients are given: a lowercase scheme, and `socks5h` becomes
/// `socks5` (see module docs).
pub fn for_clients(url: &str) -> String {
    match url.split_once("://") {
        Some((scheme, rest)) => {
            let scheme = scheme.to_ascii_lowercase();
            let scheme = if scheme == "socks5h" {
                "socks5"
            } else {
                &scheme
            };
            format!("{scheme}://{rest}")
        }
        None => url.to_string(),
    }
}

/// Hide the password of `scheme://user:password@host` for display.
pub fn mask(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else {
        return url.to_string();
    };
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(end);
    match authority.rsplit_once('@') {
        Some((userinfo, host)) => {
            let user = userinfo.split_once(':').map_or(userinfo, |(u, _)| u);
            let masked = if userinfo.contains(':') {
                format!("{user}:***")
            } else {
                user.to_string()
            };
            format!("{scheme}://{masked}@{host}{tail}")
        }
        None => url.to_string(),
    }
}

/// `proxy-url` of the (only) cluster of a single-context kubeconfig.
fn kubeconfig_proxy(single: &Kubeconfig) -> Option<String> {
    single
        .clusters
        .first()?
        .cluster
        .as_ref()?
        .proxy_url
        .clone()
        .filter(|p| !p.trim().is_empty())
}

/// The proxy of a cluster before [`apply`] rewrote the kubeconfig.
pub fn effective(override_url: Option<&str>, single: &Kubeconfig) -> ClusterProxyInfo {
    if let Some(url) = override_url.map(str::trim).filter(|s| !s.is_empty()) {
        return ClusterProxyInfo {
            url: Some(mask(url)),
            source: Some(ProxySource::Cluster),
        };
    }
    match kubeconfig_proxy(single) {
        Some(url) => ClusterProxyInfo {
            url: Some(mask(&url)),
            source: Some(ProxySource::Kubeconfig),
        },
        None => ClusterProxyInfo {
            url: None,
            source: None,
        },
    }
}

/// Write the effective proxy into a single-context kubeconfig. An invalid
/// kubeconfig `proxy-url` is reported here rather than as a cryptic
/// connection error.
pub fn apply(single: &mut Kubeconfig, override_url: Option<&str>) -> Result<()> {
    let override_url = override_url.map(str::trim).filter(|s| !s.is_empty());
    let Some(url) = override_url
        .map(str::to_string)
        .or_else(|| kubeconfig_proxy(single))
    else {
        return Ok(());
    };
    if override_url.is_none() {
        validate(&url).map_err(|e| anyhow::anyhow!("kubeconfig proxy-url: {e}"))?;
    }
    let Some(named) = single.clusters.first_mut() else {
        return Ok(());
    };
    named.cluster.get_or_insert_with(Cluster::default).proxy_url = Some(for_clients(&url));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kubeconfig;

    const WITH_PROXY: &str = r#"
apiVersion: v1
kind: Config
clusters:
- name: c
  cluster:
    server: https://10.0.0.1:6443
    proxy-url: socks5h://bastion.internal:1080
users:
- name: u
  user:
    token: t
contexts:
- name: ctx
  context:
    cluster: c
    user: u
"#;

    #[test]
    fn validates_schemes_hosts_and_ports() {
        for ok in [
            "http://proxy:3128",
            "https://proxy.corp.example",
            "socks5://127.0.0.1:1080",
            "SOCKS5H://bastion:1080/",
            "http://user:secret@proxy:8080",
            "http://[::1]:3128",
        ] {
            assert!(validate(ok).is_ok(), "{ok}");
        }
        for (bad, why) in [
            ("proxy:3128", "must start with"),
            ("ftp://proxy:21", "unsupported proxy scheme"),
            ("http://", "needs a host"),
            ("http://proxy:0", "invalid port"),
            ("http://proxy:99999", "invalid port"),
            ("http://proxy:3128/path", "path"),
            ("http://pro xy:3128", "spaces"),
            ("http://[::1:3128", "IPv6"),
        ] {
            let err = validate(bad).unwrap_err().to_string();
            assert!(err.contains(why), "{bad}: {err}");
        }
        assert_eq!(normalize(Some("  ")).unwrap(), None);
        assert_eq!(
            normalize(Some(" http://p:1 ")).unwrap().as_deref(),
            Some("http://p:1")
        );
    }

    #[test]
    fn socks5h_is_written_as_socks5_and_passwords_are_masked() {
        assert_eq!(for_clients("socks5h://b:1080"), "socks5://b:1080");
        assert_eq!(for_clients("SOCKS5H://b:1080"), "socks5://b:1080");
        assert_eq!(for_clients("HTTP://p:1"), "http://p:1");
        assert_eq!(
            mask("http://me:secret@proxy:8080"),
            "http://me:***@proxy:8080"
        );
        assert_eq!(mask("http://me@proxy:8080"), "http://me@proxy:8080");
        assert_eq!(mask("socks5://proxy:1080"), "socks5://proxy:1080");
    }

    #[test]
    fn override_wins_over_the_kubeconfig() {
        let kc = kubeconfig::load_text(WITH_PROXY).unwrap();
        let single = kubeconfig::single_context(&kc, "ctx").unwrap();
        let info = effective(None, &single);
        assert_eq!(info.source, Some(ProxySource::Kubeconfig));
        assert_eq!(info.url.as_deref(), Some("socks5h://bastion.internal:1080"));

        let mut kept = single.clone();
        apply(&mut kept, None).unwrap();
        assert_eq!(
            kept.clusters[0]
                .cluster
                .as_ref()
                .unwrap()
                .proxy_url
                .as_deref(),
            Some("socks5://bastion.internal:1080")
        );

        let mut overridden = single.clone();
        apply(&mut overridden, Some("http://u:p@corp:3128")).unwrap();
        let yaml = kubeconfig::to_yaml(&overridden).unwrap();
        assert!(yaml.contains("proxy-url: http://u:p@corp:3128"), "{yaml}");
        let info = effective(Some("http://u:p@corp:3128"), &single);
        assert_eq!(info.source, Some(ProxySource::Cluster));
        assert_eq!(info.url.as_deref(), Some("http://u:***@corp:3128"));
    }

    #[test]
    fn no_proxy_leaves_the_kubeconfig_alone() {
        let kc = kubeconfig::load_text(crate::kubeconfig::tests::TWO_CONTEXTS).unwrap();
        let mut single = kubeconfig::single_context(&kc, "dev").unwrap();
        apply(&mut single, Some("  ")).unwrap();
        assert!(single.clusters[0]
            .cluster
            .as_ref()
            .unwrap()
            .proxy_url
            .is_none());
        assert_eq!(effective(None, &single).url, None);
    }
}
