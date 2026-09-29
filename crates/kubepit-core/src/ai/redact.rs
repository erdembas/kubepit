//! Redaction of everything the assistant may send (spec D8).
//!
//! **Always on**, whatever the settings say:
//! - the values of Secret-like kinds (every leaf of `data`, `stringData`,
//!   `encryptedData` and `spec`), `env[].value`s with a secret-looking name
//!   and PEM private keys become [`SECRET_MARKER`];
//! - `metadata.managedFields` and the last-applied annotation are removed.
//!
//! **Optional** ([`RedactOptions`], from `Settings.ai.redaction`): tokens
//! (JWTs, bearer tokens, cloud keys, URL credentials, `password=…` values)
//! become [`TOKEN_MARKER`]; IP addresses and hostnames become `__IP_n__` /
//! `__HOST_n__` placeholders from [`Pseudonyms`], which stay consistent for a
//! session and can be restored locally.
//!
//! Text passes run in a fixed order: PEM → tokens → URL userinfo → IPs →
//! hostnames. Every pattern is compiled once, and the output of a pass is
//! never matched again by an earlier layer, so redacting redacted text
//! changes nothing.

use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap};
use std::net::Ipv6Addr;
use std::sync::LazyLock;

use regex::{Captures, Regex};
use serde::Deserialize;
use serde_json::{Map, Value};

use super::types::AiRedactionSettings;
use crate::history::redact::secret_like;

pub use super::types::RedactionCounts;

/// Replaces secret values (always on).
pub const SECRET_MARKER: &str = "__SECRET__";
/// Replaces tokens and credentials (optional layer).
pub const TOKEN_MARKER: &str = "__TOKEN__";

const LAST_APPLIED: &str = "kubectl.kubernetes.io/last-applied-configuration";
/// Fields of a Secret-like object whose leaves are all secret.
const SECRET_FIELDS: [&str; 4] = ["data", "stringData", "encryptedData", "spec"];
/// Deeper values are replaced whole (parsers stop far earlier).
const MAX_DEPTH: usize = 256;

/// Domains (and their subdomains) that are public infrastructure, not
/// something to hide.
const ALLOWED_DOMAINS: &[&str] = &[
    "kubernetes.io",
    "k8s.io",
    "x-k8s.io",
    "cluster.local",
    "docker.io",
    "ghcr.io",
    "gcr.io",
    "quay.io",
    "registry.k8s.io",
];
/// A last label from this list makes a dotted name a file, not a host.
const FILE_EXTENSIONS: &[&str] = &[
    "py", "go", "js", "ts", "java", "yaml", "yml", "json", "log", "txt", "sh", "conf", "xml",
    "html", "md", "rb", "rs", "jar", "class", "so", "lock", "tmp", "pid", "sock", "crt", "key",
    "pem", "cfg", "ini",
];

/// Which optional layers run. Secret values are redacted regardless.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RedactOptions {
    pub tokens: bool,
    pub ips: bool,
    pub hostnames: bool,
}

impl From<&AiRedactionSettings> for RedactOptions {
    fn from(settings: &AiRedactionSettings) -> Self {
        Self {
            tokens: settings.tokens,
            ips: settings.ips,
            hostnames: settings.hostnames,
        }
    }
}

/// What a placeholder stands for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum PseudoKind {
    /// `__IP_<n>__`
    Ip,
    /// `__HOST_<n>__`
    Host,
}

/// Consistent placeholders for IPs and hostnames: the same original always
/// gets the same placeholder, numbered from 1 per kind in first-seen order.
/// Kept per session so the model can reason about "the same host" across
/// turns, and so answers can be restored locally ([`Self::restore_map`]).
#[derive(Debug, Clone, Default)]
pub struct Pseudonyms {
    ips: HashMap<String, String>,
    hosts: HashMap<String, String>,
    restore: BTreeMap<String, String>,
}

impl Pseudonyms {
    /// The placeholder for `original`, allocating the next number on first
    /// sight.
    pub fn placeholder(&mut self, kind: PseudoKind, original: &str) -> String {
        let map = match kind {
            PseudoKind::Ip => &mut self.ips,
            PseudoKind::Host => &mut self.hosts,
        };
        if let Some(existing) = map.get(original) {
            return existing.clone();
        }
        let n = map.len() + 1;
        let placeholder = match kind {
            PseudoKind::Ip => format!("__IP_{n}__"),
            PseudoKind::Host => format!("__HOST_{n}__"),
        };
        map.insert(original.to_string(), placeholder.clone());
        self.restore
            .insert(placeholder.clone(), original.to_string());
        placeholder
    }

