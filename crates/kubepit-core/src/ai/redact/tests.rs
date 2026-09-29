use super::*;
use base64::engine::general_purpose::STANDARD;
use serde_json::json;

const LEAKS: &[&str] = &[
    "aHVudGVyMg==",
    "hunter2",
    "s3cr3t",
    "AKIAIOSFODNN7EXAMPLE",
    "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.c2lnbmF0dXJlLXZhbHVl",
    "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
];
fn clean(s: &str) {
    for l in LEAKS {
        assert!(!s.contains(l), "{l} leaked in {s}");
    }
}
const NONE: RedactOptions = RedactOptions {
    tokens: false,
    ips: false,
    hostnames: false,
};
const ALL: RedactOptions = RedactOptions {
    tokens: true,
    ips: true,
    hostnames: true,
};
const TOKENS_ONLY: RedactOptions = RedactOptions {
    tokens: true,
    ips: false,
    hostnames: false,
};
const IPS_ONLY: RedactOptions = RedactOptions {
    tokens: false,
    ips: true,
    hostnames: false,
};
const HOSTS_ONLY: RedactOptions = RedactOptions {
    tokens: false,
    ips: false,
    hostnames: true,
};

fn text(input: &str, opts: &RedactOptions) -> String {
    redact_text(input, opts, &mut Pseudonyms::default()).0
}

fn manifest(input: &str) -> String {
    let out = redact_manifest_text(input, &NONE, &mut Pseudonyms::default()).0;
    clean(&out);
    out
}

const PEM: &str =
    "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n";

// -- Plan tests (Task 2) -----------------------------------------------------

#[test]
fn secret_values_never_survive_even_with_every_option_off() {
    let yaml = r#"
apiVersion: v1
kind: Secret
metadata:
  name: db
  annotations:
    kubectl.kubernetes.io/last-applied-configuration: '{"data":{"PASSWORD":"aHVudGVyMg=="}}'
  managedFields: [{manager: kubectl}]
data: {PASSWORD: aHVudGVyMg==}
stringData: {TOKEN: s3cr3t}
---
apiVersion: v1
kind: Pod
metadata: {name: web}
spec:
  containers:
  - name: app
    env:
    - {name: DB_PASSWORD, value: hunter2}
    - {name: LOG_LEVEL, value: debug}
"#;
    let (out, counts) = redact_manifest_text(yaml, &NONE, &mut Pseudonyms::default());
    clean(&out);
    assert!(
        out.contains("PASSWORD: __SECRET__") && out.contains("LOG_LEVEL") && out.contains("debug")
    );
    assert!(!out.contains("managedFields") && !out.contains("last-applied-configuration"));
    assert_eq!(counts.secrets, 3);
}

#[test]
fn pem_private_keys_are_always_masked() {
    let text = "key:\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n";
    let (out, c) = redact_text(text, &NONE, &mut Pseudonyms::default());
    clean(&out);
    assert!(out.contains(SECRET_MARKER));
    assert_eq!(c.secrets, 1);
}

#[test]
fn tokens_are_masked_only_when_enabled() {
    let text = "auth Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.c2lnbmF0dXJlLXZhbHVl aws AKIAIOSFODNN7EXAMPLE gh ghp_0123456789abcdefghijklmnopqrstuvwxyzAB url postgres://app:hunter2@db:5432 password=s3cr3t";
    let (masked, c) = redact_text(
        text,
        &RedactOptions {
            tokens: true,
            ..NONE
        },
        &mut Pseudonyms::default(),
    );
    clean(&masked);
    assert!(c.tokens >= 5);
    assert!(masked.contains("postgres://__TOKEN__@db:5432"));
    let (kept, _) = redact_text(text, &NONE, &mut Pseudonyms::default());
    assert!(kept.contains("AKIAIOSFODNN7EXAMPLE"));
}

#[test]
fn ips_and_hostnames_get_consistent_restorable_placeholders() {
    let mut p = Pseudonyms::default();
    let (out, c) = redact_text("10.0.3.7 -> db.acme.internal, again 10.0.3.7; listen 127.0.0.1 0.0.0.0; app.py main.go registry.k8s.io/pause app.kubernetes.io/name ghcr.io/org/api", &ALL, &mut p);
    assert_eq!(out, "__IP_1__ -> __HOST_1__, again __IP_1__; listen 127.0.0.1 0.0.0.0; app.py main.go registry.k8s.io/pause app.kubernetes.io/name ghcr.io/org/api");
    assert_eq!((c.ips, c.hostnames), (2, 1));
    assert_eq!(
        p.restore_map().get("__HOST_1__").map(String::as_str),
        Some("db.acme.internal")
    );
}

#[test]
fn unparsable_manifests_fall_back_to_text_redaction() {
    let (out, _) = redact_manifest_text(
        "kind: [\npassword=s3cr3t",
        &RedactOptions {
            tokens: true,
            ..NONE
        },
        &mut Pseudonyms::default(),
    );
    clean(&out);
}

// -- Round-1 extras ----------------------------------------------------------

#[test]
fn options_follow_the_settings() {
    let opts = RedactOptions::from(&AiRedactionSettings::default());
    assert_eq!(opts, TOKENS_ONLY);
}

