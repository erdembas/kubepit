//! End-to-end, offline diagnosis evaluation: golden redacted payloads,
//! EN/TR prompt stability, exact preview identity and SQLite leak checks.
mod ai_eval_support;
mod support;

use ai_eval_support::{cases, context, fixture_dir, run_case};
use kubepit_core::ai::AiEvent;
use kubepit_core::history::AiLogFilter;
use std::collections::BTreeMap;
use std::time::Duration;

#[tokio::test]
async fn golden_cases_render_stable_leak_free_requests() {
    for case in cases() {
        let run = run_case(&case, false).await;
        assert_eq!(run.bodies.len(), 1, "{}", case.name);
        let serialized = serde_json::to_string(&run.bodies).unwrap();
        let preview = serde_json::to_string(&run.preview).unwrap();
        for secret in &case.secrets {
            assert!(
                !serialized.contains(secret),
                "{}: leaked fixture secret in sent request",
                case.name
            );
            assert!(
                !preview.contains(secret),
                "{}: leaked fixture secret in preview",
                case.name
            );
        }
        assert!(
            run.preview.estimated_input_tokens <= case.max_input_tokens,
            "{} exceeds budget",
            case.name
        );
        let sent_context = context(&run.bodies[0]);
        for id in &case.expect_sections {
            let section = run
                .preview
                .sections
                .iter()
                .find(|section| &section.id == id && !section.excluded)
                .unwrap_or_else(|| panic!("{}: missing section {id}", case.name));
            assert!(
                sent_context.contains(&section.text),
                "{}: preview differs from sent section {id}",
                case.name
            );
        }
        let answer: String = run
            .events
            .iter()
            .filter_map(|event| match event {
                AiEvent::Text { delta } => Some(delta.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(
            answer, case.scripted_reply,
            "{}: scripted answer must survive streaming",
            case.name
        );
        let golden = fixture_dir().join(format!("{}.golden.txt", case.name));
        if std::env::var("KUBEPIT_UPDATE_GOLDEN").as_deref() == Ok("1") {
            std::fs::write(&golden, sent_context).unwrap();
        }
        let expected = std::fs::read_to_string(&golden).unwrap_or_else(|_| panic!("Missing golden file {}. Run KUBEPIT_UPDATE_GOLDEN=1 cargo test -p kubepit-core --test ai_eval", golden.display()));
        assert_eq!(
            sent_context, expected,
            "{}: review changes before regenerating",
            case.name
        );
    }
}

#[tokio::test]
async fn the_system_prompt_is_identical_across_cases_per_locale() {
    let mut by_locale = BTreeMap::new();
    for case in cases() {
        let run = run_case(&case, false).await;
        let locale = serde_json::to_string(&case.locale).unwrap();
        let system = run.bodies[0]["system"].clone();
        if let Some(previous) = by_locale.insert(locale, system.clone()) {
            assert_eq!(
                previous, system,
                "{} changed the shared prompt prefix",
                case.name
            );
        }
    }
    assert_eq!(by_locale.len(), 2);
    assert_ne!(by_locale["\"en\""], by_locale["\"tr\""]);
}

#[tokio::test]
async fn secrets_never_reach_history_db() {
    let case = cases()
        .into_iter()
        .find(|case| case.name == "config-error-with-secret")
        .unwrap();
    let run = run_case(&case, true).await;
    let page = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            assert!(run.app.history_flush());
            let page = run.app.ai_log_list(&AiLogFilter::default()).unwrap();
            if !page.entries.is_empty() {
                break page;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("run must be written to history");
    assert_eq!(page.entries.len(), 1);
    let detail = run.app.ai_log_get(page.entries[0].id).unwrap();
    assert!(detail.request.contains("__SECRET__"));
    let logged: serde_json::Value = serde_json::from_str(&detail.request).unwrap();
    assert_eq!(
        logged,
        serde_json::to_value(&run.bodies).unwrap(),
        "audit request must equal what was sent"
    );
    assert!(
        run.dir.path().join("home/history.db").exists(),
        "positive control: a history database exists"
    );
    for secret in &case.secrets {
        assert!(
            !support::home_contains(run.dir.path(), secret),
            "fixture secret reached a persisted file, including the database or WAL"
        );
    }
}