    /// Placeholder → original, for restoring answers locally. Never sent.
    pub fn restore_map(&self) -> BTreeMap<String, String> {
        self.restore.clone()
    }
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

fn compile(pattern: &str) -> Regex {
    Regex::new(pattern).expect("valid redaction pattern")
}

const PEM_BEGIN: &str = r"-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----";
const PEM_END: &str = r"-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----";
/// A line break inside a PEM body: real (LF, CRLF) or JSON-escaped.
const PEM_NL: &str = r"[ \t]*(?:\r?\n|\\r\\n|\\n)[ \t]*";
/// An optional log timestamp in front of a body line (`timestamps: true`).
const PEM_TS: &str = r"(?:[0-9][0-9TZ:.+-]{9,}[ \t]+)?";

/// A complete private key block.
static PEM_BLOCK: LazyLock<Regex> =
    LazyLock::new(|| compile(&format!(r"{PEM_BEGIN}[\s\S]*?{PEM_END}")));
/// A block cut before its end (a log tail, a trimmed section): the header
/// and the whole base64 lines after it (a last line only when the text or
/// the JSON string ends there).
static PEM_HEAD: LazyLock<Regex> = LazyLock::new(|| {
    compile(&format!(
        r#"{PEM_BEGIN}(?:{PEM_NL}(?:{PEM_TS}[A-Za-z0-9+/=]*{PEM_NL})*(?:{PEM_TS}[A-Za-z0-9+/=]+(?:\z|["']))?)?"#
    ))
});
/// A block cut before its start: the base64 lines before the footer.
static PEM_TAIL: LazyLock<Regex> = LazyLock::new(|| {
    compile(&format!(
        r"(?:[A-Za-z0-9+/=]{{16,}}{PEM_NL}{PEM_TS})*[A-Za-z0-9+/=]+{PEM_NL}{PEM_TS}{PEM_END}"
    ))
});

/// Self-describing tokens. `bearer` / `basic` keep their prefix.
static TOKENS: LazyLock<Regex> = LazyLock::new(|| {
    compile(concat!(
        r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}",
        r"|(?P<bearer>(?-u:\b)(?i:bearer)[ \t]+)[A-Za-z0-9._~+/-]{16,}=*",
        r#"|(?P<basic>(?-u:\b)(?i:authorization)"?[ \t]*[:=][ \t]*"?(?i:basic)[ \t]+)[A-Za-z0-9+/]{8,}={0,2}"#,
        r"|(?:AKIA|ASIA)[0-9A-Z]{16}",
        r"|gh[pousr]_[A-Za-z0-9]{36,}",
        r"|(?-u:\b)xox[baprs]-[A-Za-z0-9-]{10,}",
        r"|AIza[A-Za-z0-9_-]{35}",
        r"|(?-u:\b)sk-(?:ant-)?[A-Za-z0-9_-]{20,}",
    ))
});
/// `password=…`, `"token": "…"`: the key stays, the value goes.
static KEY_VALUE: LazyLock<Regex> = LazyLock::new(|| {
    compile(
        r#"(?i)(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)(["']?[ \t]*[:=][ \t]*["']?)([^\s"',;]{4,})"#,
    )
});
/// The same key names as object keys (structured manifests).
static TOKEN_KEY: LazyLock<Regex> = LazyLock::new(|| {
    compile(r"(?i)(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)$")
});
/// `scheme://user:password@` (the user may be empty: `redis://:pw@`).
static URL_USERINFO: LazyLock<Regex> = LazyLock::new(|| compile(r"://[^/\s:@]*:[^/\s@]+@"));
/// Environment variable names whose values are always secret.
static SECRET_ENV: LazyLock<Regex> = LazyLock::new(|| {
    compile(r"(?i)(pass(word|wd)?|secret|token|api[_-]?key|credential|private[_-]?key|auth)")
});

static IPV4: LazyLock<Regex> = LazyLock::new(|| {
    compile(concat!(
        r"(?-u:\b)(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])",
        r"(?:\.(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}(?-u:\b)",
    ))
});
/// IPv6 candidates (validated with the standard parser).
static IPV6: LazyLock<Regex> = LazyLock::new(|| compile(r"(?i)[0-9a-f]*(?::[0-9a-f.]*){2,}"));
static HOSTNAME: LazyLock<Regex> =
    LazyLock::new(|| compile(r"(?i)(?:[a-z0-9-]+\.)+[a-z]{2,24}(?-u:\b)"));