#[test]
fn placeholders_are_numbered_per_kind_in_first_seen_order() {
    let mut p = Pseudonyms::default();
    assert_eq!(
        p.placeholder(PseudoKind::Host, "a.example.com"),
        "__HOST_1__"
    );
    assert_eq!(p.placeholder(PseudoKind::Ip, "10.0.0.1"), "__IP_1__");
    assert_eq!(p.placeholder(PseudoKind::Ip, "10.0.0.2"), "__IP_2__");
    assert_eq!(p.placeholder(PseudoKind::Ip, "10.0.0.1"), "__IP_1__");
    assert_eq!(
        p.placeholder(PseudoKind::Host, "b.example.com"),
        "__HOST_2__"
    );
    assert_eq!(p.restore_map().len(), 4);
    assert_eq!(p.restore_map()["__IP_2__"], "10.0.0.2");
}

#[test]
fn ipv6_addresses_are_pseudonymized_but_times_and_paths_are_not() {
    let mut p = Pseudonyms::default();
    let text = "pod fe80::1ff:fe23:4567:890a via [2001:db8::1]:8080, mapped ::ffff:10.0.0.9, \
                full 2001:0db8:85a3:0000:0000:8a2e:0370:7334; loopback ::1 and ::; \
                std::string at 10:32:05, mac aa:bb:cc:dd:ee:ff, again fe80::1ff:fe23:4567:890a.";
    let (out, c) = redact_text(text, &IPS_ONLY, &mut p);
    assert_eq!(
        out,
        "pod __IP_1__ via [__IP_2__]:8080, mapped __IP_3__, \
         full __IP_4__; loopback ::1 and ::; \
         std::string at 10:32:05, mac aa:bb:cc:dd:ee:ff, again __IP_1__."
    );
    assert_eq!(c.ips, 5);
    assert_eq!(p.restore_map()["__IP_2__"], "2001:db8::1");
    let (colon, _) = redact_text("addr:fe80::2 ok", &IPS_ONLY, &mut p);
    assert_eq!(colon, "addr:__IP_5__ ok");
}

#[test]
fn dotted_versions_are_not_ips() {
    let input = "version 1.2.3.4.5 oid 1.3.6.1.4.1 v10.0.0.1 ip 10.0.0.1:443 cidr 10.0.0.0/16.";
    let (out, c) = redact_text(input, &IPS_ONLY, &mut Pseudonyms::default());
    assert_eq!(
        out,
        "version 1.2.3.4.5 oid 1.3.6.1.4.1 v10.0.0.1 ip __IP_1__:443 cidr __IP_2__/16."
    );
    assert_eq!(c.ips, 2);
}

#[test]
fn crlf_logs_keep_their_line_endings() {
    let log = "2026-09-29T10:00:00Z dial 10.0.3.7\r\n\
               Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123\r\n\
               -----BEGIN RSA PRIVATE KEY-----\r\n\
               MIIEvQIBADANBgkqhkiG9w0BAQEFAASC\r\n\
               -----END RSA PRIVATE KEY-----\r\n\
               ok\r\n";
    let (out, c) = redact_text(log, &ALL, &mut Pseudonyms::default());
    clean(&out);
    assert_eq!(
        out,
        "2026-09-29T10:00:00Z dial __IP_1__\r\n\
         Authorization: Bearer __TOKEN__\r\n\
         __SECRET__\r\n\
         ok\r\n"
    );
    assert_eq!((c.secrets, c.tokens, c.ips), (1, 1, 1));
}

