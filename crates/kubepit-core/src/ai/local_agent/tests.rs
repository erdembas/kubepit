use super::*;

fn request() -> ChatRequest {
    ChatRequest {
        model: "default".into(),
        system: "Answer only from the redacted context.".into(),
        messages: vec![ChatMessage::User(vec![UserBlock::Text {
            text: "Explain __TOKEN__ without reading @/private/file".into(),
            cache: false,
        }])],
        tools: vec![],
        max_tokens: 1000,
        effort: None,
    }
}

#[test]
fn prompt_preserves_roles_and_rejects_tools() {
    let mut req = request();
    req.messages
        .push(ChatMessage::Assistant(Answer::new(&req).turn));
    let value: Value = serde_json::from_str(&prompt(&req).unwrap()).unwrap();
    assert_eq!(value["system"], req.system);
    assert_eq!(value["messages"][0]["role"], "user");
    assert_eq!(value["messages"][1]["role"], "assistant");
    req.messages
        .push(ChatMessage::User(vec![UserBlock::ToolResult {
            call_id: "id".into(),
            content: "private".into(),
            is_error: false,
        }]));
    assert!(prompt(&req).is_err());
}

#[test]
fn text_cap_never_splits_utf8() {
    let mut req = request();
    req.max_tokens = 1;
    let mut answer = Answer::new(&req);
    assert!(answer.text("Türkçe karakterler", &|_| {}).unwrap());
    assert_eq!(answer.turn.text, "Türk");
    assert_eq!(answer.turn.stop, StopReason::MaxTokens);
}

#[cfg(unix)]
mod unix {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;
    use std::sync::Arc;
    use std::time::Duration;

    fn fixture(kind: AiProviderKind, script: &str) -> (tempfile::TempDir, LocalAgentProvider) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fake-agent");
        let prelude = if kind == AiProviderKind::ClaudeCli {
            format!(
                r#"IFS= read -r initialize
printf '%s' "$initialize" >'{}/initialize'
printf '%s\n' '{{"type":"control_response","response":{{"subtype":"success","request_id":"kubepit-catalog","response":{{"models":[{{"value":"default","displayName":"Fixture model","supportedEffortLevels":["low","medium","high","xhigh","max"],"supportsFastMode":true}}],"account":{{"tokenSource":"none","apiProvider":"firstParty"}}}}}}}}'"#,
                dir.path().display()
            )
        } else {
            String::new()
        };
        std::fs::write(&path, format!("#!/bin/sh\n{prelude}\n{script}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut provider = LocalAgentProvider::new(
            kind,
            AiTimeouts {
                connect: Duration::from_secs(2),
                first_event: Duration::from_secs(2),
                idle: Duration::from_secs(2),
                total: Duration::from_secs(3),
            },
            Egress {
                remote_allowed: true,
                local_only: false,
            },
        )
        .unwrap();
        provider.executable = Some(ResolvedExecutable {
            path,
            command_path: None,
        });
        (dir, provider)
    }

    const INIT: &str = r#"printf '%s\n' '{"type":"system","subtype":"init","tools":[],"mcp_servers":[],"model":"fixture-model"}'"#;
    const DELTA: &str = r#"printf '%s\n' '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Merhaba"}}}'"#;
    const DONE: &str = r#"printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"result":"Merhaba","usage":{"input_tokens":7,"output_tokens":3,"cache_read_input_tokens":2,"cache_creation_input_tokens":1}}'"#;

