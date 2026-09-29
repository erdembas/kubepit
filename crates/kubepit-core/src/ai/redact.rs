//! Redaction of everything the assistant may send (spec D8).
//!
//! **Always on**, whatever the settings say — every rule fails closed:
//! - Secret-like objects: every leaf of `data`, `stringData`,
//!   `encryptedData` and `spec`, and every annotation value except the
//!   service-account ones, become [`SECRET_MARKER`]. A document without a
//!   `kind` that carries `data` / `stringData` / `encryptedData` counts as
//!   one (a cut or partial manifest), and so do kind-less items of lists;
//! - the `value` next to a secret-looking `name` (`env`, Helm parameters,
//!   `extraEnv`, …);
//! - PEM private keys: complete, cut before their end or start (masked to
//!   a blank line, a quote or the end of the text), or base64-wrapped;
//! - manifests embedded in strings (an annotation holding a copy of the
//!   object) are parsed and redacted by the same rules;
//! - `metadata.managedFields` and the last-applied annotation are removed.
//!
//! **Optional** ([`RedactOptions`], from `Settings.ai.redaction`): tokens
//! (JWTs, bearer tokens, cloud and forge keys, URL credentials,
//! `password=…` values and flags) become [`TOKEN_MARKER`]; IP addresses and
//! hostnames become `__IP_n__` / `__HOST_n__` placeholders from
//! [`Pseudonyms`], which stay consistent for a session and can be restored
//! locally.
//!
//! Text passes run in a fixed order: keys → tokens → URL userinfo → IPs →
//! hostnames. Every pattern is compiled once, and no pass matches the
//! output of a pass, so redacting redacted text changes nothing.

use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::net::Ipv6Addr;
use std::sync::LazyLock;

use base64::alphabet;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use base64::Engine as _;
use regex::{Captures, Regex};
use serde::de::{self, Deserializer, MapAccess, SeqAccess, Visitor};
use serde::Deserialize;
use serde_json::{Map, Number, Value};

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
/// Top-level fields that make a document without `kind` a Secret.
const SECRET_DATA_FIELDS: [&str; 3] = ["data", "stringData", "encryptedData"];
/// Annotations of a Secret-like object that name something rather than
/// hold a value.
const KEPT_SECRET_ANNOTATIONS: [&str; 2] = [
    "kubernetes.io/service-account.name",
    "kubernetes.io/service-account.uid",
];
/// Keys whose presence makes a parsed string an embedded manifest.
const MANIFEST_KEYS: [&str; 5] = ["kind", "apiVersion", "data", "stringData", "encryptedData"];
/// Deeper values are replaced whole (parsers stop far earlier).
const MAX_DEPTH: usize = 256;

/// Domains (and their subdomains) that are public infrastructure, not
/// something to hide (the plan's list).
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
/// Well-known annotation and label domains of public projects.
const PROJECT_DOMAINS: &[&str] = &[
    "prometheus.io",
    "cert-manager.io",
    "argoproj.io",
    "helm.sh",
    "k14s.io",
    "fluxcd.io",
    "istio.io",
    "linkerd.io",
];
/// A last label from this list makes a dotted name a file, not a host.
const FILE_EXTENSIONS: &[&str] = &[
    "py", "go", "js", "ts", "java", "yaml", "yml", "json", "log", "txt", "sh", "conf", "xml",
    "html", "md", "rb", "rs", "jar", "class", "so", "lock", "tmp", "pid", "sock", "crt", "key",
    "pem", "cfg", "ini",
];
/// Generic top-level domains a hostname may end with; any two-letter
/// country code counts too.
const GENERIC_TLDS: &[&str] = &[
    "com",
    "net",
    "org",
    "info",
    "biz",
    "dev",
    "app",
    "cloud",
    "tech",
    "xyz",
    "site",
    "online",
    "page",
    "gov",
    "edu",
    "mil",
    "int",
    "mobi",
    "pro",
    "asia",
    "live",
    "store",
    "shop",
    "blog",
    "network",
    "systems",
    "services",
    "solutions",
    "digital",
    "studio",
    "global",
];
/// Suffixes of private networks.
const PRIVATE_TLDS: &[&str] = &[
    "internal",
    "local",
    "lan",
    "corp",
    "svc",
    "home",
    "intranet",
    "private",
    "localdomain",
];
/// Two-letter labels that are field names far more often than countries.
const FIELD_LABELS: &[&str] = &["id", "ip", "os", "ms", "ns"];
/// First labels of field paths (`spec.template`, `status.phase`).
const FIELD_ROOTS: &[&str] = &[
    "metadata",
    "spec",
    "status",
    "data",
    "template",
    "containers",
];
/// First labels of package paths (with a capitalized class segment).
const PACKAGE_ROOTS: &[&str] = &[
    "java", "javax", "jakarta", "kotlin", "scala", "android", "com", "org", "net", "io", "sun",
    "jdk",
];
/// PEM / OpenPGP armor headers, which may sit between a key's first line
/// and a blank line before its body.
const ARMOR_HEADERS: [&str; 7] = [
    "Proc-Type:",
    "DEK-Info:",
    "Version:",
    "Comment:",
    "Hash:",
    "Charset:",
    "MessageID:",
];
/// `-----BEGIN` in base64 at each of the three byte alignments.
const PEM_BASE64_NEEDLES: [&str; 3] = ["LS0tLS1CRUdJTi", "0tLS0tQkVHSU4", "tLS0tLUJFR0lO"];
const BASE64: GeneralPurpose = GeneralPurpose::new(
    &alphabet::STANDARD,
    GeneralPurposeConfig::new()
        .with_decode_padding_mode(DecodePaddingMode::Indifferent)
        .with_decode_allow_trailing_bits(true),
);

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
/// Credential key names (text form); `pass` only after a non-letter.
const CREDENTIAL_KEY: &str = r"(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|(?:^|[^a-z])pass)";

/// A complete private key block.
static PEM_BLOCK: LazyLock<Regex> =
    LazyLock::new(|| compile(&format!(r"{PEM_BEGIN}[\s\S]*?{PEM_END}")));