// Unparsable manifests (see `mask_unparsed_manifest`).
static SECRET_KIND: LazyLock<Regex> =
    LazyLock::new(|| compile(r#""?kind"?[ \t]*:[ \t]*["']?([A-Za-z0-9]+)"#));
static BLOCK_KEY: LazyLock<Regex> = LazyLock::new(|| {
    compile(
        r#"^(?P<pre>[ \t]*(?:-[ \t]+)?)(?P<key>"[^"]*"|'[^']*'|[A-Za-z0-9_.\-/]+)[ \t]*:(?:[ \t]+(?P<value>.*?))?[ \t]*$"#,
    )
});
static FLOW_KEY: LazyLock<Regex> = LazyLock::new(|| {
    compile(
        r#"(?:^|[\s{,\[])(?P<key>"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_.\-/]+)[ \t]*:[ \t]*(?P<value>"(?:[^"\\]|\\.)*"?|'[^']*'?|[^\s,{}\[\]#"'][^,{}\[\]]*)"#,
    )
});

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/// Redacts free text (logs, events, messages, labels, tool results).
pub fn redact_text(
    text: &str,
    opts: &RedactOptions,
    pseudo: &mut Pseudonyms,
) -> (String, RedactionCounts) {
    let mut counts = RedactionCounts::default();
    let out = redact_str(text, opts, pseudo, &mut counts);
    (out.into_owned(), counts)
}

fn redact_str<'t>(
    text: &'t str,
    opts: &RedactOptions,
    pseudo: &mut Pseudonyms,
    counts: &mut RedactionCounts,
) -> Cow<'t, str> {
    let mut cur = Cow::Borrowed(text);
    if cur.contains("PRIVATE KEY") {
        for re in [&*PEM_BLOCK, &*PEM_HEAD, &*PEM_TAIL] {
            replace(&mut cur, re, |_, caps| {
                counts.secrets += 1;
                Some(pem_marker(caps.get(0)?.as_str()))
            });
        }
    }
    if opts.tokens && cur.len() >= 8 {
        if cur.len() >= 16 {
            replace(&mut cur, &TOKENS, |_, caps| {
                counts.tokens += 1;
                let keep = caps
                    .name("bearer")
                    .or_else(|| caps.name("basic"))
                    .map_or("", |m| m.as_str());
                Some(format!("{keep}{TOKEN_MARKER}"))
            });
        }
        if cur.contains([':', '=']) {
            replace(&mut cur, &KEY_VALUE, |_, caps| {
                if starts_with_marker(&caps[3]) {
                    return None;
                }
                counts.tokens += 1;
                Some(format!("{}{}{TOKEN_MARKER}", &caps[1], &caps[2]))
            });
        }
        if cur.contains("://") {
            replace(&mut cur, &URL_USERINFO, |_, _| {
                counts.tokens += 1;
                Some(format!("://{TOKEN_MARKER}@"))
            });
        }
    }
    if opts.ips {
        if cur.contains(':') {
            replace(&mut cur, &IPV6, |hay, caps| {
                let m = caps.get(0)?;
                let (start, end) = ipv6_span(hay, m.start(), m.end())?;
                counts.ips += 1;
                let placeholder = pseudo.placeholder(PseudoKind::Ip, &hay[start..end]);
                Some(format!(
                    "{}{placeholder}{}",
                    &hay[m.start()..start],
                    &hay[end..m.end()]
                ))
            });
        }
        if cur.contains('.') {
            replace(&mut cur, &IPV4, |hay, caps| {
                let m = caps.get(0)?;
                let ip = m.as_str();
                let before = &hay.as_bytes()[..m.start()];
                let after = &hay.as_bytes()[m.end()..];
                // Part of a longer dotted number (a version, an OID).
                let longer = matches!(before, [.., d, b'.'] if d.is_ascii_digit())
                    || matches!(after, [b'.', d, ..] if d.is_ascii_digit());
                if longer || ip.starts_with("127.") || ip == "0.0.0.0" {
                    return None;
                }
                counts.ips += 1;
                Some(pseudo.placeholder(PseudoKind::Ip, ip))
            });
        }
    }
    if opts.hostnames && cur.contains('.') {
        replace(&mut cur, &HOSTNAME, |_, caps| {
            let name = caps.get(0)?.as_str();
            if host_exempt(name) {
                return None;
            }
            counts.hostnames += 1;
            Some(pseudo.placeholder(PseudoKind::Host, name))
        });
    }
    cur
}

