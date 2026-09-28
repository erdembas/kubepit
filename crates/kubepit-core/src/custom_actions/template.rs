//! Placeholder substitution for custom action templates.
//!
//! Templates are POSIX `sh` command lines (or URLs for `open-url`) with
//! `{placeholder}` tokens. Only the names listed in [`Placeholder`] are
//! substituted; every other `{…}` (jsonpath, go templates, brace
//! expansion) stays literal.
//!
//! ## Injection safety
//!
//! Values come from the cluster (object names, labels, annotations) and
//! from the registry (cluster and context names), so they must never be
//! able to change the command. Substitution therefore tracks where each
//! placeholder sits in the shell syntax of the template and quotes the
//! value for exactly that context:
//!
//! | Context                         | Unsafe value becomes                   |
//! |---------------------------------|----------------------------------------|
//! | unquoted / inside `$( … )`      | `'value'` (`'` → `'\''`)               |
//! | inside `"…"`                    | `"'value'"`: closes and reopens `"`    |
//! | inside `'…'`                    | `''value''`: closes and reopens `'`    |
//! | backticks, `${…}`, `$'…'`, heredoc bodies | refused (error)              |
//! | comments                        | left literal (never substituted)       |
//!
//! Values made only of `[A-Za-z0-9_.,:=@%+/-]` (every Kubernetes name,
//! namespace, kind and label value) are inserted as they are, in any
//! context. The resolved command always runs through `/bin/sh -c`, never
//! through the user's interactive shell, so the quoting rules are POSIX.

use std::collections::BTreeMap;

use anyhow::{bail, Result};

/// A placeholder a template can use.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Placeholder {
    Cluster,
    Context,
    Kubeconfig,
    Namespace,
    Name,
    Kind,
    Group,
    Version,
    Resource,
    Container,
    Label(String),
    Annotation(String),
    SelectionNames,
}

impl Placeholder {
    /// Parse the text between `{` and `}`.
    pub fn parse(inner: &str) -> Option<Self> {
        Some(match inner {
            "cluster" => Self::Cluster,
            "context" => Self::Context,
            "kubeconfig" => Self::Kubeconfig,
            "namespace" => Self::Namespace,
            "name" => Self::Name,
            "kind" => Self::Kind,
            "group" => Self::Group,
            "version" => Self::Version,
            "resource" => Self::Resource,
            "container" => Self::Container,
            "selection.names" => Self::SelectionNames,
            _ => {
                if let Some(key) = inner.strip_prefix("labels.") {
                    return valid_meta_key(key).then(|| Self::Label(key.to_string()));
                }
                if let Some(key) = inner.strip_prefix("annotations.") {
                    return valid_meta_key(key).then(|| Self::Annotation(key.to_string()));
                }
                return None;
            }
        })
    }

    /// The token as written in templates, e.g. `{labels.app}`.
    pub fn token(&self) -> String {
        let inner = match self {
            Self::Cluster => "cluster".to_string(),
            Self::Context => "context".to_string(),
            Self::Kubeconfig => "kubeconfig".to_string(),
            Self::Namespace => "namespace".to_string(),
            Self::Name => "name".to_string(),
            Self::Kind => "kind".to_string(),
            Self::Group => "group".to_string(),
            Self::Version => "version".to_string(),
            Self::Resource => "resource".to_string(),
            Self::Container => "container".to_string(),
            Self::Label(key) => format!("labels.{key}"),
            Self::Annotation(key) => format!("annotations.{key}"),
            Self::SelectionNames => "selection.names".to_string(),
        };
        format!("{{{inner}}}")
    }
}

/// Label / annotation keys: an optional DNS prefix plus `/` and a name.
fn valid_meta_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 317
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '/'))
}

/// Everything a placeholder can resolve to. `None` = not available for this
/// target (substituted as an empty value and reported as missing).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TemplateValues {
    pub cluster: Option<String>,
    pub context: Option<String>,
    pub kubeconfig: Option<String>,
    pub namespace: Option<String>,
    pub name: Option<String>,
    pub kind: Option<String>,
    pub group: Option<String>,
    pub version: Option<String>,
    pub resource: Option<String>,
    pub container: Option<String>,
    pub labels: BTreeMap<String, String>,
    pub annotations: BTreeMap<String, String>,
    /// Names of the selected objects (`{selection.names}`); empty = none.
    pub selection: Vec<String>,
}