    #[tokio::test]
    async fn claude_streams_once_and_accounts_usage() {
        let script = format!("/bin/cat >/dev/null\n{INIT}\n{DELTA}\n{DONE}");
        let (_dir, provider) = fixture(AiProviderKind::ClaudeCli, &script);
        let events = parking_lot::Mutex::new(Vec::new());
        let answer = provider
            .chat(
                &request(),
                &|event| events.lock().push(event),
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(answer.text, "Merhaba");
        assert_eq!(answer.model, "fixture-model");
        assert_eq!(
            answer.usage,
            AiUsage {
                input_tokens: 7,
                output_tokens: 3,
                cache_read_tokens: 2,
                cache_write_tokens: 1
            }
        );
        assert_eq!(
            events
                .lock()
                .iter()
                .filter(|event| matches!(event, StreamEvent::Text(_)))
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn consented_prompt_is_stdin_only_and_uses_a_private_cwd() {
        let record = tempfile::tempdir().unwrap();
        let path = record.path().display();
        let script = format!(
            r#"
printf '%s\n' "$@" >'{path}/args'
printf '%s' "$PWD" >'{path}/cwd'
printf '%s' "$KUBECONFIG" >'{path}/kubeconfig'
printf '%s' "$CLAUDE_CODE_DISABLE_ATTACHMENTS" >'{path}/attachments'
/bin/cat >'{path}/stdin'
{INIT}
{DONE}
"#
        );
        let (_dir, provider) = fixture(AiProviderKind::ClaudeCli, &script);
        let audited = Arc::new(parking_lot::Mutex::new(Value::Null));
        let captured = audited.clone();
        let provider = provider.with_request_hook(Arc::new(move |body, _| {
            *captured.lock() = body;
            Box::pin(async { Ok(()) })
        }));
        let provider = provider.with_options(AiAgentOptions {
            effort: Some("max".into()),
            fast_mode: true,
            ..Default::default()
        });
        provider
            .chat(&request(), &|_| {}, &CancellationToken::new())
            .await
            .unwrap();
        let args = std::fs::read_to_string(record.path().join("args")).unwrap();
        let stdin = std::fs::read_to_string(record.path().join("stdin")).unwrap();
        let cwd = std::fs::read_to_string(record.path().join("cwd")).unwrap();
        assert!(!args.contains("__TOKEN__"));
        assert!(args.contains("--strict-mcp-config\n"));
        assert!(args.contains("--tools\n\n"));
        assert!(args.contains("--setting-sources\n\n"));
        assert!(args.contains("--no-session-persistence"));
        assert!(args.contains("--effort\nmax\n"));
        let input: Value = serde_json::from_str(&stdin).unwrap();
        assert_eq!(audited.lock()["stdin"], input["message"]["content"]);
        assert!(args.contains("\"fastMode\":true"));
        assert!(args.contains("\"fastModePerSessionOptIn\":false"));
        assert_eq!(audited.lock()["instructions"], INSTRUCTIONS);
        assert_eq!(
            std::fs::read_to_string(record.path().join("attachments")).unwrap(),
            "1"
        );
        assert_eq!(
            std::fs::read_to_string(record.path().join("kubeconfig")).unwrap(),
            format!("{cwd}/no-cluster-access")
        );
        assert!(
            !Path::new(&cwd).exists(),
            "scratch directory must be cleaned after the process"
        );
    }

    #[tokio::test]
    async fn egress_and_cancellation_reject_before_spawn() {
        let marker = tempfile::tempdir().unwrap();
        let file = marker.path().join("spawned");
        let (_dir, provider) = fixture(
            AiProviderKind::ClaudeCli,
            &format!("touch '{}'", file.display()),
        );
        for egress in [
            Egress::default(),
            Egress {
                remote_allowed: true,
                local_only: true,
            },
        ] {
            provider.set_egress(egress);
            assert_eq!(
                provider
                    .chat(&request(), &|_| {}, &CancellationToken::new())
                    .await
                    .unwrap_err()
                    .kind,
                ProviderErrorKind::EgressRefused
            );
            assert!(!file.exists());
        }
        provider.set_egress(Egress {
            remote_allowed: true,
            local_only: false,
        });
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert_eq!(
            provider
                .chat(&request(), &|_| {}, &cancel)
                .await
                .unwrap_err()
                .kind,
            ProviderErrorKind::Cancelled
        );
        assert!(!file.exists());
    }

    #[tokio::test]
    async fn rejected_hook_does_not_launch_agent() {
        let marker = tempfile::tempdir().unwrap();
        let file = marker.path().join("spawned");
        let (_dir, provider) = fixture(
            AiProviderKind::ClaudeCli,
            &format!("touch '{}'", file.display()),
        );
        let provider = provider.with_request_hook(Arc::new(|_, _| {
            Box::pin(async { Err(ProviderError::cancelled()) })
        }));
        assert_eq!(
            provider
                .chat(&request(), &|_| {}, &CancellationToken::new())
                .await
                .unwrap_err()
                .kind,
            ProviderErrorKind::Cancelled
        );
        assert!(!file.exists());
    }

    #[tokio::test]
    async fn refuses_claude_that_did_not_disable_tools() {
        let (_dir, provider) = fixture(
            AiProviderKind::ClaudeCli,
            r#"/bin/cat >/dev/null
printf '%s\n' '{"type":"system","subtype":"init","tools":["Bash"],"mcp_servers":[]}'"#,
        );
        let error = provider
            .chat(&request(), &|_| {}, &CancellationToken::new())
            .await
            .unwrap_err();
        assert_eq!(error.kind, ProviderErrorKind::Protocol);
        assert!(error.partial.is_none());
    }

    #[tokio::test]
    async fn incomplete_stream_keeps_partial_without_leaking_stderr() {
        let script = format!(
            "/bin/cat >/dev/null\n{INIT}\n{DELTA}\nprintf '%s' 'SECRET_STDERR_TOKEN' >&2\nexit 1"
        );
        let (_dir, provider) = fixture(AiProviderKind::ClaudeCli, &script);
        let error = provider
            .chat(&request(), &|_| {}, &CancellationToken::new())
            .await
            .unwrap_err();
        assert_eq!(error.partial.unwrap().text, "Merhaba");
        assert!(!error.message.contains("SECRET_STDERR_TOKEN"));
    }

    #[tokio::test]
    async fn cancellation_kills_launcher_children_and_preserves_partial() {
        let marker = tempfile::tempdir().unwrap();
        let file = marker.path().join("child-pid");
        let script = format!(
            "/bin/cat >/dev/null\n/bin/sleep 30 &\nprintf '%s' \"$!\" >'{}'\n{INIT}\n{DELTA}\nwait",
            file.display()
        );
        let (_dir, provider) = fixture(AiProviderKind::ClaudeCli, &script);
        let cancel = CancellationToken::new();
        let sink = |event| {
            if matches!(event, StreamEvent::Text(_)) {
                cancel.cancel();
            }
        };
        let error = provider.chat(&request(), &sink, &cancel).await.unwrap_err();
        assert_eq!(error.kind, ProviderErrorKind::Cancelled);
        assert_eq!(error.partial.unwrap().text, "Merhaba");
        let pid: i32 = std::fs::read_to_string(&file).unwrap().parse().unwrap();
        for _ in 0..50 {
            // SAFETY: signal 0 only checks existence of our fixture's child.
            if unsafe { libc::kill(pid, 0) } != 0 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        #[cfg(target_os = "linux")]
        if std::fs::read_to_string(format!("/proc/{pid}/stat"))
            .is_ok_and(|stat| stat.contains(") Z "))
        {
            return;
        }
        panic!("fixture child still running after cancellation");
    }

    #[tokio::test]
    async fn idle_timeout_is_bounded() {
        let (_dir, mut provider) = fixture(
            AiProviderKind::ClaudeCli,
            "/bin/cat >/dev/null\n/bin/sleep 30",
        );
        provider.timeouts.first_event = Duration::from_millis(30);
        let error = provider
            .chat(&request(), &|_| {}, &CancellationToken::new())
            .await
            .unwrap_err();
        assert_eq!(error.kind, ProviderErrorKind::Timeout);
    }

    fn codex_script(environments: &str, notifications: &str, capture: &Path) -> String {
        let features = json!({"shell_tool":false,"plugins":false,"hooks":false,"codex_hooks":false,"plugin_hooks":false,"apps":false,"memories":false,"multi_agent":false,"multi_agent_v2":false});
        format!(
            r#"
while IFS= read -r line; do
printf '%s\n' "$line" >>'{}'
case "$line" in
*'"method":"initialize"'*) printf '%s\n' '{{"id":1,"result":{{"userAgent":"fixture"}}}}' ;;
*'"method":"config/read"'*) printf '%s\n' '{{"id":2,"result":{{"config":{{"features":{features},"mcp_servers":{{"custom.server":{{"command":"do-not-run"}}}}}}}}}}' ;;
*'"method":"account/read"'*) printf '%s\n' '{{"id":3,"result":{{"account":{{"type":"chatgpt"}},"requiresOpenaiAuth":true}}}}' ;;
*'"method":"model/list"'*) printf '%s\n' '{{"id":10,"result":{{"data":[{{"model":"fixture-model","displayName":"Fixture","isDefault":true,"supportedReasoningEfforts":[{{"reasoningEffort":"high"}},{{"reasoningEffort":"ultra"}}],"serviceTiers":[{{"id":"priority"}}]}}],"nextCursor":null}}}}' ;;
*'"method":"thread/start"'*) printf '%s\n' '{{"id":3,"result":{{"approvalPolicy":"never","thread":{{"id":"fixture-thread","environments":{environments}}},"model":"fixture-model"}}}}' ;;
*'"method":"turn/start"'*)
printf '%s\n' '{{"id":4,"result":{{"turn":{{"id":"fixture-turn"}}}}}}'
{notifications}
;;
esac
done
"#,
            capture.display()
        )
    }

    #[tokio::test]
    async fn codex_handshake_stream_and_mcp_isolation() {
        let marker = tempfile::tempdir().unwrap();
        let capture = marker.path().join("rpc");
        let notifications = r#"printf '%s\n' '{"method":"item/agentMessage/delta","params":{"itemId":"answer","delta":"Hello"}}'
printf '%s\n' '{"method":"item/completed","params":{"item":{"type":"agentMessage","id":"answer","text":"Hello"}}}'
printf '%s\n' '{"method":"thread/tokenUsage/updated","params":{"tokenUsage":{"last":{"inputTokens":10,"cachedInputTokens":4,"outputTokens":3}}}}'
printf '%s\n' '{"method":"turn/completed","params":{"turn":{"status":"completed"}}}'"#;
        let (_dir, provider) = fixture(
            AiProviderKind::CodexCli,
            &codex_script("[]", notifications, &capture),
        );
        let provider = provider.with_options(AiAgentOptions {
            effort: Some("ultra".into()),
            service_tier: Some("priority".into()),
            ..Default::default()
        });
        let answer = provider
            .chat(&request(), &|_| {}, &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(answer.text, "Hello");
        assert_eq!(answer.usage.input_tokens, 6);
        assert_eq!(answer.usage.cache_read_tokens, 4);
        let messages: Vec<Value> = std::fs::read_to_string(&capture)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        let thread = messages
            .iter()
            .find(|m| m["method"] == "thread/start")
            .unwrap();
        assert_eq!(
            thread["params"]["config"]["mcp_servers"]["custom.server"]["enabled"],
            false
        );
        assert_eq!(thread["params"]["environments"], json!([]));
        assert_eq!(thread["params"]["ephemeral"], true);
        assert!(thread["params"].get("model").is_none());
        let turn = messages
            .iter()
            .find(|m| m["method"] == "turn/start")
            .unwrap();
        assert_eq!(turn["params"]["effort"], "ultra");
        assert_eq!(turn["params"]["serviceTier"], "priority");
        assert_eq!(
            turn["params"]["input"][0]["text"],
            prompt(&request()).unwrap()
        );
    }

    #[tokio::test]
    async fn incompatible_codex_never_receives_prompt() {
        let marker = tempfile::tempdir().unwrap();
        let capture = marker.path().join("rpc");
        let (_dir, provider) = fixture(
            AiProviderKind::CodexCli,
            &codex_script("null", "", &capture),
        );
        let error = provider
            .chat(&request(), &|_| {}, &CancellationToken::new())
            .await
            .unwrap_err();
        assert_eq!(error.kind, ProviderErrorKind::Protocol);
        let captured = std::fs::read_to_string(&capture).unwrap();
        assert!(!captured.contains("turn/start"));
        assert!(!captured.contains("__TOKEN__"));
    }

    #[tokio::test]
    async fn codex_access_requests_are_never_approved() {
        let marker = tempfile::tempdir().unwrap();
        let capture = marker.path().join("rpc");
        let notification = r#"printf '%s\n' '{"id":"ask-1","method":"item/commandExecution/requestApproval","params":{"command":"kubectl delete pods --all"}}'"#;
        let (_dir, provider) = fixture(
            AiProviderKind::CodexCli,
            &codex_script("[]", notification, &capture),
        );
        let error = provider
            .chat(&request(), &|_| {}, &CancellationToken::new())
            .await
            .unwrap_err();
        assert_eq!(error.kind, ProviderErrorKind::Protocol);
        assert!(error.message.contains("unsupported local access"));
        assert!(!std::fs::read_to_string(capture)
            .unwrap()
            .contains("\"decision\":\"accept\""));
    }

    #[tokio::test]
    async fn claude_catalog_never_sends_a_user_message() {
        let (dir, provider) = fixture(AiProviderKind::ClaudeCli, "/bin/cat >/dev/null");
        let catalog = provider.catalog(CancellationToken::new()).await.unwrap();
        assert_eq!(catalog.models.len(), 1);
        assert_eq!(
            catalog.models[0].efforts,
            ["low", "medium", "high", "xhigh", "max"]
        );
        assert!(catalog.models[0].supports_fast_mode);
        assert_eq!(catalog.authenticated, Some(false));
        let initialize: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.path().join("initialize")).unwrap())
                .unwrap();
        assert_eq!(initialize["type"], "control_request");
        assert_eq!(initialize["request"]["subtype"], "initialize");
        assert!(!initialize.to_string().contains("__TOKEN__"));
    }

    #[tokio::test]
    async fn codex_catalog_never_creates_a_thread_or_turn() {
        let marker = tempfile::tempdir().unwrap();
        let capture = marker.path().join("rpc");
        let (_dir, provider) = fixture(AiProviderKind::CodexCli, &codex_script("[]", "", &capture));
        let catalog = provider.catalog(CancellationToken::new()).await.unwrap();
        assert_eq!(catalog.models.len(), 1);
        assert_eq!(catalog.models[0].efforts, ["high", "ultra"]);
        assert_eq!(catalog.models[0].service_tiers, ["priority"]);
        assert_eq!(catalog.authenticated, Some(true));
        assert_eq!(catalog.auth_method.as_deref(), Some("chatgpt"));
        let captured = std::fs::read_to_string(capture).unwrap();
        assert!(captured.contains("account/read"));
        assert!(captured.contains("model/list"));
        assert!(!captured.contains("thread/start"));
        assert!(!captured.contains("turn/start"));
    }

    #[tokio::test]
    async fn codex_catalog_follows_native_pagination_and_rejects_cursor_cycles() {
        let marker = tempfile::tempdir().unwrap();
        let capture = marker.path().join("rpc");
        for cycle in [false, true] {
            let base = codex_script("[]", "", &capture);
            let old = base
                .lines()
                .find(|line| line.contains("method\":\"model/list"))
                .unwrap();
            let last_cursor = if cycle { "\"second-page\"" } else { "null" };
            let pagination = format!(
                r#"*'"method":"model/list"'*)
case "$line" in
*'"cursor":"second-page"'*) printf '%s\n' '{{"id":11,"result":{{"data":[{{"model":"second-model"}}],"nextCursor":{last_cursor}}}}}' ;;
*) printf '%s\n' '{{"id":10,"result":{{"data":[{{"model":"first-model","isDefault":true}},{{"model":"hidden-model","hidden":true}}],"nextCursor":"second-page"}}}}' ;;
esac
;;"#
            );
            let (_dir, provider) =
                fixture(AiProviderKind::CodexCli, &base.replace(old, &pagination));
            let result = provider.catalog(CancellationToken::new()).await;
            if cycle {
                assert_eq!(
                    result.unwrap_err().message,
                    "Codex returned an invalid model catalog cursor"
                );
            } else {
                let catalog = result.unwrap();
                assert_eq!(
                    catalog
                        .models
                        .iter()
                        .map(|model| model.id.as_str())
                        .collect::<Vec<_>>(),
                    ["first-model", "second-model"]
                );
                assert_eq!(catalog.default_model.as_deref(), Some("first-model"));
            }
        }
    }

    #[tokio::test]
    async fn custom_model_ids_work_without_unadvertised_capability_overrides() {
        let marker = tempfile::tempdir().unwrap();
        let capture = marker.path().join("rpc");
        let notification = r#"printf '%s\n' '{"method":"turn/completed","params":{"turn":{"status":"completed"}}}'"#;
        let (_dir, provider) = fixture(
            AiProviderKind::CodexCli,
            &codex_script("[]", notification, &capture),
        );
        let mut req = request();
        req.model = "custom-exact-model-id".into();
        provider
            .chat(&req, &|_| {}, &CancellationToken::new())
            .await
            .unwrap();
        let captured = std::fs::read_to_string(&capture).unwrap();
        let thread: Value = captured
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .find(|message| message["method"] == "thread/start")
            .unwrap();
        assert_eq!(thread["params"]["model"], "custom-exact-model-id");

        let provider = provider.with_options(AiAgentOptions {
            effort: Some("high".into()),
            ..Default::default()
        });
        let error = provider
            .chat(&req, &|_| {}, &CancellationToken::new())
            .await
            .unwrap_err();
        assert_eq!(error.kind, ProviderErrorKind::BadRequest);
        assert!(error.message.contains("refresh the model list"));
    }

    #[tokio::test]
    async fn unsupported_native_options_are_rejected_before_sending_prompt() {
        let marker = tempfile::tempdir().unwrap();
        for options in [
            AiAgentOptions {
                effort: Some("max".into()),
                ..Default::default()
            },
            AiAgentOptions {
                service_tier: Some("not-advertised".into()),
                ..Default::default()
            },
            AiAgentOptions {
                fast_mode: true,
                ..Default::default()
            },
        ] {
            let capture = marker.path().join(uuid::Uuid::new_v4().to_string());
            let (_dir, provider) =
                fixture(AiProviderKind::CodexCli, &codex_script("[]", "", &capture));
            let provider = provider.with_options(options);
            let error = provider
                .chat(&request(), &|_| {}, &CancellationToken::new())
                .await
                .unwrap_err();
            assert_eq!(error.kind, ProviderErrorKind::BadRequest);
            let captured = std::fs::read_to_string(capture).unwrap();
            assert!(!captured.contains("thread/start"));
            assert!(!captured.contains("__TOKEN__"));
        }
    }

    #[tokio::test]
    async fn malformed_output_is_bounded_and_never_echoed() {
        let (_dir, provider) = fixture(
            AiProviderKind::ClaudeCli,
            "/bin/cat >/dev/null\nprintf '%s\\n' 'SECRET_INVALID_PROTOCOL'",
        );
        let error = provider
            .chat(&request(), &|_| {}, &CancellationToken::new())
            .await
            .unwrap_err();
        assert_eq!(error.kind, ProviderErrorKind::Protocol);
        assert!(!error.message.contains("SECRET_INVALID_PROTOCOL"));
    }

    #[tokio::test]
    async fn final_result_without_newline_is_accepted() {
        let script = format!(
            "/bin/cat >/dev/null\n{INIT}\n{}",
            DONE.replace("printf '%s\\n'", "printf '%s'")
        );
        let (_dir, provider) = fixture(AiProviderKind::ClaudeCli, &script);
        let answer = provider
            .chat(&request(), &|_| {}, &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(answer.text, "Merhaba");
    }

    #[tokio::test]
    async fn oversized_json_event_stops_before_unbounded_buffering() {
        let script = "/bin/cat >/dev/null\n/usr/bin/head -c 1100000 /dev/zero";
        let (_dir, provider) = fixture(AiProviderKind::ClaudeCli, script);
        let error = provider
            .chat(&request(), &|_| {}, &CancellationToken::new())
            .await
            .unwrap_err();
        assert_eq!(error.kind, ProviderErrorKind::Protocol);
        assert!(error.message.contains("oversized event"));
    }
}