#[test]
fn keys_cut_by_a_log_tail_or_trim_are_masked() {
    // The head of a key (log lines with timestamps), then a trim marker.
    let head = "2026-09-29T10:00:00.1Z -----BEGIN PRIVATE KEY-----\n\
                2026-09-29T10:00:00.2Z MIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n\
                … 30 lines omitted …\n\
                next line";
    let (out, c) = redact_text(head, &NONE, &mut Pseudonyms::default());
    assert_eq!(
        out,
        "2026-09-29T10:00:00.1Z __SECRET__\n… 30 lines omitted …\nnext line"
    );
    assert_eq!(c.secrets, 1);
    // The tail of a key after a trim marker.
    let tail = "… 30 lines omitted …\n\
                c2VjcmV0LWtleS1ib2R5LWxpbmUtb25l\n\
                YWJjZA==\n\
                -----END PRIVATE KEY-----\n\
                next line";
    let (out, c) = redact_text(tail, &NONE, &mut Pseudonyms::default());
    assert_eq!(out, "… 30 lines omitted …\n__SECRET__\nnext line");
    assert_eq!(c.secrets, 1);
    // Without a stop the rest of the text goes (fail closed).
    let words = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nnext line";
    assert_eq!(text(words, &NONE), "__SECRET__");
    // JSON-escaped, cut before the end, with and without the closing quote.
    let json = r#"{"key": "-----BEGIN EC PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nMIIEvQIBADAN"#;
    assert_eq!(text(json, &NONE), r#"{"key": "__SECRET__"#);
    let closed = r#"{"key": "-----BEGIN EC PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nMIIEvQIBADAN", "next": 1}"#;
    assert_eq!(text(closed, &NONE), r#"{"key": "__SECRET__", "next": 1}"#);
}

#[test]
fn very_long_lines_are_redacted_in_full() {
    let filler = "x".repeat(300_000);
    let input = format!("{filler} token=s3cr3tvalue 10.1.2.3 {filler} AKIAIOSFODNN7EXAMPLE");
    let start = std::time::Instant::now();
    let (out, c) = redact_text(&input, &ALL, &mut Pseudonyms::default());
    assert!(start.elapsed() < std::time::Duration::from_secs(2));
    clean(&out);
    assert!(!out.contains("s3cr3tvalue") && out.contains("__IP_1__"));
    assert_eq!((c.tokens, c.ips), (2, 1));
}

#[test]
fn redaction_is_idempotent() {
    let input = "Bearer abcdefghijklmnopqrstuvwxyz0123 password=hunter2 10.0.3.7 db.acme.internal \
                 postgres://app:hunter2@db.acme.internal:5432 fe80::1 ip-10-0-3-8 --token abcd1234 \
                 {\\\"secret\\\":\\\"s3cr3tvalue\\\"}";
    let mut p = Pseudonyms::default();
    let (once, _) = redact_text(input, &ALL, &mut p);
    let (twice, again) = redact_text(&once, &ALL, &mut p);
    assert_eq!(once, twice);
    assert_eq!(again, RedactionCounts::default());
    clean(&once);
}

#[test]
fn secrets_nested_in_lists_are_masked() {
    let list = "apiVersion: v1\nkind: List\nitems:\n- apiVersion: v1\n  kind: Secret\n  metadata: {name: db}\n  data: {PASSWORD: aHVudGVyMg==}\n";
    let (out, c) = redact_manifest_text(list, &NONE, &mut Pseudonyms::default());
    clean(&out);
    assert!(
        out.contains("PASSWORD: __SECRET__") && out.contains("name: db"),
        "{out}"
    );
    assert_eq!(c.secrets, 1);
    // API lists omit the items' kind.
    let api = json!({"apiVersion": "v1", "kind": "SecretList", "items": [
        {"metadata": {"name": "db"}, "data": {"PASSWORD": "aHVudGVyMg=="}, "type": "Opaque"}
    ]});
    let (out, c) = redact_value(&api, &NONE, &mut Pseudonyms::default());
    clean(&out.to_string());
    assert_eq!(out["items"][0]["data"]["PASSWORD"], SECRET_MARKER);
    assert_eq!(out["items"][0]["type"], "Opaque");
    assert_eq!(c.secrets, 1);
}

#[test]
fn json_manifests_are_redacted_and_returned_as_yaml() {
    let json = r#"{"apiVersion":"v1","kind":"Secret","metadata":{"name":"db","namespace":"shop"},"stringData":{"TOKEN":"s3cr3t"},"type":"Opaque"}"#;
    let (out, c) = redact_manifest_text(json, &NONE, &mut Pseudonyms::default());
    clean(&out);
    assert!(
        out.contains("stringData:\n  TOKEN: __SECRET__") && out.contains("namespace: shop"),
        "{out}"
    );
    assert_eq!(c.secrets, 1);
    let custom = json!({"apiVersion": "bitnami.com/v1alpha1", "kind": "SealedSecret",
        "metadata": {"name": "db"}, "spec": {"encryptedData": {"PASSWORD": "AgBy8hCi"}, "template": {"type": "Opaque"}}});
    let (out, c) = redact_value(&custom, &NONE, &mut Pseudonyms::default());
    assert_eq!(out["spec"]["encryptedData"]["PASSWORD"], SECRET_MARKER);
    assert_eq!(out["metadata"]["name"], "db");
    assert_eq!(c.secrets, 2);
}

#[test]
fn credential_keys_in_objects_follow_the_token_layer() {
    let cm = json!({"kind": "ConfigMap", "data": {
        "DB_PASSWORD": "hunter2", "secretName": "tls", "clientSecret": 123456,
        "app.properties": "db.password=s3cr3t\nurl=http://x", "PORT": "8080"}});
    let (out, c) = redact_value(&cm, &TOKENS_ONLY, &mut Pseudonyms::default());
    clean(&out.to_string());
    assert_eq!(out["data"]["DB_PASSWORD"], TOKEN_MARKER);
    assert_eq!(out["data"]["clientSecret"], TOKEN_MARKER);
    assert_eq!(out["data"]["secretName"], "tls");
    assert_eq!(out["data"]["PORT"], "8080");
    assert_eq!(c.tokens, 3);
    let (kept, _) = redact_value(&cm, &NONE, &mut Pseudonyms::default());
    assert_eq!(kept, cm);
}

#[test]
fn keys_and_nested_bookkeeping_are_redacted_too() {
    let deploy = json!({"kind": "Deployment", "metadata": {"name": "web", "annotations": {
            "db.acme.internal/owner": "team", "kubectl.kubernetes.io/last-applied-configuration": "{}"}},
        "spec": {"template": {"metadata": {"managedFields": [], "labels": {"app": "web"}},
            "spec": {"initContainers": [{"name": "init", "env": [{"name": "API_KEY", "valueFrom": {"secretKeyRef": {"name": "k", "key": "v"}}}]}],
                     "containers": [{"name": "app", "env": [{"name": "GITHUB_TOKEN", "value": "ghp_x"}]}]}}}});
    let (out, c) = redact_value(&deploy, &HOSTS_ONLY, &mut Pseudonyms::default());
    assert_eq!(
        out["metadata"]["annotations"],
        json!({"__HOST_1__/owner": "team"})
    );
    assert!(out["spec"]["template"]["metadata"]
        .get("managedFields")
        .is_none());
    assert_eq!(
        out["spec"]["template"]["spec"]["containers"][0]["env"][0]["value"],
        SECRET_MARKER
    );
    let init = &out["spec"]["template"]["spec"]["initContainers"][0]["env"][0];
    assert_eq!(init["valueFrom"]["secretKeyRef"]["name"], "k");
    assert_eq!((c.secrets, c.hostnames), (1, 1));
}

#[test]
fn odd_shapes_never_panic() {
    let mut deep = json!("10.0.0.1");
    for _ in 0..300 {
        deep = json!([deep]);
    }
    let values = [
        Value::Null,
        json!(42),
        json!("plain 10.0.0.1"),
        json!([]),
        json!({}),
        json!({"kind": 5, "metadata": "x", "env": {"a": 1}, "data": null}),
        json!({"kind": "Secret", "data": "plain", "stringData": [1, {"a": null}, true], "spec": false}),
        json!({"kind": "Secret", "data": {"A": null, "B": {"C": [1.5, "x"]}}}),
        json!({"metadata": {"annotations": ["x"], "managedFields": "y"}}),
        json!({"metadata": {"annotations": null}}),
        json!({"env": [1, "x", null, {"name": 5, "value": "v"}, {"name": "TOKEN"},
                       {"name": "TOKEN", "value": null}, {"name": "TOKEN", "value": {"nested": "s3cr3t"}}]}),
        json!({"kind": ["Secret"], "items": {"kind": "Secret"}}),
        json!({"kind": "List", "items": "none"}),
        json!({"password": [], "token": {}, "apiKey": null, "secret": true}),
        json!({"kind": "Secret", "metadata": {"annotations": {"a": {"b": ["s3cr3t"]}}}}),
        json!({"note": "kind: [", "data2": "data: {"}),
        deep,
    ];
    for v in &values {
        let (out, _) = redact_value(v, &ALL, &mut Pseudonyms::default());
        assert!(
            !out.to_string().contains("10.0.0.1") && !out.to_string().contains("s3cr3t"),
            "{out}"
        );
        let yaml = serde_yaml::to_string(v).unwrap();
        let _ = redact_manifest_text(&yaml, &ALL, &mut Pseudonyms::default());
        let _ = redact_message(
            &format!("```yaml\n{yaml}```"),
            &ALL,
            &mut Pseudonyms::default(),
        );
    }
    for input in [
        "",
        "   ",
        "---\n---\n",
        "null",
        "- a\n- b",
        "{",
        "[1, 2",
        "\u{0}\u{7f}\u{ffff}",
        "::",
        "a:b:c::d::e",
        "-----END PRIVATE KEY-----",
        "-----BEGIN PRIVATE KEY-----",
        "```",
        "```json\n{",
        "LS0tLS1CRUdJTi",
        "kind: Secret\n  - : :\n\t{",
        "- name: TOKEN\n",
        "value: x\n- name: API_KEY",
    ] {
        let _ = redact_manifest_text(input, &ALL, &mut Pseudonyms::default());
        let _ = redact_text(input, &ALL, &mut Pseudonyms::default());
        let _ = redact_message(input, &ALL, &mut Pseudonyms::default());
    }
}

#[test]
fn cut_or_broken_manifests_still_hide_secret_values() {
    let cut_json = r#"{"apiVersion":"v1","kind":"Secret","metadata":{"name":"db"},"data":{"PASSWORD":"aHVudGVyMg==","TOKEN":"czNjcjN0"#;
    let (out, c) = redact_manifest_text(cut_json, &NONE, &mut Pseudonyms::default());
    clean(&out);
    // Ambiguous malformed structures are withheld whole, rather than guessed.
    assert_eq!(out, SECRET_MARKER);
    assert_eq!(c.secrets, 1);

    let tabs = "apiVersion: v1\nkind: Secret\nmetadata:\n  name: db\ntype: Opaque\ndata:\n\tPASSWORD: aHVudGVyMg==\n\
                stringData:\n  cert: |\n    line-one-s3cr3t\n    line-two\n  note: \"multi\n    hunter2\"\n";
    let out = manifest(tabs);
    assert!(!out.contains("line-two"), "{out}");
    assert_eq!(out, SECRET_MARKER);

    let pod = "kind: Pod\nmetadata:\n  name: web\n  annotations:\n    kubectl.kubernetes.io/last-applied-configuration: |\n      {\"env\":\"hunter2\"}\n\
               spec:\n  containers:\n  - name: app\n    image: [broken\n    env:\n    - name: DB_PASSWORD\n      value: hunter2\n\
               \x20   - {name: API_TOKEN, value: s3cr3t}\n    - name: LOG_LEVEL\n      value: debug\n";
    let (out, c) = redact_manifest_text(pod, &NONE, &mut Pseudonyms::default());
    clean(&out);
    assert_eq!(out, SECRET_MARKER);
    assert_eq!(c.secrets, 1);

    let cut_pretty = "{\n  \"kind\": \"Pod\",\n  \"spec\": {\"containers\": [{\"env\": [\n    {\n      \"name\": \"DB_PASSWORD\",\n      \"value\": \"hunter2\"\n    },\n    {\"name\": \"MODE\", \"value\": \"prod\"";
    let out = manifest(cut_pretty);
    assert_eq!(out, SECRET_MARKER);
}

// -- Review fixes ------------------------------------------------------------

/// H1: a document without `kind` (cut by the size cap: JSON sorts `data`
/// and `items` before `kind`) is Secret-like when it carries secret fields.
#[test]
fn kindless_documents_with_secret_fields_fail_closed() {
    let release = "apiVersion: v1\ndata:\n  release: H4sIaHVudGVyMgaHVudGVyMg\n";
    let out = manifest(release);
    assert!(out.contains("release: __SECRET__"), "{out}");

    let list =
        r#"{"apiVersion":"v1","items":[{"data":{"A":"aHVudGVyMg=="},"metadata":{"name":"db"}}]}"#;
    let out = manifest(list);
    assert!(out.contains("A: __SECRET__"), "{out}");

    // Cut mid-way: unparsable and kind-less.
    let cut = r#"{"apiVersion":"v1","items":[{"data":{"A":"aHVudGVyMg==","B":"czNjcjN0"#;
    let out = manifest(cut);
    assert!(!out.contains("czNjcjN0"), "{out}");

    // A prefix whose kind was cut away is classified by the whole text.
    let whole = "apiVersion: v1\nmetadata:\n  name: db\ntype: x\nzzz: 1\nkind: Secret\n";
    let prefix = "apiVersion: v1\nmetadata:\n  name: db\ntype: x\n";
    let (out, c) = redact_manifest_prefix(prefix, whole, &NONE, &mut Pseudonyms::default());
    assert!(out.contains("name: db"), "{out}");
    assert_eq!(c, RedactionCounts::default());
    let whole = "apiVersion: v1\nspec:\n  password: hunter2\nkind: SealedSecret\n";
    let prefix = "apiVersion: v1\nspec:\n  password: hunter2\n";
    let (out, _) = redact_manifest_prefix(prefix, whole, &NONE, &mut Pseudonyms::default());
    clean(&out);
    let (out, _) = redact_manifest_prefix(
        "{\"apiVersion\":\"v1\",\"items\":[{\"spec\":{\"x\":\"hunter2\"",
        whole,
        &NONE,
        &mut Pseudonyms::default(),
    );
    clean(&out);
}

/// H2: Secret annotations are masked (bar service-account ones), and
/// manifests embedded in any string are redacted as manifests.
#[test]
fn secret_annotations_and_embedded_manifests_are_masked() {
    let secret = json!({"apiVersion": "v1", "kind": "Secret", "metadata": {"name": "db", "annotations": {
        "kapp.k14s.io/original": "{\"data\":{\"DB_PASS\":\"aHVudGVyMg==\"}}",
        "note": "hunter2",
        "kubernetes.io/service-account.name": "builder"}}, "data": {"A": "YQ=="}});
    let (out, _) = redact_value(&secret, &NONE, &mut Pseudonyms::default());
    clean(&out.to_string());
    let annotations = &out["metadata"]["annotations"];
    assert_eq!(annotations["note"], SECRET_MARKER);
    assert_eq!(annotations["kubernetes.io/service-account.name"], "builder");

    let tls = "TFMwdExTMUNSVWRKVGlCUVVrbFdRVlJGSUV0RldTMHRMUzB0";
    let cm = format!(
        "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: app\n  annotations:\n    \
         kapp.k14s.io/original: '{{\"data\":{{\"DB_PASS\":\"aHVudGVyMg==\",\"tls.key\":\"{tls}\"}}}}'\n    \
         ci.example.com/copy: 'stringData: {{DB_PASS: hunter2}}'\n    \
         other.example.com/pod: '{{\"kind\":\"Pod\",\"spec\":{{\"containers\":[{{\"env\":[{{\"name\":\"DB_PASSWORD\",\"value\":\"hunter2\"}}]}}]}}}}'\n\
         data:\n  mode: prod\n"
    );
    let out = manifest(&cm);
    assert!(!out.contains(tls), "{out}");
    assert!(out.contains("mode: prod"), "{out}");
    assert!(
        out.contains(r#"'{"kind":"Pod","spec""#) && out.contains(r#""value":"__SECRET__""#),
        "{out}"
    );
    assert!(
        out.contains(r#""tls.key":"__SECRET__""#) && out.contains("DB_PASS: __SECRET__"),
        "{out}"
    );
}

/// M1: messages get manifest masking in fences and for unfenced manifests.
#[test]
fn messages_are_redacted_like_manifests() {
    let msg = "Why does this fail?\n```yaml\napiVersion: v1\nkind: Secret\ndata:\n  PASSWORD: aHVudGVyMg==\n```\n\
               and this:\n```json\n{\"kind\": \"Pod\", \"spec\": {\"containers\": [{\"env\": [{\"name\": \"DB_PASSWORD\", \"value\": \"hunter2\"}]}]}}\n```\n\
               ```\nstringData:\n  TOKEN: s3cr3t\n```\n```sh\nkubectl get pods\n```\n";
    let (out, c) = redact_message(msg, &NONE, &mut Pseudonyms::default());
    clean(&out);
    assert!(
        out.starts_with("Why does this fail?\n```yaml\n") && out.contains("PASSWORD: __SECRET__"),
        "{out}"
    );
    assert!(
        out.contains("\"value\": \"__SECRET__\"") && out.contains("kubectl get pods"),
        "{out}"
    );
    assert_eq!(c.secrets, 3);

    let unfenced = "please check\napiVersion: v1\nkind: Secret\ndata:\n  PASSWORD: aHVudGVyMg==\n";
    let (out, _) = redact_message(unfenced, &NONE, &mut Pseudonyms::default());
    clean(&out);
    assert!(out.starts_with("please check\n"), "{out}");
    let plain = "why does 10.1.2.3 fail?";
    assert_eq!(
        redact_message(plain, &IPS_ONLY, &mut Pseudonyms::default()).0,
        "why does __IP_1__ fail?"
    );
}

/// M2: keys cut before their footer, in every layout.
#[test]
fn cut_keys_are_masked_to_a_blank_line_or_the_end() {
    let body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC";
    for (input, expected) in [
        (format!("-----BEGIN RSA PRIVATE KEY-----\n{body}\n{body}"), "__SECRET__".to_string()),
        (format!("key -----BEGIN PRIVATE KEY----- {body} {body}\n\nnext"), "key __SECRET__\n\nnext".to_string()),
        (format!("-----BEGIN PRIVATE KEY-----{body}{body}"), "__SECRET__".to_string()),
        (format!("app | -----BEGIN PRIVATE KEY-----\napp | {body}\napp | {body}\n"), "app | __SECRET__".to_string()),
        (
            format!("2026-09-29T10:00:00Z stdout F -----BEGIN PRIVATE KEY-----\n2026-09-29T10:00:00Z stdout F {body}\n"),
            "2026-09-29T10:00:00Z stdout F __SECRET__".to_string(),
        ),
        (
            format!("-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,0123ABCD\n\n{body}\n\nafter"),
            "__SECRET__\n\nafter".to_string(),
        ),
        (
            format!("-----BEGIN PGP PRIVATE KEY BLOCK-----\n\n{body}\n=AbCd\n"),
            "__SECRET__".to_string(),
        ),
        // Complete blocks with prefixes and headers.
        (
            format!("app | -----BEGIN PRIVATE KEY-----\napp | {body}\napp | -----END PRIVATE KEY-----\nok"),
            "app | __SECRET__\nok".to_string(),
        ),
        // Cut before the header, with log prefixes.
        (format!("app | {body}\napp | -----END PRIVATE KEY-----\nok"), "__SECRET__\nok".to_string()),
    ] {
        let out = text(&input, &NONE);
        clean(&out);
        assert_eq!(out, expected, "{input}");
    }
}

/// M3: keys wrapped in base64 (kubeconfig `client-key-data`, ConfigMap
/// `binaryData`), at every byte alignment; certificates stay.
#[test]
fn base64_wrapped_keys_are_masked() {
    let key = STANDARD.encode(PEM);
    let out = text(
        &format!("users:\n- user:\n    client-key-data: {key}\n"),
        &NONE,
    );
    assert_eq!(out, "users:\n- user:\n    client-key-data: __SECRET__\n");
    for prefix in ["a", "ab", "abc"] {
        let wrapped = STANDARD.encode(format!("{prefix}{PEM}"));
        let out = text(&format!("\"{wrapped}\""), &NONE);
        assert_eq!(out, "\"__SECRET__\"", "prefix {prefix}");
    }
    let cm = json!({"kind": "ConfigMap", "binaryData": {"tls.key": key}});
    let (out, c) = redact_value(&cm, &NONE, &mut Pseudonyms::default());
    assert_eq!(out["binaryData"]["tls.key"], SECRET_MARKER);
    assert_eq!(c.secrets, 1);
    let cert = STANDARD
        .encode("-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUQ\n-----END CERTIFICATE-----\n");
    assert_eq!(text(&cert, &NONE), cert);
}

/// M4: escaped JSON inside log lines.
#[test]
fn escaped_json_credentials_are_masked() {
    let log = r#"{"log":"{\"password\":\"hunter2\",\"client_secret\":\"s3cr3tvalue\",\"user\":\"bob\"}"}"#;
    let out = text(log, &TOKENS_ONLY);
    assert_eq!(
        out,
        r#"{"log":"{\"password\":\"__TOKEN__\",\"client_secret\":\"__TOKEN__\",\"user\":\"bob\"}"}"#
    );
}

/// M5: secret-named `name` / `value` pairs anywhere, with the wider name set.
#[test]
fn secret_named_pairs_are_masked_anywhere() {
    let app = json!({"kind": "Application", "spec": {"source": {"helm": {"parameters": [
        {"name": "db.password", "value": "hunter2"}, {"name": "replicas", "value": "3"}]}}}});
    let (out, _) = redact_value(&app, &NONE, &mut Pseudonyms::default());
    assert_eq!(
        out["spec"]["source"]["helm"]["parameters"][0]["value"],
        SECRET_MARKER
    );
    assert_eq!(out["spec"]["source"]["helm"]["parameters"][1]["value"], "3");
    let names = [
        "DB_PW",
        "AWS_ACCESS_KEY",
        "STRIPE_KEY",
        "SENTRY_DSN",
        "DB_PASS",
        "tls.key",
        "ADMIN_PWD",
    ];
    let extra: Vec<Value> = names
        .iter()
        .map(|n| json!({"name": n, "value": "hunter2"}))
        .collect();
    let release = json!({"kind": "HelmRelease", "spec": {"values": {"extraEnv": extra}}});
    let (out, c) = redact_value(&release, &NONE, &mut Pseudonyms::default());
    clean(&out.to_string());
    assert_eq!(c.secrets, names.len() as u32);
    for kept in ["LOG_LEVEL", "MONKEY", "HOST", "PORT"] {
        assert!(!SECRET_NAME.is_match(kept), "{kept}");
    }
}

/// M6: the hostname layer skips field paths, class names and project domains.
#[test]
fn hostnames_skip_field_paths_classes_and_project_domains() {
    let kept = "spec.template.metadata status.app user.id http.host com.acme.OrderService.process \
                java.lang.NullPointerException OrderService.java prometheus.io/scrape \
                cert-manager.io/cluster-issuer argocd.argoproj.io/sync-wave helm.sh/chart \
                kapp.k14s.io/original toolkit.fluxcd.io/name sidecar.istio.io/inject linkerd.io/inject \
                deployment.apps/web replicaset.apps pod.status.containerStatuses";
    assert_eq!(text(kept, &HOSTS_ONLY), kept);
    let hosts =
        "api.acme.com db.shop.svc nas.lan mail.example.co.uk grafana.acme.dev db.acme.internal";
    let (out, c) = redact_text(hosts, &HOSTS_ONLY, &mut Pseudonyms::default());
    assert_eq!(
        out,
        "__HOST_1__ __HOST_2__ __HOST_3__ __HOST_4__ __HOST_5__ __HOST_6__"
    );
    assert_eq!(c.hostnames, 6);
}

/// Low: more token shapes.
#[test]
fn more_token_shapes_are_masked() {
    for (input, expected) in [
        (
            "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz",
            "__TOKEN__",
        ),
        ("glpat-abcdefghij0123456789", "__TOKEN__"),
        (
            "sk_live_abcdefghij0123456789 rk_test_ABCDEFGHIJ0123456789",
            "__TOKEN__ __TOKEN__",
        ),
        (
            "Authorization: Token 0123456789abcdef",
            "Authorization: Token __TOKEN__",
        ),
        ("curl -H 'Bearer abc12345'", "curl -H 'Bearer __TOKEN__'"),
        (
            "DB_PASS=hunter2 bypass: true",
            "DB_PASS=__TOKEN__ bypass: true",
        ),
        (
            "password:\n  hunter2\nnext: 1",
            "password:\n  __TOKEN__\nnext: 1",
        ),
        (
            "token:\n  expirationSeconds: 3600",
            "token:\n  expirationSeconds: 3600",
        ),
        (
            "login?user=bob&password%3Dhunter2",
            "login?user=bob&password%3D__TOKEN__",
        ),
        (
            "run --password hunter2 --verbose",
            "run --password __TOKEN__ --verbose",
        ),
        (
            r#"args: ["--db-token","s3cr3tvalue"]"#,
            r#"args: ["--db-token","__TOKEN__"]"#,
        ),
        (
            "args:\n- --password\n- hunter2\n",
            "args:\n- --password\n- __TOKEN__\n",
        ),
        (
            "kubeadm join --token abcdef.0123456789abcdef",
            "kubeadm join --token __TOKEN__",
        ),
        (
            "redis://:pa@ss@cache:6379/0",
            "redis://__TOKEN__@cache:6379/0",
        ),
        (
            "Bearer authentication failed",
            "Bearer authentication failed",
        ),
    ] {
        assert_eq!(text(input, &TOKENS_ONLY), expected, "{input}");
    }
}

/// Low: duplicate keys and aliases cannot move a value past the rules.
#[test]
fn duplicate_keys_and_aliases_fail_closed() {
    let dup = "apiVersion: v1\nkind: Secret\nkind: ConfigMap\ndata:\n  A: aHVudGVyMg==\n";
    let out = manifest(dup);
    assert_eq!(out, SECRET_MARKER);
    let dup_json = r#"{"kind":"Secret","kind":"ConfigMap","data":{"A":"aHVudGVyMg=="}}"#;
    manifest(dup_json);
    let alias =
        "apiVersion: v1\nkind: Secret\ndata:\n  A: &pw aHVudGVyMg==\nmetadata:\n  name: *pw\n";
    let out = manifest(alias);
    assert!(out.contains("kind: Secret"), "{out}");
}

/// Low: the line fallback pairs names and values anywhere in an item, reads
/// tagged kinds, keeps only top-level identity keys and drops multi-line
/// quoted values.
#[test]
fn broken_manifests_pair_values_names_and_quotes() {
    let before = "kind: Pod\nspec:\n  image: [broken\n  env:\n  - value: hunter2\n    description: db\n    name: DB_PASSWORD\n  - name: MODE\n    value: prod\n";
    let out = manifest(before);
    assert_eq!(out, SECRET_MARKER);
    let tagged = "apiVersion: v1\nkind: !!str Secret\ndata: [broken\n  A: aHVudGVyMg==\n";
    manifest(tagged);
    let data_kind = r#"{"apiVersion":"v1","kind":"Secret","data":{"kind":"aHVudGVyMg==","apiVersion":"czNjcjN0""#;
    let out = manifest(data_kind);
    assert!(!out.contains("czNjcjN0"), "{out}");
    let quoted = "kind: Pod\nmetadata:\n  annotations:\n    kubectl.kubernetes.io/last-applied-configuration: '{\"a\":\n      \"hunter2\"}'\n    team: x\nspec: [broken\n";
    let out = manifest(quoted);
    assert_eq!(out, SECRET_MARKER);
}

/// Low: cheap IP fixes.
#[test]
fn ip_shapes() {
    for (input, expected) in [
        (
            "add::dec cafe::face 3.10.0.1-rc repo/app:1.2.3.4",
            "add::dec cafe::face 3.10.0.1-rc repo/app:1.2.3.4",
        ),
        // Dotted IPs are numbered before `ip-a-b-c-d` names (pass order).
        (
            "ip-10-0-3-7.ec2.internal x10.0.0.1 ip-127-0-0-1",
            "__IP_2__.ec2.internal x__IP_1__ ip-127-0-0-1",
        ),
    ] {
        assert_eq!(text(input, &IPS_ONLY), expected, "{input}");
    }
}

#[test]
fn recovered_review_structured_secrets_in_logs_and_all_fence_styles() {
    let pod = "apiVersion: v1\nkind: Pod\nspec:\n  containers:\n  - env:\n    - name: DB_PASSWORD\n      value: hunter2\n";
    let secret = "kind: Secret\ndata:\n  DB_URL: cG9zdGdyZXM6Ly9hcHA6aHVudGVyMkBkYg==\n";
    for input in [
        format!("~~~yaml\n{pod}~~~\n"),
        format!("```yaml\n{pod}"),
        format!("why?\n{pod}"),
        format!("```console\n$ kubectl get secret\n{secret}```\n"),
        format!("````markdown\n```yaml\n{pod}```\n````\n"),
        r#"INFO object {"kind":"Secret","data":{"DB_URL":"cG9zdGdyZXM6Ly9hcHA6aHVudGVyMkBkYg=="}}"#
            .to_string(),
    ] {
        for redact in [redact_text, redact_message] {
            let out = redact(&input, &NONE, &mut Pseudonyms::default()).0;
            assert!(
                !out.contains("hunter2") && !out.contains("cG9zdGdyZXM6"),
                "{out}"
            );
        }
    }
}

#[test]
fn recovered_review_malformed_embedded_and_escaped_structures_fail_closed() {
    for input in [
        r#"{"kind":"\u0053ecret","data":{"A":"hunter2""#,
        "kind: Pod\nspec:\n  image: [broken\n  env:\n  - {name: DB_PASSWORD,\n     value: hunter2}\n",
        "kind: Pod\nspec:\n  image: [broken\n  env:\n  - name: DB_PASSWORD\n    value: &pw |\n      hunter2\n",
        "kind: Pod\nx: &pw hunter2\nspec:\n  env:\n  - name: DB_PASSWORD\n    value: *pw\n",
    ] {
        assert!(!manifest(input).contains("hunter2"), "{input}");
    }
    for embedded in [
        r#"[{"name":"DB_PASSWORD","value":"hunter2"}]"#,
        r#"{"kind":"Pod","spec":{"env":[{"name":"DB_PASSWORD","value":"hunter2""#,
    ] {
        let input = json!({"kind":"Deployment","metadata":{"annotations":{"copy":embedded}}});
        assert!(!redact_value(&input, &NONE, &mut Pseudonyms::default())
            .0
            .to_string()
            .contains("hunter2"));
    }
    let input = json!({"kind":"List","items":[{"data":{"A":"hunter2"},"type":"Opaque"}]});
    assert!(!redact_value(&input, &NONE, &mut Pseudonyms::default())
        .0
        .to_string()
        .contains("hunter2"));
}

#[test]
fn recovered_review_wrapped_pem_and_quoted_credentials() {
    let encoded = STANDARD.encode(PEM);
    let wrapped = encoded
        .as_bytes()
        .chunks(76)
        .map(|c| std::str::from_utf8(c).unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    let out = text(&wrapped, &NONE);
    assert!(!out.contains(&encoded[76..100]), "{out}");
    for input in [
        r#"{"password":"correct horse battery staple"}"#,
        r#"{"password":"hun\"ter2abc"}"#,
        "--password 'hunter2 xyz'",
        "password: correct horse battery staple\n",
    ] {
        let out = text(input, &TOKENS_ONLY);
        assert!(
            !out.contains("horse") && !out.contains("ter2abc") && !out.contains("xyz"),
            "{out}"
        );
    }
}

#[test]
fn final_review_escaped_keys_aliases_and_quoted_armor_fail_closed() {
    for password in ["correct: horse battery staple", "{hunter2}", "[hunter2]"] {
        let out = text(&json!({"password":password}).to_string(), &TOKENS_ONLY);
        assert!(!out.contains("horse") && !out.contains("hunter2"), "{out}");
    }
    let alias = "kind: \"Secr\\x65t\"\ndata: {A: &pw hunter2}\nmetadata: {name: *pw}\n";
    assert!(!manifest(alias).contains("hunter2"));
    let encoded = r#"{"k\u0069nd":"Secret","d\u0061ta":{"A":"hunter2"}}"#;
    assert!(!text(encoded, &NONE).contains("hunter2"));
    let body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC";
    for input in [
        format!("-----BEGIN PRIVATE KEY-----\nComment: \"quoted comment\"\n\n{body}\n"),
        format!("{{\"msg\":\"{body}\"}}\n{{\"msg\":\"-----END PRIVATE KEY-----\"}}\n"),
    ] {
        assert!(!text(&input, &NONE).contains(body));
    }
}

#[test]
fn hostname_masking_does_not_exempt_real_domains_that_look_like_field_roots() {
    let names = "status.acme.com data.prod.acme.io api.acme.bank db.acme.zone";
    let out = text(names, &HOSTS_ONLY);
    for name in names.split(' ') {
        assert!(!out.contains(name), "{out}");
    }
    assert_eq!(out, "__HOST_1__ __HOST_2__ __HOST_3__ __HOST_4__");
}