static PEM_HEADER: LazyLock<Regex> = LazyLock::new(|| compile(PEM_BEGIN));
static PEM_FOOTER: LazyLock<Regex> = LazyLock::new(|| compile(PEM_END));
/// Where a key cut before its footer ends: a quote, a blank line (real or
/// JSON-escaped) or a trim marker line.
static PEM_STOP_AFTER: LazyLock<Regex> = LazyLock::new(|| {
    compile(r#"["']|\r?\n[ \t]*\r?\n|\\r?\\n[ \t]*\\r?\\n|\r?\n… [0-9]+ lines omitted …"#)
});
/// Where a key cut before its header starts (the same stops, backwards).
static PEM_STOP_BEFORE: LazyLock<Regex> = LazyLock::new(|| {
    compile(r#"["']|\r?\n[ \t]*\r?\n|\\r?\\n[ \t]*\\r?\\n|… [0-9]+ lines omitted …\r?\n"#)
});
/// A base64 run holding `-----BEGIN` (kubeconfig `client-key-data`,
/// `binaryData`).
static PEM_BASE64: LazyLock<Regex> = LazyLock::new(|| {
    compile(&format!(
        r"[A-Za-z0-9+/]*(?:{})[A-Za-z0-9+/]*={{0,2}}",
        PEM_BASE64_NEEDLES.join("|")
    ))
});

/// Self-describing tokens. `auth` / `bearer` keep their prefix.
static TOKENS: LazyLock<Regex> = LazyLock::new(|| {
    compile(concat!(
        r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}",
        r#"|(?P<auth>(?-u:\b)(?i:authorization)["']?[ \t]*[:=][ \t]*["']?(?:(?i:basic|bearer|token|digest|negotiate)[ \t]+)?)(?P<authv>[A-Za-z0-9._~+/=-]{8,})"#,
        r"|(?P<bearer>(?-u:\b)(?i:bearer)[ \t]+)(?P<bearerv>[A-Za-z0-9._~+/-]{8,}=*)",
        r"|(?:AKIA|ASIA)[0-9A-Z]{16}",
        r"|github_pat_[A-Za-z0-9_]{22,}",
        r"|gh[pousr]_[A-Za-z0-9]{36,}",
        r"|glpat-[A-Za-z0-9_-]{20,}",
        r"|(?-u:\b)xox[baprs]-[A-Za-z0-9-]{10,}",
        r"|AIza[A-Za-z0-9_-]{35}",
        r"|(?-u:\b)sk-(?:ant-)?[A-Za-z0-9_-]{20,}",
        r"|(?-u:\b)[sr]k_(?:live|test)_[A-Za-z0-9]{16,}",
        // kubeadm bootstrap tokens
        r"|(?-u:\b)[a-z0-9]{6}\.[a-z0-9]{16}(?-u:\b)",
    ))
});
/// `password=…`, `"token": "…"`, `\"secret\":\"…\"`, `password%3D…`: the
/// key stays, the value goes.
static KEY_VALUE: LazyLock<Regex> = LazyLock::new(|| {
    compile(&format!(
        r#"(?i)({CREDENTIAL_KEY})((?:\\?["'])?[ \t]*(?:[:=]|%3d)[ \t]*(?:\\?["'])?)((?:[^\s"',;\\]|\\[^\s"'])+)"#
    ))
});
/// `password:` with its value alone on the next line.
static NEXT_LINE_VALUE: LazyLock<Regex> = LazyLock::new(|| {
    compile(&format!(
        r#"(?i)({CREDENTIAL_KEY}["']?:[ \t]*\r?\n[ \t]+["']?)([^\s"',;:#\-][^\s"',;:]{{3,}})(["']?[ \t]*(?:\r?\n|$))"#
    ))
});
/// `--password value`, `["--token", "value"]`, YAML `- --password\n- value`.
static CLI_FLAG: LazyLock<Regex> = LazyLock::new(|| {
    compile(
        r#"(?i)((?:^|[\s"'\[,=])--?[a-z0-9_-]*?(?:password|passwd|pwd|pass|secret|token|api[_-]?key|access[_-]?key)[a-z0-9_-]*)([ \t]+|["'][ \t]*,[ \t]*["']|["']?[ \t]*\r?\n[ \t]*-[ \t]+["']?)([^\s"',;\-][^\s"',;]{3,})"#,
    )
});
/// The same key names as object keys (structured manifests).
static TOKEN_KEY: LazyLock<Regex> = LazyLock::new(|| compile(&format!(r"(?i){CREDENTIAL_KEY}$")));
/// `scheme://user:password@` up to the last `@` before the path (the user
/// may be empty: `redis://:pw@`).
static URL_USERINFO: LazyLock<Regex> = LazyLock::new(|| compile(r#"://[^/\s:@"']*:[^/\s"']+@"#));
/// Names whose sibling `value` is always secret.
static SECRET_NAME: LazyLock<Regex> = LazyLock::new(|| {
    compile(
        r"(?i)(pass|pwd|secret|token|api[_-]?key|access[_-]?key|credential|private[_-]?key|auth|dsn|[_.-](?:key|pw)$)",
    )
});

const OCTET: &str = r"(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])";
static IPV4: LazyLock<Regex> =
    LazyLock::new(|| compile(&format!(r"{OCTET}(?:\.{OCTET}){{3}}(?-u:\b)")));
/// AWS-style `ip-10-0-3-7` host names.
static IP_HOST: LazyLock<Regex> = LazyLock::new(|| {
    compile(&format!(
        r"(?i)(?-u:\b)ip-({OCTET}(?:-{OCTET}){{3}})(?-u:\b)"
    ))
});
/// IPv6 candidates (validated with the standard parser).
static IPV6: LazyLock<Regex> = LazyLock::new(|| compile(r"(?i)[0-9a-f]*(?::[0-9a-f.]*){2,}"));
static HOSTNAME: LazyLock<Regex> =
    LazyLock::new(|| compile(r"(?i)(?:[a-z0-9-]+\.)+[a-z]{2,24}(?-u:\b)"));

// Manifests
static SECRET_KIND: LazyLock<Regex> = LazyLock::new(|| {
    compile(r#"["']?kind["']?[ \t]*:[ \t]*(?:!![A-Za-z]+[ \t]+)?["']?([A-Za-z0-9]+)"#)
});
static KIND_KEY: LazyLock<Regex> =
    LazyLock::new(|| compile(r#"(?:^|[\s{,])["']?kind["']?[ \t]*:"#));
static DATA_KEY: LazyLock<Regex> = LazyLock::new(|| {
    compile(
        r#"(?m)(?:^[ \t]*(?:-[ \t]+)?|[{,][ \t]*)["']?(?:data|stringData|encryptedData|items)["']?[ \t]*:"#,
    )
});
static EMBEDDED_KEY: LazyLock<Regex> = LazyLock::new(|| {
    compile(r#"(?:^|[\s{,])["']?(?:kind|apiVersion|data|stringData|encryptedData)["']?[ \t]*:"#)
});
/// A YAML alias (`*name`), which copies a value somewhere else.
static ALIAS: LazyLock<Regex> = LazyLock::new(|| compile(r"(?:^|[\s\[{,])\*[A-Za-z0-9_]"));
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
// Messages
static FENCE: LazyLock<Regex> = LazyLock::new(|| {
    compile(
        r"(?m)(?P<open>^[ \t]*```[ \t]*(?P<lang>[A-Za-z0-9_+-]*)[^\n]*\n)(?P<body>(?s:.*?))^[ \t]*```",
    )
});
static MANIFEST_START: LazyLock<Regex> = LazyLock::new(|| {
    compile(
        r#"(?m)^[ \t]*(?:["']?(?:apiVersion|kind|metadata|data|stringData|encryptedData|items)["']?[ \t]*:|[{\[])"#,
    )
});

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/// Redacts free text (logs, events, labels, tool results).
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
    mask_keys(&mut cur, counts);
    if opts.tokens && cur.len() >= 8 {
        mask_tokens(&mut cur, counts);
    }
    if opts.ips {
        mask_ips(&mut cur, pseudo, counts);
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

/// Private keys, always: complete PEM blocks, blocks cut before their
/// footer (masked up to a blank line, a quote, a trim marker or the end;
/// armor headers do not end them) or before their header (masked back to
/// the same stops), and base64-wrapped keys.
fn mask_keys(cur: &mut Cow<'_, str>, counts: &mut RedactionCounts) {
    if cur.contains("PRIVATE KEY") {
        replace(cur, &PEM_BLOCK, |_, _| {
            counts.secrets += 1;
            Some(SECRET_MARKER.to_string())
        });
        counts.secrets += splice(cur, |hay| {
            let mut spans = Vec::new();
            let mut last = 0;
            for m in PEM_HEADER.find_iter(hay) {
                if m.start() >= last {
                    last = cut_key_end(hay, m.end());
                    spans.push((m.start(), last));
                }
            }
            spans
        });
        counts.secrets += splice(cur, |hay| {
            let mut spans = Vec::new();
            let mut lower = 0;
            for m in PEM_FOOTER.find_iter(hay) {
                let start = PEM_STOP_BEFORE
                    .find_iter(&hay[lower..m.start()])
                    .last()
                    .map_or(lower, |stop| lower + stop.end());
                spans.push((start, m.end()));
                lower = m.end();
            }
            spans
        });
    }
    if PEM_BASE64_NEEDLES.iter().any(|n| cur.contains(n)) {
        replace(cur, &PEM_BASE64, |_, caps| {
            let run = caps.get(0)?.as_str();
            if !base64_holds_private_key(run) {
                return None;
            }
            counts.secrets += 1;
            Some(SECRET_MARKER.to_string())
        });
    }
}

/// Where the body of a key cut before its footer ends.
fn cut_key_end(hay: &str, from: usize) -> usize {
    let mut pos = from;
    while let Some(stop) = PEM_STOP_AFTER.find(&hay[pos..]) {
        let (start, end) = (pos + stop.start(), pos + stop.end());
        let blank_line = !stop.as_str().starts_with(['"', '\'']) && !stop.as_str().contains('…');
        if !(blank_line && only_armor_headers(&hay[from..start])) {
            return start;
        }
        pos = end;
    }
    hay.len()
}

/// Nothing but armor headers (`Proc-Type:`, `DEK-Info:`, …) or nothing.
fn only_armor_headers(region: &str) -> bool {
    region
        .split('\n')
        .flat_map(|line| line.split("\\n"))
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .all(|line| ARMOR_HEADERS.iter().any(|h| line.contains(h)))
}

/// Undecodable runs count as keys (fail closed); certificates do not.
fn base64_holds_private_key(run: &str) -> bool {
    match BASE64.decode(run) {
        Ok(bytes) => bytes.windows(11).any(|w| w == b"PRIVATE KEY"),
        Err(_) => true,
    }
}

fn mask_tokens(cur: &mut Cow<'_, str>, counts: &mut RedactionCounts) {
    replace(cur, &TOKENS, |_, caps| {
        let (keep, value) = match (caps.name("auth"), caps.name("bearer")) {
            (Some(prefix), _) => (prefix.as_str(), caps.name("authv")?.as_str()),
            (None, Some(prefix)) => (prefix.as_str(), caps.name("bearerv")?.as_str()),
            _ => ("", ""),
        };
        if !keep.is_empty() && (weak_token(value) || starts_with_marker(value)) {
            return None;
        }
        counts.tokens += 1;
        Some(format!("{keep}{TOKEN_MARKER}"))
    });
    if cur.contains([':', '=', '%']) {
        replace(cur, &KEY_VALUE, |_, caps| {
            let value = &caps[3];
            if value.chars().count() < 4 || starts_with_marker(value) {
                return None;
            }
            counts.tokens += 1;
            Some(format!("{}{}{TOKEN_MARKER}", &caps[1], &caps[2]))
        });
    }
    if cur.contains('\n') {
        replace(cur, &NEXT_LINE_VALUE, |_, caps| {
            if starts_with_marker(&caps[2]) {
                return None;
            }
            counts.tokens += 1;
            Some(format!("{}{TOKEN_MARKER}{}", &caps[1], &caps[3]))
        });
    }
    if cur.contains('-') {
        replace(cur, &CLI_FLAG, |_, caps| {
            if starts_with_marker(&caps[3]) {
                return None;
            }
            counts.tokens += 1;
            Some(format!("{}{}{TOKEN_MARKER}", &caps[1], &caps[2]))
        });
    }
    if cur.contains("://") {
        replace(cur, &URL_USERINFO, |_, _| {
            counts.tokens += 1;
            Some(format!("://{TOKEN_MARKER}@"))
        });
    }
}

/// A short, digit-free word after `Bearer` / `Authorization:` is prose
/// ("bearer authentication"), not a token.
fn weak_token(value: &str) -> bool {
    value.len() < 16 && !value.bytes().any(|b| b.is_ascii_digit())
}

fn mask_ips(cur: &mut Cow<'_, str>, pseudo: &mut Pseudonyms, counts: &mut RedactionCounts) {
    if cur.contains(':') {
        replace(cur, &IPV6, |hay, caps| {
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
        replace(cur, &IPV4, |hay, caps| {
            let m = caps.get(0)?;
            let ip = m.as_str();
            if ip.starts_with("127.")
                || ip == "0.0.0.0"
                || !ipv4_standalone(hay, m.start(), m.end())
            {
                return None;
            }
            counts.ips += 1;
            Some(pseudo.placeholder(PseudoKind::Ip, ip))
        });
    }
    if cur.contains("ip-") || cur.contains("IP-") {
        replace(cur, &IP_HOST, |_, caps| {
            if caps[1].starts_with("127-") {
                return None;
            }
            counts.ips += 1;
            Some(pseudo.placeholder(PseudoKind::Ip, caps.get(0)?.as_str()))
        });
    }
}

/// Not part of a longer number, a version (`v1.2.3.4`, `3.10.0.1-rc`) or
/// an image tag (`repo/app:1.2.3.4`).
fn ipv4_standalone(hay: &str, start: usize, end: usize) -> bool {
    let before = &hay.as_bytes()[..start];
    let after = &hay.as_bytes()[end..];
    let inside_number = match before {
        [.., b] if b.is_ascii_digit() => true,
        [.., d, b'.'] if d.is_ascii_digit() => true,
        [.., p, b'v' | b'V'] => !p.is_ascii_alphanumeric(),
        [b'v' | b'V'] => true,
        _ => false,
    };
    let version_suffix = matches!(after, [b'.', d, ..] if d.is_ascii_digit())
        || matches!(after, [b'-', l, ..] if l.is_ascii_alphabetic());
    !(inside_number || version_suffix || image_tag(before))
}

fn image_tag(before: &[u8]) -> bool {
    let [head @ .., b':'] = before else {
        return false;
    };
    let token = head
        .rsplit(|b| {
            b.is_ascii_whitespace() || matches!(b, b'"' | b'\'' | b'=' | b'(' | b'[' | b',')
        })
        .next()
        .unwrap_or_default();
    token.contains(&b'/') && !token.windows(3).any(|w| w == b"://")
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

/// Replaces the sorted, disjoint spans `find` returns with the secret
/// marker; returns how many there were.
fn splice(cur: &mut Cow<'_, str>, find: impl FnOnce(&str) -> Vec<(usize, usize)>) -> u32 {
    let (out, n) = {
        let hay: &str = cur;
        let spans = find(hay);
        if spans.is_empty() {
            return 0;
        }
        let mut out = String::with_capacity(hay.len());
        let mut last = 0;
        for &(start, end) in &spans {
            out.push_str(&hay[last..start]);
            out.push_str(SECRET_MARKER);
            last = end;
        }
        out.push_str(&hay[last..]);
        (out, spans.len())
    };
    *cur = Cow::Owned(out);
    u32::try_from(n).unwrap_or(u32::MAX)
}

fn starts_with_marker(s: &str) -> bool {
    s.starts_with(SECRET_MARKER)
        || s.starts_with(TOKEN_MARKER)
        || s.starts_with("__IP_")
        || s.starts_with("__HOST_")
}

/// The IPv6 address inside a candidate match, or `None` when the candidate
/// is not one (a time, `std::string`, a MAC, `cafe::face`) or is
/// loopback/unspecified.
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
    // Real addresses have digits; `add::dec` and `cafe::face` are words.
    let digits = hay[s..e].bytes().any(|b| b.is_ascii_digit());
    if !before_ok || !after_ok || !digits || s >= e {
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

/// Dotted names that are not hosts: files, public project and registry
/// domains, field paths, class names, package paths, and anything whose
/// last label is not a known top-level domain.
fn host_exempt(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let first = lower.split('.').next().unwrap_or("");
    let last = lower.rsplit('.').next().unwrap_or("");
    let last_original = name.rsplit('.').next().unwrap_or("");
    let under = |domains: &[&str]| {
        domains.iter().any(|domain| {
            lower
                .strip_suffix(domain)
                .is_some_and(|rest| rest.is_empty() || rest.ends_with('.'))
        })
    };
    let camel_case = last_original
        .as_bytes()
        .windows(2)
        .any(|w| w[0].is_ascii_lowercase() && w[1].is_ascii_uppercase());
    let package = PACKAGE_ROOTS.contains(&first)
        && name
            .split('.')
            .any(|label| label.starts_with(|c: char| c.is_ascii_uppercase()));
    let tld = (last.len() == 2 && !FIELD_LABELS.contains(&last))
        || GENERIC_TLDS.contains(&last)
        || PRIVATE_TLDS.contains(&last);
    FILE_EXTENSIONS.contains(&last)
        || under(ALLOWED_DOMAINS)
        || under(PROJECT_DOMAINS)
        || FIELD_ROOTS.contains(&first)
        || camel_case
        || package
        || !tld
}

// ---------------------------------------------------------------------------
// Structured values
// ---------------------------------------------------------------------------

/// Redacts a parsed object (or list, or any JSON value) as a document: the
/// always-on object rules, embedded manifests, then every string leaf and
/// key through the text passes.
pub fn redact_value(
    value: &Value,
    opts: &RedactOptions,
    pseudo: &mut Pseudonyms,
) -> (Value, RedactionCounts) {
    let mut out = value.clone();
    let mut walker = Walker::new(opts, pseudo);
    walker.document(&mut out, false, 0);
    (out, walker.counts)
}

struct Walker<'a> {
    opts: &'a RedactOptions,
    pseudo: &'a mut Pseudonyms,
    counts: RedactionCounts,
}

impl<'a> Walker<'a> {
    fn new(opts: &'a RedactOptions, pseudo: &'a mut Pseudonyms) -> Self {
        Self {
            opts,
            pseudo,
            counts: RedactionCounts::default(),
        }
    }

    /// A document root. It is Secret-like when forced, by its kind, or —
    /// without a kind — when it carries secret fields; kind-less items of a
    /// kind-less list are treated alike.
    fn document(&mut self, value: &mut Value, force: bool, depth: usize) {
        if depth > MAX_DEPTH {
            self.secret(value);
            return;
        }
        match value {
            Value::Object(map) => {
                let kind = map.get("kind").and_then(Value::as_str);
                let is_secret = force
                    || kind.map_or_else(
                        || SECRET_DATA_FIELDS.iter().any(|f| map.contains_key(*f)),
                        secret_like,
                    );
                let items_secret =
                    force || kind.map_or_else(|| map.contains_key("items"), list_of_secrets);
                self.object(map, is_secret, items_secret, depth);
            }
            Value::Array(items) => {
                for item in items {
                    self.document(item, force, depth + 1);
                }
            }
            other => self.value(other, force, depth),
        }
    }

    /// Masks a whole document but its `apiVersion` and `kind` (a Secret
    /// whose values may have been copied elsewhere by YAML aliases).
    fn mask_document(&mut self, value: &mut Value) {
        match value {
            Value::Object(map) => {
                for (key, child) in map.iter_mut() {
                    let identity =
                        matches!(key.as_str(), "apiVersion" | "kind") && child.is_string();
                    if !identity {
                        self.mask_leaves(child, 1);
                    }
                }
                self.keys(map);
            }
            other => self.mask_leaves(other, 0),
        }
    }

    /// `inherited_secret`: an item of a Secret list (API lists omit the
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
                let items_secret = kind.is_some_and(list_of_secrets);
                self.object(map, is_secret, items_secret, depth);
            }
            Value::Array(items) => {
                for item in items {
                    self.value(item, inherited_secret, depth + 1);
                }
            }
            Value::String(s) => self.string(s, depth),
            Value::Null | Value::Bool(_) | Value::Number(_) => {}
        }
    }

    fn object(
        &mut self,
        map: &mut Map<String, Value>,
        is_secret: bool,
        items_secret: bool,
        depth: usize,
    ) {
        if let Some(Value::Object(meta)) = map.get_mut("metadata") {
            strip_bookkeeping(meta);
            // Annotations of a Secret can hold a copy of it (kapp, CI tools).
            if is_secret {
                if let Some(Value::Object(annotations)) = meta.get_mut("annotations") {
                    for (key, value) in annotations.iter_mut() {
                        if !KEPT_SECRET_ANNOTATIONS.contains(&key.as_str()) {
                            self.mask_leaves(value, depth + 3);
                        }
                    }
                }
            }
        }
        // `{name: DB_PASSWORD, value: …}` wherever it appears.
        let secret_pair = map
            .get("name")
            .and_then(Value::as_str)
            .is_some_and(|name| SECRET_NAME.is_match(name));
        if secret_pair {
            if let Some(value) = map.get_mut("value") {
                self.mask_leaves(value, depth + 1);
            }
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

    /// A string leaf: an embedded manifest is redacted as one; anything
    /// else goes through the text passes.
    fn string(&mut self, s: &mut String, depth: usize) {
        if depth < MAX_DEPTH && looks_like_manifest(s) {
            if let Some(redacted) = self.embedded(s, depth) {
                *s = redacted;
                return;
            }
        }
        let redacted = match redact_str(s, self.opts, self.pseudo, &mut self.counts) {
            Cow::Owned(r) => Some(r),
            Cow::Borrowed(_) => None,
        };
        if let Some(r) = redacted {
            *s = r;
        }
    }

    /// The redacted form of a string holding a manifest (JSON stays JSON),
    /// or `None` when it holds none.
    fn embedded(&mut self, text: &str, depth: usize) -> Option<String> {
        let json = text.trim_start().starts_with(['{', '[']);
        match parse_documents(text) {
            Some(docs) if docs.iter().any(|(doc, _)| manifest_like(doc)) => {
                Some(self.documents(docs, false, json, depth + 1))
            }
            Some(_) => None,
            None if doc_is_secret(text) => {
                let (masked, n) = mask_unparsed_manifest(text, false);
                self.counts.secrets += n;
                Some(redact_str(&masked, self.opts, self.pseudo, &mut self.counts).into_owned())
            }
            None => None,
        }
    }

    /// Redacts parsed documents and serializes them: YAML documents joined
    /// by `---`, or compact JSON for a single JSON document.
    fn documents(
        &mut self,
        docs: Vec<(Value, &str)>,
        force: bool,
        json: bool,
        depth: usize,
    ) -> String {
        let single = docs.len() == 1;
        let mut out = String::new();
        for (i, (mut doc, raw)) in docs.into_iter().enumerate() {
            // An alias in a Secret may copy a value out of its data.
            if doc_names_secret(raw) && ALIAS.is_match(raw) {
                self.mask_document(&mut doc);
            } else {
                self.document(&mut doc, force, depth);
            }
            if json && single {
                return serde_json::to_string(&doc).unwrap_or_else(|_| SECRET_MARKER.to_string());
            }
            if i > 0 {
                out.push_str("---\n");
            }
            match serde_yaml::to_string(&doc) {
                Ok(yaml) => out.push_str(&yaml),
                // Cannot happen for JSON values; never fall back to the input.
                Err(_) => out.push_str(SECRET_MARKER),
            }
        }
        out
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

fn list_of_secrets(kind: &str) -> bool {
    kind.strip_suffix("List").is_some_and(secret_like)
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

fn looks_like_manifest(s: &str) -> bool {
    s.len() >= 6
        && (s.contains("kind") || s.contains("ata") || s.contains("apiVersion"))
        && EMBEDDED_KEY.is_match(s)
}

fn manifest_like(value: &Value) -> bool {
    match value {
        Value::Object(map) => MANIFEST_KEYS.iter().any(|k| map.contains_key(*k)),
        Value::Array(items) => items.iter().any(manifest_like),
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// Manifests
// ---------------------------------------------------------------------------

/// Redacts multi-document YAML or JSON and returns YAML. Text that does not
/// parse as objects (a cut, half-edited or duplicate-key manifest) goes
/// through a line-based pass that still masks Secret values, secret-named
/// pair values and the last-applied annotation, then [`redact_text`].
pub fn redact_manifest_text(
    text: &str,
    opts: &RedactOptions,
    pseudo: &mut Pseudonyms,
) -> (String, RedactionCounts) {
    redact_manifest(text, false, opts, pseudo)
}

/// [`redact_manifest_text`] for `prefix`, the part of `whole` kept by the
/// size cap: `whole` is classified in full, and when any document of it is
/// Secret-like every document of the prefix is treated as one (the cut may
/// have removed the `kind`, which JSON sorts after `data` and `items`).
pub(crate) fn redact_manifest_prefix(
    prefix: &str,
    whole: &str,
    opts: &RedactOptions,
    pseudo: &mut Pseudonyms,
) -> (String, RedactionCounts) {
    redact_manifest(prefix, doc_is_secret(whole), opts, pseudo)
}

fn redact_manifest(
    text: &str,
    force: bool,
    opts: &RedactOptions,
    pseudo: &mut Pseudonyms,
) -> (String, RedactionCounts) {
    let Some(docs) = parse_documents(text) else {
        let (masked, secrets) = mask_unparsed_manifest(text, force);
        let (out, mut counts) = redact_text(&masked, opts, pseudo);
        counts.secrets += secrets;
        return (out, counts);
    };
    let mut walker = Walker::new(opts, pseudo);
    let out = walker.documents(docs, force, false, 0);
    (out, walker.counts)
}

/// Redacts a typed message: fenced `yaml` / `json` blocks (and unlabelled
/// ones holding a manifest) as manifests, an unfenced Secret-like manifest
/// from its first line, then everything through the text passes.
pub fn redact_message(
    text: &str,
    opts: &RedactOptions,
    pseudo: &mut Pseudonyms,
) -> (String, RedactionCounts) {
    let mut counts = RedactionCounts::default();
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for c in FENCE.captures_iter(text) {
        let (Some(open), Some(body)) = (c.name("open"), c.name("body")) else {
            continue;
        };
        out.push_str(&unfenced(
            &text[last..open.start()],
            opts,
            pseudo,
            &mut counts,
        ));
        out.push_str(open.as_str());
        let lang = c
            .name("lang")
            .map_or("", |m| m.as_str())
            .to_ascii_lowercase();
        let content = body.as_str();
        let redacted = match lang.as_str() {
            "yaml" | "yml" => Some(redact_manifest(content, false, opts, pseudo)),
            "json" => Some(redact_json(content, opts, pseudo)),
            "" if MANIFEST_START.is_match(content) => {
                Some(redact_manifest(content, false, opts, pseudo))
            }
            _ => None,
        };
        match redacted {
            Some((redacted, n)) => {
                counts.add(&n);
                out.push_str(&redacted);
                if !redacted.is_empty() && !redacted.ends_with('\n') {
                    out.push('\n');
                }
            }
            None => out.push_str(content),
        }
        last = body.end();
    }
    out.push_str(&unfenced(&text[last..], opts, pseudo, &mut counts));
    let (out, n) = redact_text(&out, opts, pseudo);
    counts.add(&n);
    (out, counts)
}

/// Message text outside fences: a Secret-like manifest in it is redacted
/// from its first manifest line on.
fn unfenced<'t>(
    text: &'t str,
    opts: &RedactOptions,
    pseudo: &mut Pseudonyms,
    counts: &mut RedactionCounts,
) -> Cow<'t, str> {
    if !doc_is_secret(text) {
        return Cow::Borrowed(text);
    }
    let start = MANIFEST_START.find(text).map_or(0, |m| m.start());
    let (manifest, n) = redact_manifest(&text[start..], false, opts, pseudo);
    counts.add(&n);
    Cow::Owned(format!("{}{manifest}", &text[..start]))
}

/// A JSON block stays JSON (pretty-printed).
fn redact_json(
    text: &str,
    opts: &RedactOptions,
    pseudo: &mut Pseudonyms,
) -> (String, RedactionCounts) {
    let Some(mut value) = parse_json(text) else {
        return redact_manifest(text, false, opts, pseudo);
    };
    let mut walker = Walker::new(opts, pseudo);
    walker.document(&mut value, false, 0);
    let out = serde_json::to_string_pretty(&value).unwrap_or_else(|_| SECRET_MARKER.to_string());
    (format!("{out}\n"), walker.counts)
}

/// The documents of `text` with their source when every one is an object
/// or a list and has no duplicate keys.
fn parse_documents(text: &str) -> Option<Vec<(Value, &str)>> {
    if text.trim_start().starts_with(['{', '[']) {
        if let Some(value) = parse_json(text) {
            return Some(vec![(value, text)]);
        }
    }
    let mut docs = Vec::new();
    for raw in split_documents(text) {
        for doc in serde_yaml::Deserializer::from_str(raw) {
            match Strict::deserialize(doc).ok()?.0 {
                Value::Null => {}
                value @ (Value::Object(_) | Value::Array(_)) => docs.push((value, raw)),
                _ => return None,
            }
        }
    }
    (!docs.is_empty()).then_some(docs)
}

fn parse_json(text: &str) -> Option<Value> {
    let mut de = serde_json::Deserializer::from_str(text);
    let Strict(value) = Strict::deserialize(&mut de).ok()?;
    de.end().ok()?;
    Some(value)
}

/// A `serde_json::Value` that refuses duplicate keys: with duplicates, the
/// value a parser keeps (the last `kind`) is not the one a reader sees.
struct Strict(Value);

impl<'de> Deserialize<'de> for Strict {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(StrictVisitor).map(Strict)
    }
}

struct StrictVisitor;

impl<'de> Visitor<'de> for StrictVisitor {
    type Value = Value;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a JSON-compatible value")
    }
    fn visit_bool<E: de::Error>(self, v: bool) -> Result<Value, E> {
        Ok(Value::Bool(v))
    }
    fn visit_i64<E: de::Error>(self, v: i64) -> Result<Value, E> {
        Ok(Value::from(v))
    }
    fn visit_u64<E: de::Error>(self, v: u64) -> Result<Value, E> {
        Ok(Value::from(v))
    }
    fn visit_f64<E: de::Error>(self, v: f64) -> Result<Value, E> {
        Ok(Number::from_f64(v).map_or(Value::Null, Value::Number))
    }
    fn visit_str<E: de::Error>(self, v: &str) -> Result<Value, E> {
        Ok(Value::String(v.to_owned()))
    }
    fn visit_string<E: de::Error>(self, v: String) -> Result<Value, E> {
        Ok(Value::String(v))
    }
    fn visit_none<E: de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_unit<E: de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_some<D: Deserializer<'de>>(self, deserializer: D) -> Result<Value, D::Error> {
        Strict::deserialize(deserializer).map(|s| s.0)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Value, A::Error> {
        let mut items = Vec::new();
        while let Some(Strict(item)) = seq.next_element()? {
            items.push(item);
        }
        Ok(Value::Array(items))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
        let mut out = Map::new();
        while let Some(key) = map.next_key::<String>()? {
            if out.contains_key(&key) {
                return Err(de::Error::custom(format_args!("duplicate key {key}")));
            }
            let Strict(value) = map.next_value()?;
            out.insert(key, value);
        }
        Ok(Value::Object(out))
    }
}

fn secret_kind(kind: &str) -> bool {
    secret_like(kind) || list_of_secrets(kind)
}

/// Some `kind` in the text is Secret-like (any occurrence: duplicate keys,
/// nested items, `!!str` tags).
fn doc_names_secret(doc: &str) -> bool {
    SECRET_KIND.captures_iter(doc).any(|c| secret_kind(&c[1]))
}

/// A Secret-like document, or one without any `kind` that carries secret
/// fields or items (fail closed).
fn doc_is_secret(doc: &str) -> bool {
    doc_names_secret(doc) || (!KIND_KEY.is_match(doc) && DATA_KEY.is_match(doc))
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

/// Line-based masking for manifests that do not parse. In a Secret-like
/// document (by any `kind`, or without one but with secret fields) every
/// value is masked except the top-level `apiVersion` / `kind` / `type` and
/// `metadata.name` / `namespace`. Elsewhere the `value` of an item whose
/// `name` looks secret (wherever the two sit in the item), the last-applied
/// annotation and values holding an embedded manifest are masked. Block
/// scalars and multi-line quoted values go with their key. Returns the
/// text and the number of masked values.
fn mask_unparsed_manifest(text: &str, force: bool) -> (String, u32) {
    let mut out = String::with_capacity(text.len());
    let mut masked = 0u32;
    for doc in split_documents(text) {
        let lines: Vec<Line<'_>> = doc.split_inclusive('\n').map(Line::parse).collect();
        let pairs = secret_pair_columns(&lines);
        let mut state = LineState {
            secret_doc: force || doc_is_secret(doc),
            base: lines
                .iter()
                .filter_map(|l| l.key.as_ref().map(|k| k.col))
                .min()
                .unwrap_or(0),
            top: String::new(),
            meta_col: None,
            masked: 0,
        };
        let mut skip = Skip::None;
        for (line, pair) in lines.iter().zip(&pairs) {
            match skip {
                Skip::Deeper(col) if line.blank || line.indent > col => continue,
                Skip::Quote(q) => {
                    if closes_quote(line.body, q) {
                        skip = Skip::None;
                    }
                    continue;
                }
                _ => {}
            }
            let (new, next) = state.line(line, *pair);
            skip = next;
            out.push_str(&new);
            out.push_str(line.eol);
        }
        masked += state.masked;
    }
    (out, masked)
}

struct Line<'a> {
    body: &'a str,
    eol: &'a str,
    indent: usize,
    blank: bool,
    key: Option<LineKey>,
}

/// A block mapping key on a line: its column (start), whether it opens a
/// list item (`- key:`), where it ends and its value's span.
struct LineKey {
    col: usize,
    item: bool,
    end: usize,
    value: Option<(usize, usize)>,
}

impl<'a> Line<'a> {
    fn parse(raw: &'a str) -> Self {
        let body = raw.trim_end_matches(['\n', '\r']);
        let key = BLOCK_KEY.captures(body).and_then(|c| {
            let pre = c.name("pre")?;
            let key = c.name("key")?;
            Some(LineKey {
                col: key.start(),
                item: pre.as_str().contains('-'),
                end: key.end(),
                value: c.name("value").map(|v| (v.start(), v.end())),
            })
        });
        Line {
            body,
            eol: &raw[body.len()..],
            indent: body.len() - body.trim_start_matches([' ', '\t']).len(),
            blank: body.trim().is_empty(),
            key,
        }
    }

    fn key_name(&self) -> Option<&'a str> {
        self.key.as_ref().map(|k| unquote(&self.body[k.col..k.end]))
    }

    fn value(&self) -> Option<&'a str> {
        let (start, end) = self.key.as_ref()?.value?;
        Some(&self.body[start..end])
    }
}

/// For each line, the key column of the list item (or JSON object) it
/// belongs to when that item has a `name` that looks secret.
fn secret_pair_columns(lines: &[Line<'_>]) -> Vec<Option<usize>> {
    let mut out = vec![None; lines.len()];
    for (i, line) in lines.iter().enumerate() {
        let (Some(key), Some(name)) = (&line.key, line.value()) else {
            continue;
        };
        if line.key_name() != Some("name") || !SECRET_NAME.is_match(unquote(name)) {
            continue;
        }
        let col = key.col;
        let mut start = i;
        if !key.item {
            while start > 0 {
                let prev = &lines[start - 1];
                if prev.blank {
                    break;
                }
                if prev.key.as_ref().is_some_and(|k| k.item && k.col == col) {
                    start -= 1;
                    break;
                }
                if prev.indent < col {
                    break;
                }
                start -= 1;
            }
        }
        let mut end = i + 1;
        while end < lines.len() && !lines[end].blank && lines[end].indent >= col {
            end += 1;
        }
        for slot in &mut out[start..end] {
            *slot = Some(col);
        }
    }
    out
}

/// Lines to drop after a masked value: a block scalar's deeper lines, or a
/// quoted value's lines up to its closing quote.
#[derive(Clone, Copy)]
enum Skip {
    None,
    Deeper(usize),
    Quote(char),
}

/// Where a key sits, for deciding what to keep.
#[derive(Clone, Copy)]
struct Place {
    top_level: bool,
    meta_child: bool,
    /// Brace depth of a flow key (`None` for block keys).
    depth: Option<usize>,
    /// Its object has a secret-looking `name`.
    pair: bool,
}

struct LineState {
    secret_doc: bool,
    /// Column of the top-level keys.
    base: usize,
    /// The current top-level key.
    top: String,
    /// Column of `metadata`'s direct children.
    meta_col: Option<usize>,
    masked: u32,
}

impl LineState {
    fn line<'a>(&mut self, line: &Line<'a>, pair: Option<usize>) -> (Cow<'a, str>, Skip) {
        let body = line.body;
        if let Some(k) = &line.key {
            let key = unquote(&body[k.col..k.end]);
            let top_level = k.col == self.base && !k.item;
            if top_level {
                self.top = key.to_string();
                self.meta_col = None;
            } else if self.top == "metadata" && self.meta_col.is_none() {
                self.meta_col = Some(k.col);
            }
            let Some((start, end)) = k.value else {
                return (Cow::Borrowed(body), Skip::None);
            };
            let value = &body[start..end];
            let place = Place {
                top_level,
                meta_child: self.top == "metadata" && self.meta_col == Some(k.col),
                depth: None,
                pair: pair == Some(k.col),
            };
            if self.should_mask(key, value, place) {
                self.masked += 1;
                let skip = if value.starts_with(['|', '>']) {
                    Skip::Deeper(k.col)
                } else {
                    unclosed_quote(value).map_or(Skip::None, Skip::Quote)
                };
                return (
                    Cow::Owned(format!("{}{SECRET_MARKER}", &body[..start])),
                    skip,
                );
            }
            return (self.flow(body, start).0, Skip::None);
        }
        let (flowed, found_key) = self.flow(body, 0);
        if self.secret_doc && !found_key && body.chars().any(char::is_alphanumeric) {
            self.masked += 1;
            return (
                Cow::Owned(format!("{}{SECRET_MARKER}", &body[..line.indent])),
                Skip::None,
            );
        }
        (flowed, Skip::None)
    }

    /// `{key: value, …}` / `"key": "value"` pairs from byte `from` on, with
    /// their brace depth and object (so a `name` pairs with the `value` of
    /// its own object); also says whether there was any.
    fn flow<'a>(&mut self, body: &'a str, from: usize) -> (Cow<'a, str>, bool) {
        let mut pairs = Vec::new();
        let mut scan = BraceScan {
            pos: from,
            ..BraceScan::default()
        };
        for c in FLOW_KEY.captures_iter(&body[from..]) {
            let (Some(k), Some(v)) = (c.name("key"), c.name("value")) else {
                continue;
            };
            let (key, value) = (
                (from + k.start(), from + k.end()),
                (from + v.start(), from + v.end()),
            );
            scan.advance(body, key.0);
            pairs.push((key, value, scan.open.len(), scan.open.last().copied()));
            scan.advance(body, value.1);
        }
        if pairs.is_empty() {
            return (Cow::Borrowed(body), false);
        }
        let secret_objects: Vec<Option<usize>> = pairs
            .iter()
            .filter(|(k, v, ..)| {
                unquote(&body[k.0..k.1]) == "name" && SECRET_NAME.is_match(unquote(&body[v.0..v.1]))
            })
            .map(|p| p.3)
            .collect();
        let mut out = String::new();
        let mut last = 0;
        for &(k, v, depth, object) in &pairs {
            let place = Place {
                top_level: false,
                meta_child: false,
                depth: Some(depth),
                pair: secret_objects.contains(&object),
            };
            if self.should_mask(unquote(&body[k.0..k.1]), &body[v.0..v.1], place) {
                self.masked += 1;
                out.push_str(&body[last..v.0]);
                out.push_str(SECRET_MARKER);
                last = v.1;
            }
        }
        if last == 0 {
            return (Cow::Borrowed(body), true);
        }
        out.push_str(&body[last..]);
        (Cow::Owned(out), true)
    }

    fn should_mask(&self, key: &str, value: &str, place: Place) -> bool {
        let plain = unquote(value);
        if plain.is_empty() || starts_with_marker(plain) || matches!(plain, "{" | "[") {
            return false;
        }
        if key == LAST_APPLIED {
            return true;
        }
        if self.secret_doc {
            let identity = match place.depth {
                Some(depth) => depth == 1 && matches!(key, "apiVersion" | "kind" | "type"),
                None => {
                    (place.top_level && matches!(key, "apiVersion" | "kind" | "type"))
                        || (place.meta_child && matches!(key, "name" | "namespace"))
                }
            };
            return !identity;
        }
        (key == "value" && place.pair) || EMBEDDED_KEY.is_match(value)
    }
}

/// Tracks `{` / `[` nesting (outside double-quoted strings) along a line.
#[derive(Default)]
struct BraceScan {
    pos: usize,
    in_string: bool,
    escape: bool,
    open: Vec<usize>,
}

impl BraceScan {
    fn advance(&mut self, body: &str, to: usize) {
        for (i, &b) in body.as_bytes().iter().enumerate().take(to).skip(self.pos) {
            if self.in_string {
                if self.escape {
                    self.escape = false;
                } else if b == b'\\' {
                    self.escape = true;
                } else if b == b'"' {
                    self.in_string = false;
                }
                continue;
            }
            match b {
                b'"' => self.in_string = true,
                b'{' | b'[' => self.open.push(i),
                b'}' | b']' => {
                    self.open.pop();
                }
                _ => {}
            }
        }
        self.pos = self.pos.max(to);
    }
}

/// The quote a value opens without closing on its line.
fn unclosed_quote(value: &str) -> Option<char> {
    let value = value.trim_end();
    if let Some(rest) = value.strip_prefix('\'') {
        return (!closes_quote(rest, '\'')).then_some('\'');
    }
    let rest = value.strip_prefix('"')?;
    (!closes_quote(rest, '"')).then_some('"')
}

/// The line holds the closing quote (`''` escapes a single quote, `\"` a
/// double one).
fn closes_quote(line: &str, quote: char) -> bool {
    if quote == '\'' {
        return line.replace("''", "").contains('\'');
    }
    let mut escape = false;
    for c in line.chars() {
        if escape {
            escape = false;
        } else if c == '\\' {
            escape = true;
        } else if c == '"' {
            return true;
        }
    }
    false
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
mod tests;
