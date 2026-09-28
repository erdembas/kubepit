//! Custom actions end to end through the public API: k9s import from a
//! fixture file, saving, resolving and running against a registered
//! cluster. No cluster is contacted: commands only print.

use std::sync::Arc;

use kubepit_core::custom_actions::{CustomActionMode, CustomActionTarget};
use kubepit_core::types::ClusterInput;
use kubepit_core::{Kubepit, NullSink, Paths};

/// Plugins in the shape of the k9s community collection.
const PLUGINS: &str = r#"
plugins:
  # Logs with stern for pods and workloads.
  stern:
    shortCut: Ctrl-L
    confirm: false
    description: Logs <Stern>
    scopes:
      - pods
      - deployments
    command: stern
    background: false
    args:
      - --tail
      - 50
      - $FILTER
      - -n
      - $NAMESPACE
      - --context
      - $CONTEXT
  neat:
    shortCut: Shift-N
    description: Neat YAML
    scopes: [all]
    command: sh
    background: true
    args:
      - -c
      - "kubectl get $RESOURCE_NAME $NAME -n $NAMESPACE -o yaml | kubectl neat"
  flux-reconcile:
    shortCut: Shift-R
    confirm: true
    dangerous: true
    description: Flux reconcile
    scopes: [kustomizations.kustomize.toolkit.fluxcd.io]
    command: bash
    args: [-c, "flux reconcile kustomization --context $CONTEXT -n $NAMESPACE $NAME | less -K"]
  helm-diff:
    shortCut: Shift-D
    scopes: [helm]
    command: bash
    args: [-c, "helm diff $NAME"]
  column-demo:
    shortCut: Ctrl-Q
    scopes: [pods]
    command: sh
    pipes: [less]
    args: [-c, "echo \"$COL-STATUS on $NAME\""]
"#;

const KUBECONFIG: &str = r#"apiVersion: v1
kind: Config
clusters:
  - name: fake
    cluster:
      server: https://127.0.0.1:1
contexts:
  - name: fake-ctx
    context:
      cluster: fake
      user: fake
current-context: fake-ctx
users:
  - name: fake
    user:
      token: not-a-real-token
"#;

fn app(read_only: bool) -> (tempfile::TempDir, Kubepit, String) {
    let dir = tempfile::tempdir().unwrap();
    let app = Kubepit::open(Paths::new(dir.path().join("home")), Arc::new(NullSink)).unwrap();
    let cluster = app
        .cluster_add(vec![ClusterInput {
            name: "Fake Cluster".into(),
            context: "fake-ctx".into(),
            kubeconfig_text: Some(KUBECONFIG.into()),
            read_only,
            ..Default::default()
        }])
        .unwrap()
        .remove(0);
    (dir, app, cluster.id)
}

fn pod(name: &str) -> CustomActionTarget {
    CustomActionTarget {
        namespace: Some("shop".into()),
        name: Some(name.into()),
        kind: Some("Pod".into()),
        group: Some(String::new()),
        version: Some("v1".into()),
        resource: Some("pods".into()),
        ..Default::default()
    }
}