/// Replaces every match for which `f` returns a replacement; `f` sees the
/// whole haystack for boundary checks. Leaves `cur` borrowed when nothing
/// changes.
fn replace(
    cur: &mut Cow<'_, str>,
    re: &Regex,
    mut f: impl FnMut(&str, &Captures<'_>) -> Option<String>,
) {
    let mut out = String::new();
    let mut last = 0;
    let mut changed = false;
    {
        let hay: &str = cur;
        for caps in re.captures_iter(hay) {
            let Some(m) = caps.get(0) else { continue };
            if let Some(rep) = f(hay, &caps) {
                if !changed {
                    out.reserve(hay.len());
                    changed = true;
                }
                out.push_str(&hay[last..m.start()]);
                out.push_str(&rep);
                last = m.end();
            }
        }
        if changed {
            out.push_str(&hay[last..]);
        }
    }
    if changed {
        *cur = Cow::Owned(out);
    }
}

/// The marker for a matched key, giving back the line break (or closing
/// quote) a cut block's match ends with.
fn pem_marker(matched: &str) -> String {
    let mut body = matched;
    loop {
        let t = body.trim_end_matches([' ', '\t', '\r', '\n', '"', '\'']);
        let t = t
            .strip_suffix("\\n")
            .or_else(|| t.strip_suffix("\\r"))
            .unwrap_or(t);
        if t.len() == body.len() {
            break;
        }
        body = t;
    }
    format!("{SECRET_MARKER}{}", &matched[body.len()..])
}

fn starts_with_marker(s: &str) -> bool {
    s.starts_with(SECRET_MARKER)
        || s.starts_with(TOKEN_MARKER)
        || s.starts_with("__IP_")
        || s.starts_with("__HOST_")
}

/// The IPv6 address inside a candidate match, or `None` when the candidate
/// is not one (a time, `std::string`, a MAC) or is loopback/unspecified.
fn ipv6_span(hay: &str, start: usize, end: usize) -> Option<(usize, usize)> {
    let bytes = hay.as_bytes();
    let mut s = start;
    let mut e = end;
    while e > s && bytes[e - 1] == b'.' {
        e -= 1;
    }
    // `ip:fe80::1`: a single leading colon is punctuation.
    let separator = bytes.get(s) == Some(&b':') && bytes.get(s + 1) != Some(&b':');
    if separator {
        s += 1;
    }
    let before = hay[..s].chars().next_back();
    let before_ok = match before {
        None => true,
        Some(':') => separator,
        Some(c) => !(c.is_alphanumeric() || c == '_' || c == '.'),
    };
    let after_ok = hay[e..]
        .chars()
        .next()
        .is_none_or(|c| !(c.is_alphanumeric() || c == '_' || c == ':'));
    if !before_ok || !after_ok || s >= e {
        return None;
    }
    let addr: Ipv6Addr = hay[s..e].parse().ok()?;
    let local_v4 = addr
        .to_ipv4_mapped()
        .is_some_and(|v4| v4.is_loopback() || v4.is_unspecified());
    if addr.is_loopback() || addr.is_unspecified() || local_v4 {
        return None;
    }
    Some((s, e))
}

fn host_exempt(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let last = lower.rsplit('.').next().unwrap_or("");
    FILE_EXTENSIONS.contains(&last)
        || ALLOWED_DOMAINS.iter().any(|domain| {
            lower
                .strip_suffix(domain)
                .is_some_and(|rest| rest.is_empty() || rest.ends_with('.'))
        })
}

// ---------------------------------------------------------------------------
// Structured values
// ---------------------------------------------------------------------------

/// Redacts a parsed object (or list, or any JSON value): the always-on
/// object rules, then every string leaf and key through the text passes.
pub fn redact_value(
    value: &Value,
    opts: &RedactOptions,
    pseudo: &mut Pseudonyms,
) -> (Value, RedactionCounts) {
    let mut out = value.clone();
    let counts = redact_value_in_place(&mut out, opts, pseudo);
    (out, counts)
}

fn redact_value_in_place(
    value: &mut Value,
    opts: &RedactOptions,
    pseudo: &mut Pseudonyms,
) -> RedactionCounts {
    let mut walker = Walker {
        opts,
        pseudo,
        counts: RedactionCounts::default(),
    };
    walker.value(value, false, 0);
    walker.counts
}

struct Walker<'a> {
    opts: &'a RedactOptions,
    pseudo: &'a mut Pseudonyms,
    counts: RedactionCounts,
}