enum Value {
    One(String),
    Many(Vec<String>),
}

impl TemplateValues {
    fn lookup(&self, placeholder: &Placeholder) -> Option<Value> {
        let one = |v: &Option<String>| v.clone().map(Value::One);
        match placeholder {
            Placeholder::Cluster => one(&self.cluster),
            Placeholder::Context => one(&self.context),
            Placeholder::Kubeconfig => one(&self.kubeconfig),
            Placeholder::Namespace => one(&self.namespace),
            Placeholder::Name => one(&self.name),
            Placeholder::Kind => one(&self.kind),
            // The core group is empty on purpose: `{group}` of a Pod is "".
            Placeholder::Group => Some(Value::One(self.group.clone().unwrap_or_default())),
            Placeholder::Version => one(&self.version),
            Placeholder::Resource => one(&self.resource),
            Placeholder::Container => one(&self.container),
            Placeholder::Label(key) => self.labels.get(key).cloned().map(Value::One),
            Placeholder::Annotation(key) => self.annotations.get(key).cloned().map(Value::One),
            Placeholder::SelectionNames => {
                if self.selection.is_empty() {
                    self.name.clone().map(|n| Value::Many(vec![n]))
                } else {
                    Some(Value::Many(self.selection.clone()))
                }
            }
        }
    }
}

/// A resolved template plus what could not be filled in.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Rendered {
    pub text: String,
    /// Placeholders without a value (substituted as empty), deduplicated.
    pub missing: Vec<String>,
}

/// One piece of a template.
#[derive(Debug, Clone, PartialEq)]
pub enum Segment {
    Literal(String),
    Placeholder(Placeholder),
}

/// Split a template into literals and known placeholders.
pub fn segments(template: &str) -> Vec<Segment> {
    let mut out = Vec::new();
    let mut literal = String::new();
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        literal.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('}') {
            Some(end) if !after[..end].contains(['{', ' ', '\n', '\t']) => {
                if let Some(p) = Placeholder::parse(&after[..end]) {
                    if !literal.is_empty() {
                        out.push(Segment::Literal(std::mem::take(&mut literal)));
                    }
                    out.push(Segment::Placeholder(p));
                } else {
                    literal.push_str(&rest[start..start + end + 2]);
                }
                rest = &after[end + 1..];
            }
            _ => {
                literal.push('{');
                rest = after;
            }
        }
    }
    literal.push_str(rest);
    if !literal.is_empty() {
        out.push(Segment::Literal(literal));
    }
    out
}

/// Placeholders a template uses, in order of first use.
pub fn placeholders(template: &str) -> Vec<Placeholder> {
    let mut out: Vec<Placeholder> = Vec::new();
    for segment in segments(template) {
        if let Segment::Placeholder(p) = segment {
            if !out.contains(&p) {
                out.push(p);
            }
        }
    }
    out
}

/// `{word}` / `{word.key}` tokens that look like placeholders but are not
/// known (typos such as `{namepsace}`). They stay literal.
pub fn unknown_placeholders(template: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for segment in segments(template) {
        let Segment::Literal(text) = segment else {
            continue;
        };
        let mut rest = text.as_str();
        while let Some(start) = rest.find('{') {
            let after = &rest[start + 1..];
            let Some(end) = after.find('}') else {
                break;
            };
            let inner = &after[..end];
            let (head, tail) = inner.split_once('.').unwrap_or((inner, ""));
            let looks_like = !head.is_empty()
                && head.chars().all(|c| c.is_ascii_lowercase())
                && tail
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '/'));
            let token = format!("{{{inner}}}");
            if looks_like && !out.contains(&token) {
                out.push(token);
            }
            rest = &after[end + 1..];
        }
    }
    out
}

fn is_safe_char(c: char) -> bool {
    c.is_ascii_alphanumeric()
        || matches!(c, '_' | '.' | ',' | ':' | '=' | '@' | '%' | '+' | '/' | '-')
}