#[test]
fn k9s_plugins_file_maps_to_actions() {
    let (dir, app, _cluster) = app(false);
    let fixture = dir.path().join("plugins.yaml");
    std::fs::write(&fixture, PLUGINS).unwrap();
    let import = app
        .custom_actions_import(Some(&fixture.to_string_lossy()), None)
        .unwrap();
    assert_eq!(import.format, "k9s");
    let names: Vec<&str> = import.actions.iter().map(|a| a.name.as_str()).collect();
    assert_eq!(
        names,
        vec!["Logs <Stern>", "Neat YAML", "Flux reconcile", "column-demo"]
    );

    let stern = &import.actions[0];
    assert_eq!(stern.scopes, vec!["core/Pod", "apps/Deployment"]);
    assert_eq!(stern.shortcut.as_deref(), Some("ctrl+l"));
    assert_eq!(stern.mode, CustomActionMode::Terminal);

    let neat = &import.actions[1];
    assert_eq!(neat.mode, CustomActionMode::Background);
    assert_eq!(neat.scopes, vec!["*"]);
    assert_eq!(
        neat.command,
        "kubectl get {resource} {name} -n {namespace} -o yaml | kubectl neat"
    );

    let flux = &import.actions[2];
    assert!(flux.mutating && flux.confirm);
    assert_eq!(
        flux.scopes,
        vec!["kustomize.toolkit.fluxcd.io/Kustomization"]
    );
    assert_eq!(
        flux.command,
        "flux reconcile kustomization --context {context} -n {namespace} {name} | less -K"
    );

    let column = &import.actions[3];
    assert_eq!(column.command, "echo \"$COL-STATUS on \"{name}");

    let notes: Vec<(&str, &str, &str)> = import
        .notes
        .iter()
        .map(|n| (n.action.as_str(), n.code.as_str(), n.detail.as_str()))
        .collect();
    for expected in [
        ("Logs <Stern>", "unsupported-variable", "$FILTER"),
        (
            "Flux reconcile",
            "guessed-scope",
            "kustomizations.kustomize.toolkit.fluxcd.io → kustomize.toolkit.fluxcd.io/Kustomization",
        ),
        ("helm-diff", "unsupported-scope", "helm"),
        ("helm-diff", "no-scope", "helm"),
        ("column-demo", "unsupported-field", "pipes"),
        ("column-demo", "unsupported-variable", "$COL-STATUS"),
    ] {
        assert!(notes.contains(&expected), "missing {expected:?} in {notes:?}");
    }

    // Imported actions save as they are.
    let saved = app.custom_actions_save(import.actions).unwrap();
    assert_eq!(saved.len(), 4);
    assert!(app.custom_actions_list().initialized);
}

#[tokio::test]
async fn saved_actions_resolve_and_run_with_cluster_values() {
    let (_dir, app, cluster) = app(false);
    let import = app
        .custom_actions_import(
            None,
            Some(
                &serde_json::json!({
                    "actions": [{
                        "id": "whoami",
                        "name": "Where am I",
                        "scopes": ["Pod"],
                        "mode": "background",
                        "command": "printf '%s/%s/%s/%s' {cluster} {context} {namespace} {name}"
                    }]
                })
                .to_string(),
            ),
        )
        .unwrap();
    app.custom_actions_save(import.actions).unwrap();
    let action = app.custom_actions_list().actions.remove(0);
    let preview = app
        .custom_action_resolve(&action, Some(&cluster), &pod("web 0"))
        .unwrap();
    assert_eq!(
        preview.command,
        "printf '%s/%s/%s/%s' 'Fake Cluster' fake-ctx shop 'web 0'"
    );
    if cfg!(unix) {
        let out = app
            .custom_action_run(&cluster, "whoami", &pod("web 0"))
            .await
            .unwrap();
        assert_eq!(out.stdout, "Fake Cluster/fake-ctx/shop/web 0");
        assert_eq!(out.command, preview.command);
    }
}

#[tokio::test]
async fn read_only_clusters_refuse_mutating_actions() {
    let (_dir, app, cluster) = app(true);
    let import = app
        .custom_actions_import(
            None,
            Some(
                &serde_json::json!([
                    { "id": "mut", "name": "Annotate", "mode": "background", "mutating": true,
                      "command": "kubectl annotate {resource} {selection.names} -n {namespace} checked=yes" },
                    { "id": "read", "name": "Get", "mode": "background",
                      "command": "printf '%s ' {selection.names}" }
                ])
                .to_string(),
            ),
        )
        .unwrap();
    app.custom_actions_save(import.actions).unwrap();
    let mut target = pod("a");
    target.selection = vec!["a".into(), "b".into()];
    let err = app
        .custom_action_run(&cluster, "mut", &target)
        .await
        .unwrap_err();
    assert!(kubepit_core::error::is_read_only(&err), "{err:#}");
    if cfg!(unix) {
        let ok = app
            .custom_action_run(&cluster, "read", &target)
            .await
            .unwrap();
        assert_eq!(ok.stdout, "a b ");
    }
}