impl Walker<'_> {
    /// `inherited_secret`: an item of a `…SecretList` (API lists omit the
    /// items' `kind`).
    fn value(&mut self, value: &mut Value, inherited_secret: bool, depth: usize) {
        if depth > MAX_DEPTH {
            self.secret(value);
            return;
        }
        match value {
            Value::Object(map) => {
                let kind = map.get("kind").and_then(Value::as_str);
                let is_secret = kind.map_or(inherited_secret, secret_like);
                let items_secret = kind
                    .and_then(|k| k.strip_suffix("List"))
                    .is_some_and(secret_like);
                if let Some(Value::Object(meta)) = map.get_mut("metadata") {
                    strip_bookkeeping(meta);
                }
                if let Some(Value::Array(env)) = map.get_mut("env") {
                    self.env(env);
                }
                for (key, child) in map.iter_mut() {
                    if is_secret && SECRET_FIELDS.contains(&key.as_str()) {
                        self.mask_leaves(child, depth + 1);
                    } else if self.opts.tokens && token_leaf(key, child) {
                        *child = Value::String(TOKEN_MARKER.to_string());
                        self.counts.tokens += 1;
                    } else {
                        self.value(child, items_secret && key == "items", depth + 1);
                    }
                }
                self.keys(map);
            }
            Value::Array(items) => {
                for item in items {
                    self.value(item, inherited_secret, depth + 1);
                }
            }
            Value::String(s) => {
                let redacted = match redact_str(s, self.opts, self.pseudo, &mut self.counts) {
                    Cow::Owned(r) => Some(r),
                    Cow::Borrowed(_) => None,
                };
                if let Some(r) = redacted {
                    *s = r;
                }
            }
            Value::Null | Value::Bool(_) | Value::Number(_) => {}
        }
    }

    /// Every scalar leaf becomes the secret marker; keys and structure stay.
    fn mask_leaves(&mut self, value: &mut Value, depth: usize) {
        if depth > MAX_DEPTH {
            self.secret(value);
            return;
        }
        match value {
            Value::Object(map) => {
                for child in map.values_mut() {
                    self.mask_leaves(child, depth + 1);
                }
                self.keys(map);
            }
            Value::Array(items) => {
                for item in items {
                    self.mask_leaves(item, depth + 1);
                }
            }
            Value::Null => {}
            leaf => self.secret(leaf),
        }
    }

    fn secret(&mut self, value: &mut Value) {
        if value.as_str() != Some(SECRET_MARKER) {
            *value = Value::String(SECRET_MARKER.to_string());
            self.counts.secrets += 1;
        }
    }

    /// `env: [{name: DB_PASSWORD, value: …}]`: secret-named values go.
    fn env(&mut self, env: &mut [Value]) {
        for item in env {
            let Value::Object(var) = item else { continue };
            let secret_name = var
                .get("name")
                .and_then(Value::as_str)
                .is_some_and(|name| SECRET_ENV.is_match(name));
            if secret_name {
                if let Some(v) = var.get_mut("value") {
                    if !v.is_null() {
                        self.secret(v);
                    }
                }
            }
        }
    }

    /// Keys go through the text passes too (annotation keys can name hosts).
    fn keys(&mut self, map: &mut Map<String, Value>) {
        let mut renamed = Vec::new();
        for key in map.keys() {
            if let Cow::Owned(new) = redact_str(key, self.opts, self.pseudo, &mut self.counts) {
                renamed.push((key.clone(), new));
            }
        }
        for (old, new) in renamed {
            if let Some(v) = map.remove(&old) {
                map.insert(new, v);
            }
        }
    }
}

fn strip_bookkeeping(meta: &mut Map<String, Value>) {
    meta.remove("managedFields");
    if let Some(Value::Object(annotations)) = meta.get_mut("annotations") {
        annotations.remove(LAST_APPLIED);
        if annotations.is_empty() {
            meta.remove("annotations");
        }
    }
}

/// A scalar under a credential-named key (`password: hunter2`), the
/// structured form of [`KEY_VALUE`].
fn token_leaf(key: &str, value: &Value) -> bool {
    let long_enough = match value {
        Value::String(s) => s.chars().count() >= 4 && !starts_with_marker(s),
        Value::Number(n) => n.to_string().len() >= 4,
        _ => false,
    };
    long_enough && TOKEN_KEY.is_match(key)
}

// ---------------------------------------------------------------------------
// Manifests
// ---------------------------------------------------------------------------

