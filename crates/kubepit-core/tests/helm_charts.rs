//! End-to-end tests of the chart commands against a fake `helm`: a shell
//! script that records its arguments and prints canned output. Stored
//! revisions are read from the fake API server in `support/`. No network,
//! no cluster, and no real helm configuration is ever touched.
#![cfg(unix)]

mod support;

use std::path::PathBuf;
use std::sync::Arc;

use kubepit_core::error::is_read_only;
use kubepit_core::types::{
    HelmInstallRequest, HelmRepoAddOptions, HelmSearchOptions, HelmUpgradeRequest,
};
use kubepit_core::Kubepit;
use serde_json::json;
use support::{setup, start, status, Log, Reply, Request, Router};

const RELEASE_JSON: &str = r#"{"name":"web","namespace":"shop","version":1,
 "info":{"status":"deployed","description":"Install complete","notes":"Open http://web.shop"},
 "chart":{"metadata":{"name":"nginx","version":"18.2.4","appVersion":"1.27.2"},"values":{"replicaCount":1}},
 "config":{"replicaCount":2},
 "manifest":"---\n# Source: nginx/templates/deployment.yaml\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n"}"#;

/// The fake binary. Markers in its directory change its behaviour:
/// `version` (what `helm version --short` prints), `legacy` (reject
/// `--dry-run=server` like helm < 3.13) and `no-repos`.
const SCRIPT: &str = r#"#!/bin/sh
dir="$(dirname "$0")"
printf '%s\n' "$*" >> "$dir/calls.log"
for a in "$@"; do
  case "$a" in
    --values=*) cp "${a#--values=}" "$dir/values.captured" ;;
    --password-stdin) cat > "$dir/stdin.captured" ;;
    --dry-run=server)
      if [ -f "$dir/legacy" ]; then
        echo 'Error: invalid argument "server" for "--dry-run" flag: strconv.ParseBool: parsing "server": invalid syntax' >&2
        exit 1
      fi ;;
  esac
done
case "$1 $2" in
  "version --short")
    if [ -f "$dir/version" ]; then cat "$dir/version"; else echo "v3.15.4+gfa9efb0"; fi ;;
  "repo list")
    if [ -f "$dir/no-repos" ]; then echo "Error: no repositories to show" >&2; exit 1; fi
    echo '[{"name":"bitnami","url":"https://charts.bitnami.com/bitnami"},{"name":"private","url":"https://charts.example.com"}]' ;;
  "repo add") echo "\"$3\" has been added to your repositories" ;;
  "repo remove") echo "\"$3\" has been removed from your repositories" ;;
  "repo update")
    echo 'Hang tight while we grab the latest from your chart repositories...'
    echo '...Successfully got an update from the "bitnami" chart repository'
    echo '...Unable to get an update from the "private" chart repository (https://charts.example.com):'
    printf '\tfailed to fetch https://charts.example.com/index.yaml : 401 Unauthorized\n'
    echo 'Update Complete. Happy Helming!' ;;
  "search repo")
    if [ -f "$dir/no-repos" ]; then echo "Error: no repositories configured" >&2; exit 1; fi
    echo '[{"name":"bitnami/nginx","version":"18.2.4","app_version":"1.27.2","description":"NGINX Open Source"},
           {"name":"bitnami/nginx","version":"18.10.0","app_version":"1.27.3","description":"NGINX Open Source"},
           {"name":"bitnami/nginx-ingress-controller","version":"11.5.0","app_version":"1.11.3","description":"DEPRECATED ingress"}]' ;;
  "search hub")
    echo '[{"url":"https://artifacthub.io/packages/helm/bitnami/nginx","version":"18.2.4","app_version":"1.27.2",
            "description":"NGINX Open Source","repository":{"url":"https://charts.bitnami.com/bitnami","name":"bitnami"}}]' ;;
  "show chart") printf 'apiVersion: v2\nname: nginx\nversion: 18.2.4\nappVersion: 1.27.2\nkeywords: [nginx]\n' ;;
  "show readme") printf '# NGINX\n\nA web server.\n' ;;
  "show values") printf 'replicaCount: 1\n' ;;
  install\ *|upgrade\ *) cat "$dir/release.json" ;;
  *) echo "Error: unexpected call: $*" >&2; exit 1 ;;