/// True when `value` means the same thing in every shell context.
pub fn is_shell_safe(value: &str) -> bool {
    !value.is_empty() && value.chars().all(is_safe_char)
}

/// POSIX single-quoting: safe values stay bare, everything else is wrapped
/// in `'…'` with embedded quotes written as `'\''`.
pub fn shell_quote(value: &str) -> String {
    if is_shell_safe(value) {
        return value.to_string();
    }
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// Shell syntax around a position of the template.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Frame {
    /// Top level or inside `$( … )` / `$(( … ))`, tracking nested parens.
    Unquoted {
        cmd_subst: bool,
        parens: usize,
    },
    Single,
    Double,
    /// `$'…'` (ANSI-C quoting).
    AnsiC,
    /// `` `…` `` (old-style command substitution).
    Backtick,
    /// `${ … }` (parameter expansion).
    Param,
    /// `# …` until the end of the line.
    Comment,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Context {
    Unquoted,
    Single,
    Double,
    /// Only values that need no quoting may be inserted.
    SafeOnly(&'static str),
    Comment,
}

/// Tracks the shell context while the template is scanned literal by literal.
struct Lexer {
    stack: Vec<Frame>,
    /// A `<<` was seen; the heredoc body starts at the next newline.
    heredoc_pending: bool,
    /// Past the start of a heredoc body: be conservative until the end.
    in_heredoc: bool,
    /// Previous significant character, for `$(`, `${`, `$'` and comments.
    prev: Option<char>,
    /// The previous character was an unconsumed backslash escape.
    escaped: bool,
}

impl Lexer {
    fn new() -> Self {
        Self {
            stack: vec![Frame::Unquoted {
                cmd_subst: false,
                parens: 0,
            }],
            heredoc_pending: false,
            in_heredoc: false,
            prev: None,
            escaped: false,
        }
    }

    fn top(&self) -> Frame {
        *self.stack.last().expect("the lexer always has a frame")
    }

    fn context(&self) -> Context {
        if self.in_heredoc {
            return Context::SafeOnly("a heredoc");
        }
        match self.top() {
            Frame::Unquoted { .. } => Context::Unquoted,
            Frame::Single => Context::Single,
            Frame::Double => Context::Double,
            Frame::AnsiC => Context::SafeOnly("$'…'"),
            Frame::Backtick => Context::SafeOnly("backticks"),
            Frame::Param => Context::SafeOnly("${…}"),
            Frame::Comment => Context::Comment,
        }
    }

    /// Feed literal text of the template.
    fn feed(&mut self, text: &str) {
        let chars: Vec<char> = text.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            let c = chars[i];
            let next = chars.get(i + 1).copied();
            if self.escaped {
                // The escaped character is literal in every context.
                self.escaped = false;
                self.prev = Some('a');
                i += 1;
                continue;
            }
            if c == '\n' && self.heredoc_pending {
                self.heredoc_pending = false;
                self.in_heredoc = true;
            }
            match self.top() {
                Frame::Single => {
                    if c == '\'' {
                        self.stack.pop();
                    }
                }
                Frame::AnsiC => match c {
                    '\\' => self.escaped = true,
                    '\'' => {
                        self.stack.pop();
                    }
                    _ => {}
                },
                Frame::Comment => {
                    if c == '\n' {
                        self.stack.pop();
                    }
                }
                Frame::Double => match c {
                    '\\' => self.escaped = true,
                    '"' => {
                        self.stack.pop();
                    }
                    '`' => self.stack.push(Frame::Backtick),
                    '$' if next == Some('(') => {
                        self.stack.push(Frame::Unquoted {
                            cmd_subst: true,
                            parens: 0,
                        });
                        i += 1;
                    }
                    '$' if next == Some('{') => {
                        self.stack.push(Frame::Param);
                        i += 1;
                    }
                    // `$` ended the previous literal: `${…}` spans segments.
                    '{' if self.prev == Some('$') => self.stack.push(Frame::Param),
                    _ => {}
                },
                frame @ (Frame::Unquoted { .. } | Frame::Backtick | Frame::Param) => match c {
                    '\\' => self.escaped = true,
                    '\'' => {
                        if self.prev == Some('$') {
                            self.stack.push(Frame::AnsiC);
                        } else {
                            self.stack.push(Frame::Single);
                        }
                    }
                    '"' => self.stack.push(Frame::Double),
                    '`' => {
                        if frame == Frame::Backtick {
                            self.stack.pop();
                        } else {
                            self.stack.push(Frame::Backtick);
                        }
                    }
                    '$' if next == Some('(') => {
                        self.stack.push(Frame::Unquoted {
                            cmd_subst: true,
                            parens: 0,
                        });
                        i += 1;
                    }
                    '$' if next == Some('{') => {
                        self.stack.push(Frame::Param);
                        i += 1;
                    }
                    '{' if self.prev == Some('$') => self.stack.push(Frame::Param),
                    '(' => {
                        if let Some(Frame::Unquoted {
                            cmd_subst: true,
                            parens,
                        }) = self.stack.last_mut()
                        {
                            *parens += 1;
                        }
                    }
                    ')' => {
                        if let Some(Frame::Unquoted {
                            cmd_subst: true,
                            parens,
                        }) = self.stack.last_mut()
                        {
                            if *parens == 0 {
                                self.stack.pop();
                            } else {
                                *parens -= 1;
                            }
                        }
                    }
                    '}' if frame == Frame::Param => {
                        self.stack.pop();
                    }
                    '#' if frame != Frame::Param && self.at_word_start() => {
                        self.stack.push(Frame::Comment);
                    }
                    '<' if next == Some('<') => {
                        if chars.get(i + 2) != Some(&'<') {
                            self.heredoc_pending = true;
                            i += 1;
                        } else {
                            // `<<<` here-string: the next word is a normal word.
                            i += 2;
                        }
                    }
                    _ => {}
                },
            }
            self.prev = Some(c);
            i += 1;
        }
    }

    fn at_word_start(&self) -> bool {
        match self.prev {
            None => true,
            Some(p) => p.is_whitespace() || matches!(p, ';' | '&' | '|' | '(' | ')' | '<' | '>'),
        }
    }

    /// A substituted value counts as an ordinary word character afterwards.
    fn after_value(&mut self) {
        self.prev = Some('a');
    }
}

fn push_missing(missing: &mut Vec<String>, placeholder: &Placeholder) {
    let token = placeholder.token();
    if !missing.contains(&token) {
        missing.push(token);
    }
}

/// Resolve a shell command template (see the module docs for quoting).
pub fn render_shell(template: &str, values: &TemplateValues) -> Result<Rendered> {
    let mut lexer = Lexer::new();
    let mut out = Rendered::default();
    for segment in segments(template) {
        match segment {
            Segment::Literal(text) => {
                lexer.feed(&text);
                out.text.push_str(&text);
            }
            Segment::Placeholder(placeholder) => {
                let context = lexer.context();
                if context == Context::Comment {
                    out.text.push_str(&placeholder.token());
                    continue;
                }
                if lexer.escaped || lexer.prev == Some('$') {
                    // `\{name}` escapes the brace and `${name}` is the shell's
                    // own parameter expansion: both stay literal.
                    lexer.feed(&placeholder.token());
                    out.text.push_str(&placeholder.token());
                    continue;
                }
                let value = match values.lookup(&placeholder) {
                    Some(value) => value,
                    None => {
                        push_missing(&mut out.missing, &placeholder);
                        Value::One(String::new())
                    }
                };
                out.text
                    .push_str(&quote_for(&placeholder, &value, context)?);
                lexer.after_value();
            }
        }
    }
    Ok(out)
}

fn quote_for(placeholder: &Placeholder, value: &Value, context: Context) -> Result<String> {
    let joined = |items: &[String]| items.join(" ");
    match (context, value) {
        (Context::Unquoted, Value::One(v)) => Ok(shell_quote(v)),
        (Context::Unquoted, Value::Many(items)) => {
            if items.is_empty() {
                return Ok("''".to_string());
            }
            Ok(items
                .iter()
                .map(|v| shell_quote(v))
                .collect::<Vec<_>>()
                .join(" "))
        }
        (Context::Double, value) => {
            let text = match value {
                Value::One(v) => v.clone(),
                Value::Many(items) => joined(items),
            };
            if text.is_empty() || is_shell_safe(&text) {
                Ok(text)
            } else {
                Ok(format!("\"{}\"", shell_quote(&text)))
            }
        }
        (Context::Single, value) => {
            let text = match value {
                Value::One(v) => v.clone(),
                Value::Many(items) => joined(items),
            };
            if text.is_empty() || is_shell_safe(&text) {
                Ok(text)
            } else {
                Ok(format!("'{}'", shell_quote(&text)))
            }
        }
        (Context::SafeOnly(where_), value) => {
            let items: Vec<&String> = match value {
                Value::One(v) => vec![v],
                Value::Many(items) => items.iter().collect(),
            };
            if items.iter().all(|v| v.is_empty() || is_shell_safe(v)) {
                Ok(items
                    .iter()
                    .map(|v| v.as_str())
                    .collect::<Vec<_>>()
                    .join(" "))
            } else {
                bail!(
                    "{} is used inside {where_}, where its value cannot be quoted safely; move it outside",
                    placeholder.token()
                )
            }
        }
        (Context::Comment, _) => Ok(placeholder.token()),
    }
}

/// RFC 3986 percent-encoding of everything but unreserved characters.
pub fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Resolve an `open-url` template: values are percent-encoded, and the
/// result must be an `http(s)://` URL whose scheme comes from the template.
pub fn render_url(template: &str, values: &TemplateValues) -> Result<Rendered> {
    let mut out = Rendered::default();
    for segment in segments(template) {
        match segment {
            Segment::Literal(text) => out.text.push_str(&text),
            Segment::Placeholder(placeholder) => match values.lookup(&placeholder) {
                Some(Value::One(v)) => out.text.push_str(&percent_encode(&v)),
                Some(Value::Many(items)) => out.text.push_str(
                    &items
                        .iter()
                        .map(|v| percent_encode(v))
                        .collect::<Vec<_>>()
                        .join(","),
                ),
                None => push_missing(&mut out.missing, &placeholder),
            },
        }
    }
    out.text = out.text.trim().to_string();
    let lower = out.text.to_ascii_lowercase();
    let rest = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"));
    match rest {
        Some(rest) if !rest.is_empty() && !out.text.chars().any(char::is_control) => Ok(out),
        _ => bail!("the URL must start with http:// or https://"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn values() -> TemplateValues {
        TemplateValues {
            cluster: Some("Prod EU".into()),
            context: Some("arn:aws:eks:eu-west-1:1:cluster/prod".into()),
            kubeconfig: Some("/home/me/.kubepit/run/abc.kubeconfig".into()),
            namespace: Some("shop".into()),
            name: Some("web-0".into()),
            kind: Some("Pod".into()),
            group: Some(String::new()),
            version: Some("v1".into()),
            resource: Some("pods".into()),
            container: Some("app".into()),
            labels: BTreeMap::from([("app".into(), "web".into())]),
            annotations: BTreeMap::from([("note".into(), "it's $(fine)".into())]),
            selection: vec![],
        }
    }

    fn render(template: &str) -> String {
        render_shell(template, &values()).unwrap().text
    }

    #[test]
    fn parses_known_placeholders_only() {
        assert_eq!(Placeholder::parse("name"), Some(Placeholder::Name));
        assert_eq!(
            Placeholder::parse("labels.app.kubernetes.io/name"),
            Some(Placeholder::Label("app.kubernetes.io/name".into()))
        );
        assert_eq!(Placeholder::parse("labels."), None);
        assert_eq!(Placeholder::parse("labels.a b"), None);
        assert_eq!(Placeholder::parse(".metadata.name"), None);
        assert_eq!(Placeholder::parse("Name"), None);
        assert_eq!(
            placeholders("kubectl -n {namespace} get {resource} {name} {name}"),
            vec![
                Placeholder::Namespace,
                Placeholder::Resource,
                Placeholder::Name
            ]
        );
    }

    #[test]
    fn non_placeholder_braces_stay_literal() {
        let t = "kubectl get {resource} {name} -o jsonpath='{range .items[*]}{.metadata.name}{\"\\n\"}{end}' {{.x}} {";
        assert_eq!(
            render(t),
            "kubectl get pods web-0 -o jsonpath='{range .items[*]}{.metadata.name}{\"\\n\"}{end}' {{.x}} {"
        );
        assert_eq!(unknown_placeholders(t), vec!["{end}".to_string()]);
        assert_eq!(
            unknown_placeholders("echo {namepsace} {labels.app} {Name}"),
            vec!["{namepsace}".to_string()]
        );
    }

    #[test]
    fn safe_values_are_inserted_bare() {
        assert_eq!(
            render("kubectl -n {namespace} logs {name} -c {container} --context {context}"),
            "kubectl -n shop logs web-0 -c app --context arn:aws:eks:eu-west-1:1:cluster/prod"
        );
        assert_eq!(render("echo \"{name}\" '{name}'"), "echo \"web-0\" 'web-0'");
        assert_eq!(render("echo {group}x"), "echo ''x");
    }

    #[test]
    fn unsafe_values_are_quoted_per_context() {
        assert_eq!(render("echo {cluster}"), "echo 'Prod EU'");
        assert_eq!(
            render("echo \"at {cluster}!\""),
            "echo \"at \"'Prod EU'\"!\""
        );
        assert_eq!(render("echo 'at {cluster}!'"), "echo 'at ''Prod EU''!'");
        assert_eq!(render("echo {annotations.note}"), r"echo 'it'\''s $(fine)'");
        assert_eq!(render("echo $(echo {cluster})"), "echo $(echo 'Prod EU')");
        assert_eq!(
            render("echo \"$(echo {cluster})\""),
            "echo \"$(echo 'Prod EU')\""
        );
    }

    #[test]
    fn risky_contexts_refuse_unsafe_values() {
        for template in [
            "echo `echo {cluster}`",
            "echo ${X:-{cluster}}",
            "echo $'{cluster}'",
            "cat <<EOF\n{cluster}\nEOF",
        ] {
            let err = render_shell(template, &values()).unwrap_err();
            assert!(err.to_string().contains("{cluster}"), "{template}: {err}");
        }
        // Safe values are fine there.
        assert_eq!(render("echo `echo {name}`"), "echo `echo web-0`");
        assert_eq!(render("cat <<EOF\n{name}\nEOF"), "cat <<EOF\nweb-0\nEOF");
        // A here-string is an ordinary word.
        assert_eq!(render("cat <<< {cluster}"), "cat <<< 'Prod EU'");
    }

    #[test]
    fn comments_and_escaped_braces_are_not_substituted() {
        assert_eq!(render("echo {name} # {cluster}"), "echo web-0 # {cluster}");
        assert_eq!(render("echo a#{name}"), "echo a#web-0");
        assert_eq!(render("echo \\{name}"), "echo \\{name}");
        assert_eq!(
            render("echo ${name} \"${name}\""),
            "echo ${name} \"${name}\""
        );
        assert_eq!(render("echo ${name}{cluster}"), "echo ${name}'Prod EU'");
    }

    #[test]
    fn selection_names_expand_to_words() {
        let mut v = values();
        v.selection = vec!["a".into(), "b c".into()];
        assert_eq!(
            render_shell("kubectl delete pod {selection.names}", &v)
                .unwrap()
                .text,
            "kubectl delete pod a 'b c'"
        );
        assert_eq!(
            render_shell("echo \"{selection.names}\"", &v).unwrap().text,
            "echo \"\"'a b c'\"\""
        );
        // Without a selection the single object is the selection.
        assert_eq!(render("echo {selection.names}"), "echo web-0");
    }

    #[test]
    fn missing_values_are_reported() {
        let mut v = values();
        v.container = None;
        v.labels.clear();
        let out = render_shell(
            "logs {name} -c {container} -l app={labels.app} {container}",
            &v,
        )
        .unwrap();
        assert_eq!(out.text, "logs web-0 -c '' -l app='' ''");
        assert_eq!(out.missing, vec!["{container}", "{labels.app}"]);
    }

    /// Runs every template × hostile value through `/bin/sh -c` and checks
    /// that the value arrives verbatim and nothing else runs.
    #[cfg(unix)]
    #[test]
    fn hostile_values_never_change_the_command() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("pwned");
        let m = marker.to_string_lossy().to_string();
        let hostile = [
            "plain".to_string(),
            "a b".to_string(),
            "it's".to_string(),
            "\"quoted\"".to_string(),
            format!("$(touch {m})"),
            format!("`touch {m}`"),
            format!("; touch {m}"),
            format!("' ; touch {m} ; '"),
            format!("\" ; touch {m} ; \""),
            format!("\\\"; touch {m}; \\\""),
            format!("'\"$(touch {m})\"'"),
            format!("a&&touch {m}"),
            format!("a|touch {m}"),
            format!("a\ntouch {m}"),
            format!("x' || touch {m} #"),
            "$HOME".to_string(),
            "${HOME}".to_string(),
            "*".to_string(),
            "~".to_string(),
            "\\".to_string(),
            "a\\".to_string(),
            "-n".to_string(),
            "%s%s".to_string(),
            "!!".to_string(),
            "{name}".to_string(),
            "$'x'".to_string(),
            "ünïcødé ☸".to_string(),
            "a'b\"c$d`e\\f".to_string(),
            " leading and trailing ".to_string(),
            "".to_string(),
        ];
        let templates: [(&str, &str, &str); 7] = [
            ("printf '%s' {name}", "", ""),
            ("printf '%s' \"{name}\"", "", ""),
            ("printf '%s' '{name}'", "", ""),
            ("printf '%s' \"pre {name} post\"", "pre ", " post"),
            ("printf '%s' 'pre {name} post'", "pre ", " post"),
            ("printf '%s' pre{name}post", "pre", "post"),
            ("printf '%s' \"$(printf '%s' {name})\"", "", ""),
        ];
        for value in &hostile {
            for (template, before, after) in templates {
                // `$( )` drops trailing newlines, like every shell.
                if template.contains("$(") && value.ends_with('\n') {
                    continue;
                }
                let values = TemplateValues {
                    name: Some(value.clone()),
                    ..Default::default()
                };
                let command = render_shell(template, &values).unwrap().text;
                let out = std::process::Command::new("/bin/sh")
                    .arg("-c")
                    .arg(&command)
                    .current_dir(dir.path())
                    .env("HOME", "/nonexistent-home")
                    .output()
                    .unwrap();
                assert_eq!(
                    String::from_utf8_lossy(&out.stdout),
                    format!("{before}{value}{after}"),
                    "template {template:?}, value {value:?}, command {command:?}"
                );
                assert!(!marker.exists(), "{command:?} ran something");
            }
            // Contexts that cannot be quoted refuse instead of guessing.
            for template in [
                "echo `echo {name}`",
                "echo ${X:-{name}}",
                "cat <<E\n{name}\nE",
            ] {
                let values = TemplateValues {
                    name: Some(value.clone()),
                    ..Default::default()
                };
                if let Ok(rendered) = render_shell(template, &values) {
                    assert!(
                        value.is_empty() || is_shell_safe(value),
                        "{template}: {value:?}"
                    );
                    let _ = std::process::Command::new("/bin/sh")
                        .arg("-c")
                        .arg(&rendered.text)
                        .current_dir(dir.path())
                        .output();
                    assert!(!marker.exists());
                }
            }
        }
    }

    #[test]
    fn urls_are_percent_encoded() {
        let out = render_url(
            "https://grafana.example.com/d/x?var-cluster={cluster}&var-ns={namespace}&q={annotations.note}",
            &values(),
        )
        .unwrap();
        assert_eq!(
            out.text,
            "https://grafana.example.com/d/x?var-cluster=Prod%20EU&var-ns=shop&q=it%27s%20%24%28fine%29"
        );
        assert!(render_url("{name}", &values()).is_err());
        assert!(render_url("javascript:alert(1)", &values()).is_err());
        assert!(render_url("file:///etc/passwd", &values()).is_err());
        let mut v = values();
        v.name = Some("https://evil.example".into());
        assert!(render_url("{name}/x", &v).is_err());
    }
}