/// Redacts multi-document YAML or JSON and returns YAML. Text that does not
/// parse as objects falls back to [`redact_text`], after a line-based pass
/// that still masks Secret values, secret-named env values and the
/// last-applied annotation (a cut or half-edited manifest must not leak).
pub fn redact_manifest_text(
    text: &str,
    opts: &RedactOptions,
    pseudo: &mut Pseudonyms,
) -> (String, RedactionCounts) {
    let Some(docs) = parse_documents(text) else {
        let (masked, secrets) = mask_unparsed_manifest(text);
        let (out, mut counts) = redact_text(&masked, opts, pseudo);
        counts.secrets += secrets;
        return (out, counts);
    };
    let mut out = String::with_capacity(text.len());
    let mut counts = RedactionCounts::default();
    for (i, mut doc) in docs.into_iter().enumerate() {
        counts.add(&redact_value_in_place(&mut doc, opts, pseudo));
        if i > 0 {
            out.push_str("---\n");
        }
        match serde_yaml::to_string(&doc) {
            Ok(yaml) => out.push_str(&yaml),
            // Cannot happen for JSON values; never fall back to the input.
            Err(_) => out.push_str(SECRET_MARKER),
        }
    }
    (out, counts)
}

/// The documents of `text` when every one is an object or a list.
fn parse_documents(text: &str) -> Option<Vec<Value>> {
    let trimmed = text.trim_start();
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        if let Ok(value) = serde_json::from_str::<Value>(text) {
            return Some(vec![value]);
        }
    }
    let mut docs = Vec::new();
    for doc in serde_yaml::Deserializer::from_str(text) {
        match Value::deserialize(doc).ok()? {
            Value::Null => {}
            value @ (Value::Object(_) | Value::Array(_)) => docs.push(value),
            _ => return None,
        }
    }
    (!docs.is_empty()).then_some(docs)
}

fn secret_kind(kind: &str) -> bool {
    secret_like(kind) || kind.strip_suffix("List").is_some_and(secret_like)
}

/// Line-based masking for manifests that do not parse. In a document that
/// names a Secret-like kind every value is masked except `apiVersion`,
/// `kind` and the object's `metadata.name` / `namespace`; elsewhere the
/// value next to a secret-named `name` and the last-applied annotation are.
/// Block scalars under a masked key are dropped. Returns the text and the
/// number of masked values.
fn mask_unparsed_manifest(text: &str) -> (String, u32) {
    let mut out = String::with_capacity(text.len());
    let mut masked = 0u32;
    for doc in split_documents(text) {
        let mut state = LineState {
            secret_doc: SECRET_KIND.captures_iter(doc).any(|c| secret_kind(&c[1])),
            top: String::new(),
            env_lines: 0,
            masked: 0,
        };
        let mut drop_deeper_than: Option<usize> = None;
        for raw in doc.split_inclusive('\n') {
            let line = raw.trim_end_matches(['\n', '\r']);
            let eol = &raw[line.len()..];
            let indent = line.len() - line.trim_start_matches([' ', '\t']).len();
            // Lines of a masked block scalar are dropped with it.
            if drop_deeper_than.is_some_and(|column| line.trim().is_empty() || indent > column) {
                continue;
            }
            state.env_lines = state.env_lines.saturating_sub(1);
            let (new, drop) = state.line(line);
            drop_deeper_than = drop;
            out.push_str(&new);
            out.push_str(eol);
        }
        masked += state.masked;
    }
    (out, masked)
}

/// `---` lines start a new document.
fn split_documents(text: &str) -> Vec<&str> {
    let mut docs = Vec::new();
    let mut start = 0;
    let mut pos = 0;
    for line in text.split_inclusive('\n') {
        let t = line.trim_end();
        if pos > start && (t == "---" || t.starts_with("--- ")) {
            docs.push(&text[start..pos]);
            start = pos;
        }
        pos += line.len();
    }
    docs.push(&text[start..]);
    docs
}

struct LineState {
    secret_doc: bool,
    /// The current top-level key (block YAML).
    top: String,
    /// Lines left in which a `value` follows a secret-named `name`.
    env_lines: u8,
    masked: u32,
}