esac
"#;

struct FakeHelm {
    dir: tempfile::TempDir,
}

impl FakeHelm {
    fn new() -> Self {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("helm");
        std::fs::write(&path, SCRIPT).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(dir.path().join("release.json"), RELEASE_JSON).unwrap();
        Self { dir }
    }

    fn path(&self) -> PathBuf {
        self.dir.path().join("helm")
    }

    fn marker(&self, name: &str, content: &str) {
        std::fs::write(self.dir.path().join(name), content).unwrap();
    }

    fn read(&self, name: &str) -> Option<String> {
        std::fs::read_to_string(self.dir.path().join(name)).ok()
    }

    /// Every invocation except the `version --short` capability probes.
    fn calls(&self) -> Vec<String> {
        self.read("calls.log")
            .unwrap_or_default()
            .lines()
            .filter(|l| *l != "version --short")
            .map(str::to_string)
            .collect()
    }

    fn reset_calls(&self) {
        let _ = std::fs::remove_file(self.dir.path().join("calls.log"));
    }
}

fn app_with(
    helm: &FakeHelm,
    server: &str,
    read_only: bool,
) -> (tempfile::TempDir, Arc<Kubepit>, String) {
    let (dir, app, _recorder, id) = setup(server, read_only);
    let mut settings = app.settings();
    settings.helm_path = Some(helm.path().to_string_lossy().to_string());
    app.set_settings(settings).unwrap();
    (dir, app, id)
}

