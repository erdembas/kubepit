//! Best-effort Kubernetes distribution detection.
//!
//! Used for the platform badge next to a connected cluster. It is purely
//! cosmetic, so it must be cheap: everything is inferred from data we already
//! have after connecting (the API server `gitVersion`, the server URL, the
//! context name) plus one boolean — whether the `config.openshift.io` API
//! group is served. No extra requests per heuristic.

/// Inputs gathered while connecting.
#[derive(Debug, Clone, Default)]
pub struct PlatformHints<'a> {
    /// `gitVersion` from `/version`, e.g. `v1.31.2-eks-7f9249a`.
    pub git_version: &'a str,
    /// API server URL from the kubeconfig.
    pub server: &'a str,
    /// Context name.
    pub context: &'a str,
    /// Whether `config.openshift.io` is served.
    pub has_openshift: bool,
}

/// Guess the distribution. `None` when nothing matched (plain upstream).
pub fn detect_platform(hints: &PlatformHints<'_>) -> Option<String> {
    let version = hints.git_version.to_ascii_lowercase();
    let server = hints.server.to_ascii_lowercase();
    let context = hints.context.to_ascii_lowercase();
    let host = host_of(&server);

    let name = if hints.has_openshift {
        "OpenShift"
    } else if version.contains("-eks-") || host.ends_with(".eks.amazonaws.com") {
        "EKS"
    } else if version.contains("-gke.") || context.starts_with("gke_") {
        "GKE"
    } else if host.ends_with(".azmk8s.io") || version.contains("-aks") {
        "AKS"
    } else if version.contains("+k3s") {
        if context.starts_with("k3d-") {
            "k3d"
        } else if context == "rancher-desktop" {
            "Rancher Desktop"
        } else {
            "k3s"
        }
    } else if version.contains("+rke2") {
        "RKE2"
    } else if version.contains("+k0s") {
        "k0s"
    } else if host.ends_with(".k8s.ondigitalocean.com") {
        "DigitalOcean"
    } else if host.ends_with(".linodelke.net") {
        "LKE"
    } else if context.starts_with("kind-") {
        "kind"
    } else if context == "minikube" {
        "minikube"
    } else if context == "docker-desktop" || context == "docker-for-desktop" {
        "Docker Desktop"
    } else if context == "rancher-desktop" {
        "Rancher Desktop"
    } else if context == "orbstack" {
        "OrbStack"
    } else if context == "microk8s" || context.starts_with("microk8s") {
        "MicroK8s"
    } else if context.starts_with("k3d-") {
        "k3d"
    } else if context.starts_with("arn:aws:eks:") {
        "EKS"
    } else {
        return None;
    };
    Some(name.to_string())
}

/// Host part of a URL (`https://host:6443/path` → `host`).
fn host_of(url: &str) -> &str {
    let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    let authority = authority
        .rsplit_once('@')
        .map(|(_, h)| h)
        .unwrap_or(authority);
    if let Some(stripped) = authority.strip_prefix('[') {
        // IPv6 literal.
        return stripped.split(']').next().unwrap_or(stripped);
    }
    authority.split(':').next().unwrap_or(authority)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn detect(version: &str, server: &str, context: &str) -> Option<String> {
        detect_platform(&PlatformHints {
            git_version: version,
            server,
            context,
            has_openshift: false,
        })
    }

    #[test]
    fn managed_clouds() {
        assert_eq!(
            detect("v1.31.2-eks-7f9249a", "https://x.example", "prod").as_deref(),
            Some("EKS")
        );
        assert_eq!(
            detect(
                "v1.30.0",
                "https://ABCDEF.gr7.eu-west-1.eks.amazonaws.com",
                "prod"
            )
            .as_deref(),
            Some("EKS")
        );
        assert_eq!(
            detect("v1.30.5-gke.1014001", "https://34.1.2.3", "prod").as_deref(),
            Some("GKE")
        );
        assert_eq!(
            detect("v1.30.5", "https://34.1.2.3", "gke_proj_europe-west1_main").as_deref(),
            Some("GKE")
        );
        assert_eq!(
            detect(
                "v1.29.7",
                "https://my-aks-dns-abc.hcp.westeurope.azmk8s.io:443",
                "aks"
            )
            .as_deref(),
            Some("AKS")
        );
        assert_eq!(
            detect("v1.29.1", "https://abc.k8s.ondigitalocean.com", "do").as_deref(),
            Some("DigitalOcean")
        );
    }

    #[test]
    fn lightweight_distributions() {
        assert_eq!(
            detect("v1.30.4+k3s1", "https://127.0.0.1:6443", "default").as_deref(),
            Some("k3s")
        );
        assert_eq!(
            detect("v1.30.4+k3s1", "https://0.0.0.0:6443", "k3d-dev").as_deref(),
            Some("k3d")
        );
        assert_eq!(
            detect("v1.30.4+k3s1", "https://127.0.0.1:6443", "rancher-desktop").as_deref(),
            Some("Rancher Desktop")
        );
        assert_eq!(
            detect("v1.29.3+rke2r1", "https://10.0.0.1:6443", "edge").as_deref(),
            Some("RKE2")
        );
    }

    #[test]
    fn local_contexts() {
        let local = "https://127.0.0.1:6443";
        assert_eq!(
            detect("v1.31.0", local, "kind-dev").as_deref(),
            Some("kind")
        );
        assert_eq!(
            detect("v1.31.0", local, "minikube").as_deref(),
            Some("minikube")
        );
        assert_eq!(
            detect("v1.31.0", local, "docker-desktop").as_deref(),
            Some("Docker Desktop")
        );
        assert_eq!(
            detect("v1.31.0", local, "orbstack").as_deref(),
            Some("OrbStack")
        );
        assert_eq!(detect("v1.31.0", local, "my-cluster"), None);
    }

    #[test]
    fn openshift_wins() {
        let hints = PlatformHints {
            git_version: "v1.29.6+a3bd6e5",
            server: "https://api.ocp.example.com:6443",
            context: "admin",
            has_openshift: true,
        };
        assert_eq!(detect_platform(&hints).as_deref(), Some("OpenShift"));
    }

    #[test]
    fn host_parsing() {
        assert_eq!(host_of("https://a.b.c:6443/x"), "a.b.c");
        assert_eq!(host_of("https://[::1]:6443"), "::1");
        assert_eq!(host_of("a.b"), "a.b");
    }
}