impl LineState {
    /// The masked line and, when a block scalar was masked, the column
    /// below which its lines are dropped.
    fn line<'l>(&mut self, line: &'l str) -> (Cow<'l, str>, Option<usize>) {
        if let Some(c) = BLOCK_KEY.captures(line) {
            let pre = c.name("pre").map_or("", |m| m.as_str());
            let key = unquote(c.name("key").map_or("", |m| m.as_str()));
            if pre.is_empty() {
                self.top = key.to_string();
            }
            let Some(value) = c.name("value") else {
                return (Cow::Borrowed(line), None);
            };
            if self.should_mask(key, value.as_str(), pre.is_empty()) {
                self.masked += 1;
                let drop = value.as_str().starts_with(['|', '>']).then_some(pre.len());
                return (
                    Cow::Owned(format!("{}{SECRET_MARKER}", &line[..value.start()])),
                    drop,
                );
            }
            return (self.flow(line, value.start()).0, None);
        }
        let (flowed, found_key) = self.flow(line, 0);
        if self.secret_doc && !found_key && line.chars().any(char::is_alphanumeric) {
            self.masked += 1;
            let indent = line.len() - line.trim_start().len();
            return (
                Cow::Owned(format!("{}{SECRET_MARKER}", &line[..indent])),
                None,
            );
        }
        (flowed, None)
    }

    /// `{key: value, …}` / `"key": "value"` pairs from byte `from` on; also
    /// says whether there was any.
    fn flow<'l>(&mut self, line: &'l str, from: usize) -> (Cow<'l, str>, bool) {
        let mut out = String::new();
        let mut last = 0;
        let mut changed = false;
        let mut found = false;
        for c in FLOW_KEY.captures_iter(&line[from..]) {
            let (Some(key), Some(value)) = (c.name("key"), c.name("value")) else {
                continue;
            };
            found = true;
            if self.should_mask(unquote(key.as_str()), value.as_str(), false) {
                self.masked += 1;
                out.push_str(&line[last..from + value.start()]);
                out.push_str(SECRET_MARKER);
                last = from + value.end();
                changed = true;
            }
        }
        if !changed {
            return (Cow::Borrowed(line), found);
        }
        out.push_str(&line[last..]);
        (Cow::Owned(out), found)
    }

    fn should_mask(&mut self, key: &str, value: &str, top_level: bool) -> bool {
        let plain = unquote(value);
        if plain.is_empty() || starts_with_marker(plain) || matches!(plain, "{" | "[") {
            return false;
        }
        if key == LAST_APPLIED {
            return true;
        }
        if self.secret_doc {
            let identity = matches!(key, "apiVersion" | "kind")
                || (top_level && key == "type")
                || (self.top == "metadata" && !top_level && matches!(key, "name" | "namespace"));
            return !identity;
        }
        if key == "name" {
            if SECRET_ENV.is_match(plain) {
                self.env_lines = 3;
            }
            return false;
        }
        if key == "value" && self.env_lines > 0 {
            self.env_lines = 0;
            return true;
        }
        false
    }
}

fn unquote(s: &str) -> &str {
    let s = s.trim().trim_end_matches(',').trim_end();
    s.strip_prefix('"')
        .map(|r| r.strip_suffix('"').unwrap_or(r))
        .or_else(|| {
            s.strip_prefix('\'')
                .map(|r| r.strip_suffix('\'').unwrap_or(r))
        })
        .unwrap_or(s)
}

#[cfg(test)]
mod tests {
    use super::*;
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
            out.contains("PASSWORD: __SECRET__")
                && out.contains("LOG_LEVEL")
                && out.contains("debug")
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

    // -- Beyond the plan -----------------------------------------------------

    #[test]
    fn options_follow_the_settings() {
        let opts = RedactOptions::from(&AiRedactionSettings::default());
        assert_eq!(
            opts,
            RedactOptions {
                tokens: true,
                ips: false,
                hostnames: false
            }
        );
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
        let (out, c) = redact_text(text, &RedactOptions { ips: true, ..NONE }, &mut p);
        assert_eq!(
            out,
            "pod __IP_1__ via [__IP_2__]:8080, mapped __IP_3__, \
             full __IP_4__; loopback ::1 and ::; \
             std::string at 10:32:05, mac aa:bb:cc:dd:ee:ff, again __IP_1__."
        );
        assert_eq!(c.ips, 5);
        assert_eq!(p.restore_map()["__IP_2__"], "2001:db8::1");
        let (colon, _) = redact_text(
            "addr:fe80::2 ok",
            &RedactOptions { ips: true, ..NONE },
            &mut p,
        );
        assert_eq!(colon, "addr:__IP_5__ ok");
    }