fn leftover_values_files(app: &Kubepit) -> Vec<PathBuf> {
    std::fs::read_dir(app.paths().run_dir())
        .map(|entries| {
            entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| {
                    p.file_name()
                        .is_some_and(|n| n.to_string_lossy().starts_with("helm-values-"))
                })
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test]
async fn repositories_and_catalog() {
    let helm = FakeHelm::new();
    let (_dir, app, _id) = app_with(&helm, "http://127.0.0.1:9", false);

    let repos = app.helm_repo_list().await.unwrap();
    assert_eq!(
        repos.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(),
        vec!["bitnami", "private"]
    );

    // Basic auth: the password travels on stdin only.
    let options = HelmRepoAddOptions {
        username: Some("alice".into()),
        password: Some("s3cret-pw".into()),
        insecure_skip_tls_verify: true,
        force_update: true,
        ..Default::default()
    };
    app.helm_repo_add("private", "https://charts.example.com", &options)
        .await
        .unwrap();
    let add = helm.calls().pop().unwrap();
    assert_eq!(
        add,
        "repo add private https://charts.example.com --username=alice --password-stdin \
         --insecure-skip-tls-verify --force-update"
    );
    assert!(!helm.read("calls.log").unwrap().contains("s3cret-pw"));
    assert_eq!(helm.read("stdin.captured").as_deref(), Some("s3cret-pw"));

    helm.reset_calls();
    let orphan = HelmRepoAddOptions {
        password: Some("x".into()),
        ..Default::default()
    };
    assert!(app
        .helm_repo_add("x", "https://x.example.com", &orphan)
        .await
        .is_err());
    assert!(app
        .helm_repo_add("x", "oci://ghcr.io/x", &HelmRepoAddOptions::default())
        .await
        .is_err());
    assert!(app
        .helm_repo_add(
            "a/b",
            "https://x.example.com",
            &HelmRepoAddOptions::default()
        )
        .await
        .is_err());
    assert!(helm.calls().is_empty(), "invalid input never reaches helm");

    let updated = app.helm_repo_update(&[]).await.unwrap();
    assert!(updated[0].ok);
    assert!(!updated[1].ok);
    assert!(updated[1].error.as_deref().unwrap().contains("401"));
    assert_eq!(helm.calls().last().unwrap(), "repo update");
    app.helm_repo_update(&["bitnami".into()]).await.unwrap();
    assert_eq!(helm.calls().last().unwrap(), "repo update bitnami");
    assert!(app.helm_repo_update(&["ghost".into()]).await.is_err());

    app.helm_repo_remove("private").await.unwrap();
    assert_eq!(helm.calls().last().unwrap(), "repo remove private");

    let charts = app
        .helm_chart_search("nginx", HelmSearchOptions::default())
        .await
        .unwrap();
    assert_eq!(charts.len(), 3);
    assert_eq!(charts[0].repo, "bitnami");
    assert!(charts[2].deprecated);
    assert_eq!(
        helm.calls().last().unwrap(),
        "search repo nginx --output json"
    );
    app.helm_chart_search(
        "",
        HelmSearchOptions {
            versions: true,
            devel: true,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        helm.calls().last().unwrap(),
        "search repo --versions --devel --output json"
    );

    let versions = app.helm_chart_versions("bitnami/nginx").await.unwrap();
    assert_eq!(
        versions
            .iter()
            .map(|v| v.version.as_str())
            .collect::<Vec<_>>(),
        vec!["18.10.0", "18.2.4"]
    );

    let hub = app.helm_hub_search("nginx").await.unwrap();
    assert_eq!(hub[0].repository_url, "https://charts.bitnami.com/bitnami");
    assert_eq!(
        helm.calls().last().unwrap(),
        "search hub nginx --list-repo-url --output json"
    );
    assert!(app.helm_hub_search("  ").await.is_err());

    // Chart details come from three `helm show` calls, then the cache.
    helm.reset_calls();
    let detail = app
        .helm_chart_show("bitnami/nginx", Some("18.2.4"))
        .await
        .unwrap();
    assert_eq!(detail.metadata.app_version.as_deref(), Some("1.27.2"));
    assert_eq!(detail.metadata.keywords, vec!["nginx"]);
    assert!(detail.readme.starts_with("# NGINX"));
    assert_eq!(detail.values_yaml, "replicaCount: 1\n");
    let mut shows = helm.calls();
    shows.sort();
    assert_eq!(
        shows,
        vec![
            "show chart bitnami/nginx --version=18.2.4",
            "show readme bitnami/nginx --version=18.2.4",
            "show values bitnami/nginx --version=18.2.4",
        ]
    );
    app.helm_chart_show("bitnami/nginx", Some("18.2.4"))
        .await
        .unwrap();
    assert_eq!(
        helm.calls().len(),
        3,
        "second show is served from the cache"
    );

    // "Nothing configured" is an empty list, not an error.
    helm.marker("no-repos", "");
    assert!(app.helm_repo_list().await.unwrap().is_empty());
    assert!(app
        .helm_chart_search("", HelmSearchOptions::default())
        .await
        .unwrap()
        .is_empty());
    assert!(app.helm_repo_update(&[]).await.unwrap().is_empty());
}

fn install_request(dry_run: bool) -> HelmInstallRequest {
    HelmInstallRequest {
        release_name: "web".into(),
        namespace: "shop".into(),
        chart_ref: "bitnami/nginx".into(),
        version: Some("18.2.4".into()),
        values_yaml: "replicaCount: 2\n".into(),
        create_namespace: true,
        wait: true,
        atomic: false,
        timeout_secs: Some(90),
        description: None,
        dry_run,
    }
}

#[tokio::test]
async fn installs_honour_read_only_but_allow_previews() {
    let helm = FakeHelm::new();
    let (_dir, app, id) = app_with(&helm, "http://127.0.0.1:9", true);

    // A dry run cannot change the cluster, so it works on read-only clusters.
    let preview = app.helm_install(&id, &install_request(true)).await.unwrap();
    let release = preview.release.unwrap();
    assert_eq!(release.name, "web");
    assert_eq!(release.chart_version, "18.2.4");
    assert_eq!(preview.notes, "Open http://web.shop");
    assert!(preview.manifest.contains("kind: Deployment"));
    assert_eq!(preview.values_yaml.trim(), "replicaCount: 2");
    let call = helm.calls().pop().unwrap();
    assert!(
        call.starts_with("install web bitnami/nginx --version=18.2.4 --values="),
        "{call}"
    );
    assert!(
        call.contains(" --dry-run=server --output json --create-namespace"),
        "{call}"
    );
    assert!(!call.contains("--wait"), "dry runs never wait: {call}");
    assert!(
        call.contains("--kube-context fake --namespace shop"),
        "{call}"
    );
    assert_eq!(
        helm.read("values.captured").as_deref(),
        Some("replicaCount: 2\n")
    );
    assert!(
        leftover_values_files(&app).is_empty(),
        "values file is removed"
    );

    // The real install is blocked before helm runs.
    helm.reset_calls();
    let err = app
        .helm_install(&id, &install_request(false))
        .await
        .unwrap_err();
    assert!(is_read_only(&err), "{err:#}");
    let err = app
        .helm_upgrade(
            &id,
            "shop",
            "web",
            &HelmUpgradeRequest {
                chart_ref: "bitnami/nginx".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
    assert!(is_read_only(&err), "{err:#}");
    assert!(helm.calls().is_empty());
    assert!(leftover_values_files(&app).is_empty());
}

#[tokio::test]
async fn installs_and_upgrades_build_helm_arguments() {
    let helm = FakeHelm::new();
    let (_dir, app, id) = app_with(&helm, "http://127.0.0.1:9", false);

    let result = app
        .helm_install(&id, &install_request(false))
        .await
        .unwrap();
    assert_eq!(result.release.unwrap().status, "deployed");
    let call = helm.calls().pop().unwrap();
    assert!(
        call.contains(" --wait --timeout=90s --output json --create-namespace --kubeconfig "),
        "{call}"
    );
    assert!(leftover_values_files(&app).is_empty());

    // Invalid input never reaches helm.
    helm.reset_calls();
    for bad in [
        HelmInstallRequest {
            release_name: "Web_1".into(),
            ..install_request(false)
        },
        HelmInstallRequest {
            chart_ref: "--set=x".into(),
            ..install_request(false)
        },
        HelmInstallRequest {
            values_yaml: "- not\n- a mapping\n".into(),
            ..install_request(false)
        },
    ] {
        assert!(app.helm_install(&id, &bad).await.is_err());
    }
    assert!(helm.calls().is_empty());

    // helm < 3.13 (detected from its version) gets the legacy flag.
    helm.marker("version", "v3.12.3+g3a31588\n");
    app.helm_install(&id, &install_request(true)).await.unwrap();
    let call = helm.calls().pop().unwrap();
    assert!(call.contains(" --dry-run --output json"), "{call}");

    // Unknown version: try the server dry run, fall back when rejected.
    helm.marker("version", "garbage\n");
    helm.marker("legacy", "");
    helm.reset_calls();
    app.helm_install(&id, &install_request(true)).await.unwrap();
    let calls = helm.calls();
    assert_eq!(calls.len(), 2, "{calls:?}");
    assert!(calls[0].contains("--dry-run=server"));
    assert!(calls[1].contains(" --dry-run --output json"));

    // Helm 4 renamed --atomic.
    helm.marker("version", "v4.0.1+g12500dd\n");
    let request = HelmUpgradeRequest {
        chart_ref: "bitnami/nginx".into(),
        version: Some("18.10.0".into()),
        values_yaml: String::new(),
        reset_values: true,
        atomic: true,
        timeout_secs: Some(600),
        ..Default::default()
    };
    let result = app
        .helm_upgrade(&id, "shop", "web", &request)
        .await
        .unwrap();
    assert!(result.release.is_some());
    let call = helm.calls().pop().unwrap();
    assert!(
        call.starts_with(
            "upgrade web bitnami/nginx --version=18.10.0 --rollback-on-failure \
             --timeout=600s --output json --reset-values --kubeconfig "
        ),
        "{call}"
    );
    assert!(
        !call.contains("--values="),
        "no values file without values: {call}"
    );
    let both = HelmUpgradeRequest {
        reuse_values: true,
        ..request
    };
    assert!(app.helm_upgrade(&id, "shop", "web", &both).await.is_err());
}

fn release_secret(name: &str, revision: i64) -> String {
    use base64::Engine as _;
    use std::io::Write as _;
    let release = json!({
        "name": name, "namespace": "shop", "version": revision,
        "info": {"status": "superseded", "last_deployed": "2024-02-01T10:00:00Z",
                 "description": "Install complete", "notes": format!("notes {revision}")},
        "chart": {"metadata": {"name": "nginx", "version": "18.2.4", "appVersion": "1.27.2"},
                  "values": {"replicaCount": 1, "image": {"tag": "1.27"}}},
        "config": {"replicaCount": 3},
        "manifest": format!("---\nkind: Deployment\nmetadata:\n  name: {name}-r{revision}\n")
    });
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gz.write_all(release.to_string().as_bytes()).unwrap();
    let helm_encoded = base64::engine::general_purpose::STANDARD.encode(gz.finish().unwrap());
    base64::engine::general_purpose::STANDARD.encode(helm_encoded)
}

fn revision_router() -> Router {
    Arc::new(|req: &Request, _log: &Log| {
        let path = req.path.split('?').next().unwrap_or_default();
        match (req.method.as_str(), path) {
            ("GET", "/version") => Reply::Json(
                200,
                json!({"major": "1", "minor": "31", "gitVersion": "v1.31.0",
                       "gitCommit": "abc", "gitTreeState": "clean", "buildDate": "2024-01-01T00:00:00Z",
                       "goVersion": "go1.22", "compiler": "gc", "platform": "linux/amd64"}),
            ),
            ("GET", "/apis") => Reply::Json(
                200,
                json!({"kind": "APIGroupList", "apiVersion": "v1", "groups": []}),
            ),
            ("GET", "/api/v1/namespaces/shop/secrets/sh.helm.release.v1.web.v1") => Reply::Json(
                200,
                json!({"apiVersion": "v1", "kind": "Secret", "type": "helm.sh/release.v1",
                       "metadata": {"name": "sh.helm.release.v1.web.v1", "namespace": "shop"},
                       "data": {"release": release_secret("web", 1)}}),
            ),
            _ => Reply::Json(404, status(404, "NotFound", "not found")),
        }
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stored_revisions_are_read_natively() {
    let server = start(revision_router()).await;
    let helm = FakeHelm::new();
    let (_dir, app, id) = app_with(&helm, &server.url, true);

    let revision = app
        .helm_release_revision(&id, "shop", "web", 1)
        .await
        .unwrap();
    assert_eq!(revision.release.revision, 1);
    assert_eq!(revision.release.status, "superseded");
    assert_eq!(revision.values_yaml.trim(), "replicaCount: 3");
    assert!(revision.computed_values_yaml.contains("tag: '1.27'"));
    assert!(revision.manifest.contains("web-r1"));
    assert_eq!(revision.notes, "notes 1");

    let missing = app
        .helm_release_revision(&id, "shop", "web", 7)
        .await
        .unwrap_err();
    assert!(
        format!("{missing:#}").contains("has no revision 7"),
        "{missing:#}"
    );
    assert!(app
        .helm_release_revision(&id, "shop", "../x", 1)
        .await
        .is_err());
    assert!(helm.calls().is_empty(), "revisions never shell out");
}