    #[test]
    fn dotted_versions_are_not_ips() {
        let text = "version 1.2.3.4.5 oid 1.3.6.1.4.1 v10.0.0.1 ip 10.0.0.1:443 cidr 10.0.0.0/16.";
        let (out, c) = redact_text(
            text,
            &RedactOptions { ips: true, ..NONE },
            &mut Pseudonyms::default(),
        );
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
        // Ordinary words after a cut key stay.
        let words = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nnext line";
        let (out, _) = redact_text(words, &NONE, &mut Pseudonyms::default());
        assert_eq!(out, "__SECRET__\nnext line");
        // JSON-escaped, cut before the end, with and without the closing quote.
        let json = r#"{"key": "-----BEGIN EC PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nMIIEvQIBADAN"#;
        let (out, _) = redact_text(json, &NONE, &mut Pseudonyms::default());
        assert_eq!(out, r#"{"key": "__SECRET__"#);
        let closed = r#"{"key": "-----BEGIN EC PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nMIIEvQIBADAN", "next": 1}"#;
        let (out, _) = redact_text(closed, &NONE, &mut Pseudonyms::default());
        assert_eq!(out, r#"{"key": "__SECRET__", "next": 1}"#);
    }

    #[test]
    fn very_long_lines_are_redacted_in_full() {
        let filler = "x".repeat(300_000);
        let text = format!("{filler} token=s3cr3tvalue 10.1.2.3 {filler} AKIAIOSFODNN7EXAMPLE");
        let start = std::time::Instant::now();
        let (out, c) = redact_text(&text, &ALL, &mut Pseudonyms::default());
        assert!(start.elapsed() < std::time::Duration::from_secs(2));
        clean(&out);
        assert!(!out.contains("s3cr3tvalue") && out.contains("__IP_1__"));
        assert_eq!((c.tokens, c.ips), (2, 1));
    }

    #[test]
    fn redaction_is_idempotent() {
        let text =
            "Bearer abcdefghijklmnopqrstuvwxyz0123 password=hunter2 10.0.3.7 db.acme.internal \
                    postgres://app:hunter2@db.acme.internal:5432 fe80::1";
        let mut p = Pseudonyms::default();
        let (once, _) = redact_text(text, &ALL, &mut p);
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
        let (out, c) = redact_value(
            &cm,
            &RedactOptions {
                tokens: true,
                ..NONE
            },
            &mut Pseudonyms::default(),
        );
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
        let (out, c) = redact_value(
            &deploy,
            &RedactOptions {
                hostnames: true,
                ..NONE
            },
            &mut Pseudonyms::default(),
        );
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
        }
        for text in [
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
        ] {
            let _ = redact_manifest_text(text, &ALL, &mut Pseudonyms::default());
            let _ = redact_text(text, &ALL, &mut Pseudonyms::default());
        }
    }

    #[test]
    fn cut_or_broken_manifests_still_hide_secret_values() {
        let cut_json = r#"{"apiVersion":"v1","kind":"Secret","metadata":{"name":"db"},"data":{"PASSWORD":"aHVudGVyMg==","TOKEN":"czNjcjN0"#;
        let (out, c) = redact_manifest_text(cut_json, &NONE, &mut Pseudonyms::default());
        clean(&out);
        assert!(
            !out.contains("czNjcjN0") && out.contains(r#""kind":"Secret""#),
            "{out}"
        );
        assert!(c.secrets >= 2);

        let tabs = "apiVersion: v1\nkind: Secret\nmetadata:\n  name: db\ntype: Opaque\ndata:\n\tPASSWORD: aHVudGVyMg==\n\
                    stringData:\n  cert: |\n    line-one-s3cr3t\n    line-two\n  note: \"multi\n    hunter2\"\n";
        let (out, _) = redact_manifest_text(tabs, &NONE, &mut Pseudonyms::default());
        clean(&out);
        assert!(!out.contains("line-two"), "{out}");
        assert!(
            out.contains("kind: Secret")
                && out.contains("name: db")
                && out.contains("type: Opaque"),
            "{out}"
        );

        let pod = "kind: Pod\nmetadata:\n  name: web\n  annotations:\n    kubectl.kubernetes.io/last-applied-configuration: |\n      {\"env\":\"hunter2\"}\n\
                   spec:\n  containers:\n  - name: app\n    image: [broken\n    env:\n    - name: DB_PASSWORD\n      value: hunter2\n\
                   \x20   - {name: API_TOKEN, value: s3cr3t}\n    - name: LOG_LEVEL\n      value: debug\n";
        let (out, c) = redact_manifest_text(pod, &NONE, &mut Pseudonyms::default());
        clean(&out);
        assert!(
            out.contains("value: debug") && out.contains("name: app"),
            "{out}"
        );
        assert_eq!(c.secrets, 3);

        let cut_pretty = "{\n  \"kind\": \"Pod\",\n  \"spec\": {\"containers\": [{\"env\": [\n    {\n      \"name\": \"DB_PASSWORD\",\n      \"value\": \"hunter2\"\n    },\n    {\"name\": \"MODE\", \"value\": \"prod\"";
        let (out, _) = redact_manifest_text(cut_pretty, &NONE, &mut Pseudonyms::default());
        clean(&out);
        assert!(out.contains("\"prod\""), "{out}");
    }
}
