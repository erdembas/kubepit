//! Plain-text log condensation for the `get_pod_logs` tool (spec §11), the
//! Rust counterpart of the UI's `condenseLogs`: deterministic and local, no
//! model involved.
//!
//! 1. Every line gets a key with digits, long hex runs and UUIDs replaced by
//!    `#`, so lines that differ only in timestamps, ids or counters compare
//!    equal; a run of consecutive equal keys collapses into its last line
//!    with ` (×N)`.
//! 2. When the result still has more than `max_lines` lines, the error
//!    lines (level token `error`, `fatal` or `panic`, klog `E`/`F` records,
//!    `Exception`, `Traceback`) are kept first — the most recent ones when
//!    there are many — and the rest of the budget is filled from the tail.
//! 3. Gaps are marked `… N lines omitted …` and the output starts with a
//!    one-line summary; the whole output never exceeds `max_lines` lines
//!    (nor, with [`condense_log`], a byte budget: long lines such as JSON
//!    records cannot push the newest lines out).
//!
//! Lines longer than [`MAX_LINE_CHARS`] characters are cut with
//! `… [+N chars]`.

use std::borrow::Cow;
use std::collections::BTreeSet;
use std::sync::LazyLock;

use regex::Regex;

/// Characters a condensed line keeps at most.
pub const MAX_LINE_CHARS: usize = 500;

/// UUIDs, hex words of at least 8 characters, and digit runs.
static VARIABLE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|\b[0-9a-fA-F]{8,}\b|[0-9]+",
    )
    .expect("valid regex")
});

/// The line with its variable parts (digits, hex, UUIDs) replaced by `#`.
pub fn line_key(line: &str) -> String {
    VARIABLE.replace_all(line, "#").into_owned()
}

/// A leading RFC 3339 timestamp (`timestamps=true` prefixes every line).
fn strip_timestamp(line: &str) -> &str {
    let Some((first, rest)) = line.split_once(' ') else {
        return line;
    };
    let looks_like_time = first.len() >= 20
        && first.as_bytes()[0].is_ascii_digit()
        && first.contains('T')
        && (first.ends_with('Z') || first.contains('+'));
    if looks_like_time {
        rest
    } else {
        line
    }
}

/// An error record: a level token `error` / `fatal` / `panic`, a klog
/// `E`/`F` header (`E0501 10:00:00.000000 …`), or an exception trace.
pub fn is_error_line(line: &str) -> bool {
    if line.contains("Exception") || line.contains("Traceback") {
        return true;
    }
    let body = strip_timestamp(line).trim_start();
    let bytes = body.as_bytes();
    if bytes.len() > 5
        && matches!(bytes[0], b'E' | b'F')
        && bytes[1..5].iter().all(u8::is_ascii_digit)
        && bytes[5] == b' '
    {
        return true;
    }
    body.split(|c: char| !c.is_ascii_alphanumeric())
        .any(|token| {
            token.eq_ignore_ascii_case("error")
                || token.eq_ignore_ascii_case("fatal")
                || token.eq_ignore_ascii_case("panic")
        })
}

/// One line of the deduplicated log: the last line of a run and its size.
struct Entry<'a> {
    line: &'a str,
    count: usize,
}

/// `line` cut to [`MAX_LINE_CHARS`] characters with `… [+N chars]`.
fn cut_line(line: &str) -> Cow<'_, str> {
    match line.char_indices().nth(MAX_LINE_CHARS) {
        None => Cow::Borrowed(line),
        Some((at, _)) => {
            let rest = line[at..].chars().count();
            Cow::Owned(format!("{}… [+{rest} chars]", &line[..at]))
        }
    }
}

impl Entry<'_> {
    fn render(&self) -> String {
        let line = cut_line(self.line);
        if self.count > 1 {
            format!("{line} (×{})", self.count)
        } else {
            line.into_owned()
        }
    }
}

fn dedupe(text: &str) -> Vec<Entry<'_>> {
    let mut out: Vec<Entry<'_>> = Vec::new();
    let mut last_key: Option<String> = None;
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        let key = line_key(line);
        match (&last_key, out.last_mut()) {
            (Some(prev), Some(entry)) if *prev == key => {
                entry.line = line;
                entry.count += 1;
            }
            _ => {
                out.push(Entry { line, count: 1 });
                last_key = Some(key);
            }
        }
    }
    out
}

fn gap_marker(omitted: usize) -> String {
    format!("… {omitted} lines omitted …")
}

/// The deduplicated log, rendered, with what a selection of it costs.
struct Rendered<'a> {
    entries: Vec<Entry<'a>>,
    lines: Vec<String>,
    /// `before[i]`: raw lines of `entries[..i]`.
    before: Vec<usize>,
}

impl<'a> Rendered<'a> {
    fn new(text: &'a str) -> Self {
        let entries = dedupe(text);
        let lines = entries.iter().map(Entry::render).collect();
        let mut before = Vec::with_capacity(entries.len() + 1);
        let mut sum = 0;
        before.push(0);
        for entry in &entries {
            sum += entry.count;
            before.push(sum);
        }
        Self {
            entries,
            lines,
            before,
        }
    }

    /// Lines and bytes (newlines included) of `picked` with its gap markers.
    fn cost(&self, picked: &BTreeSet<usize>) -> (usize, usize) {
        let (mut lines, mut bytes, mut next) = (0, 0, 0);
        for &i in picked {
            if i != next {
                lines += 1;
                bytes += gap_marker(self.before[i] - self.before[next]).len() + 1;
            }
            lines += 1;
            bytes += self.lines[i].len() + 1;
            next = i + 1;
        }
        (lines, bytes)
    }
}

/// Room kept for the summary line when a byte budget applies.
const SUMMARY_BYTES: usize = 160;

/// Condense `text` to at most `max_lines` lines (see the module docs).
pub fn condense_log_text(text: &str, max_lines: usize) -> String {
    condense_log(text, max_lines, usize::MAX)
}

/// [`condense_log_text`] that also stays within `max_bytes`: errors take
/// at most half of either budget and the tail fills the rest from the end,
/// so the newest line survives whatever the line lengths.
pub fn condense_log(text: &str, max_lines: usize, max_bytes: usize) -> String {
    let log = Rendered::new(text);
    let raw_lines = text.lines().count();
    let total = log.entries.len();
    let all_bytes: usize = log.lines.iter().map(|l| l.len() + 1).sum();
    if total <= max_lines && all_bytes.saturating_sub(1) <= max_bytes {
        return log.lines.join("\n");
    }
    if max_lines < 2 {
        return gap_marker(raw_lines)
            .lines()
            .take(max_lines)
            .filter(|l| l.len() <= max_bytes)
            .collect();
    }
    // One line for the summary, the rest for entries and gap markers.
    let line_budget = max_lines - 1;
    let byte_budget = max_bytes.saturating_sub(SUMMARY_BYTES);
    let fits = |picked: &BTreeSet<usize>, lines: usize, bytes: usize| {
        let (l, b) = log.cost(picked);
        l <= lines && b <= bytes
    };
    let mut picked = BTreeSet::new();
    // Errors first, newest first, within half of each budget.
    for i in (0..total)
        .rev()
        .filter(|&i| is_error_line(log.entries[i].line))
    {
        picked.insert(i);
        if !fits(&picked, line_budget / 2, byte_budget / 2) {
            picked.remove(&i);
            break;
        }
    }
    // The tail fills the rest.
    for i in (0..total).rev() {
        if picked.contains(&i) {
            continue;
        }
        picked.insert(i);
        if !fits(&picked, line_budget, byte_budget) {
            picked.remove(&i);
            break;
        }
    }
    let errors = picked
        .iter()
        .filter(|&&i| is_error_line(log.entries[i].line))
        .count();
    let shown: usize = picked.iter().map(|&i| log.entries[i].count).sum();
    let mut out = vec![format!(
        "… condensed: {shown} of {raw_lines} lines ({errors} error lines kept, repeats collapsed) …"
    )];
    let mut next = 0;
    for &i in &picked {
        if i != next {
            out.push(gap_marker(log.before[i] - log.before[next]));
        }
        out.push(log.lines[i].clone());
        next = i + 1;
    }
    keep_end(out.join("\n"), max_bytes)
}

/// Safety net for budgets too small for the summary: the last `max` bytes,
/// starting on a character boundary.
fn keep_end(text: String, max: usize) -> String {
    if text.len() <= max {
        return text;
    }
    let mut start = text.len() - max;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    text[start..].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_ignore_digits_hex_and_uuids() {
        assert_eq!(
            line_key("2024-05-01T10:00:00.123Z GET /orders/42 took 17ms"),
            line_key("2024-05-01T10:00:09.999Z GET /orders/7 took 3ms")
        );
        assert_eq!(
            line_key("request 3f2b9c1e-8d4a-4b6e-9f1a-2c3d4e5f6a7b done"),
            "request # done"
        );
        assert_eq!(line_key("commit deadbeefcafe"), "commit #");
        assert_ne!(line_key("connected"), line_key("disconnected"));
    }

    #[test]
    fn error_lines_are_recognized() {
        for line in [
            "2024-05-01T10:00:00Z level=error msg=\"db down\"",
            "{\"level\":\"FATAL\",\"msg\":\"boom\"}",
            "panic: runtime error: index out of range",
            "E0501 10:00:00.000000       1 controller.go:42] sync failed",
            "2024-05-01T10:00:00.1Z F0501 10:00:00.000000 1 main.go:9] exiting",
            "java.lang.IllegalStateException: closed",
            "Traceback (most recent call last):",
        ] {
            assert!(is_error_line(line), "{line}");
        }
        for line in [
            "level=info msg=ok",
            "Errors: 0",
            "I0501 10:00:00 ok",
            "terrorist",
        ] {
            assert!(!is_error_line(line), "{line}");
        }
    }

    #[test]
    fn short_logs_only_collapse_repeats() {
        let text = "start\nretry 1\nretry 2\nretry 3\nready";
        assert_eq!(condense_log_text(text, 10), "start\nretry 3 (×3)\nready");
        assert_eq!(condense_log_text("", 10), "");
    }

    #[test]
    fn long_logs_keep_errors_and_the_tail_within_the_cap() {
        let mut lines = Vec::new();
        for i in 0..400 {
            lines.push(format!(
                "info step {i} of phase {}",
                if i % 2 == 0 { "a" } else { "b" }
            ));
            if i == 17 {
                lines.push("level=error msg=\"early failure\"".into());
            }
        }
        lines.push("tail line".into());
        let text = lines.join("\n");
        let out = condense_log_text(&text, 50);
        assert!(out.lines().count() <= 50, "{}", out.lines().count());
        assert!(out.contains("early failure"), "errors are kept");
        assert!(out.ends_with("tail line"), "the tail is kept");
        assert!(out.contains("lines omitted"));
        assert!(out.starts_with("… condensed:"));
    }

    #[test]
    fn many_errors_leave_room_for_the_tail() {
        let text: Vec<String> = (0..300)
            .map(|i| format!("ERROR failure {i} in module {}", i % 7))
            .chain(["last words".to_string()])
            .collect();
        let out = condense_log_text(&text.join("\n"), 40);
        assert!(out.lines().count() <= 40);
        assert!(out.ends_with("last words"));
    }

    #[test]
    fn tiny_caps_never_overflow() {
        let text = (0..100).map(|i| format!("{i} x{i}y")).collect::<Vec<_>>();
        let text = text.join("\n");
        for cap in 0..5 {
            assert!(
                condense_log_text(&text, cap).lines().count() <= cap,
                "{cap}"
            );
        }
        for bytes in [0, 10, 100, 300] {
            let out = condense_log(&text, 50, bytes);
            assert!(out.len() <= bytes, "{bytes}: {}", out.len());
        }
    }

    #[test]
    fn long_lines_are_cut_with_a_marker() {
        let line = format!("{}{}", "é".repeat(MAX_LINE_CHARS), "x".repeat(1_500));
        let out = condense_log_text(&format!("start\n{line}\nend"), 10);
        let cut = out.lines().nth(1).unwrap();
        assert!(cut.starts_with(&"é".repeat(MAX_LINE_CHARS)));
        assert!(cut.ends_with("… [+1500 chars]"), "{cut}");
        assert!(out.ends_with("end"));
    }

    /// 500 long, distinct JSON records: an early error, a crash at the end.
    fn json_log() -> String {
        (0..500)
            .map(|i| {
                let level = if i == 20 { "error" } else { "info" };
                let msg = if i == 499 {
                    "CRASH: out of memory".to_string()
                } else {
                    format!("handled request {} for tenant {}", word(i), word(i * 7))
                };
                format!(
                    "2024-05-01T10:00:{:02}.000000000Z {{\"level\":\"{level}\",\"msg\":\"{msg}\",\"trace\":\"{}\"}}",
                    i % 60,
                    "t".repeat(300)
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Letters only, so every record keeps its own line key.
    fn word(mut i: usize) -> String {
        let mut out = String::new();
        loop {
            out.push((b'a' + (i % 26) as u8) as char);
            i /= 26;
            if i == 0 {
                return out;
            }
        }
    }

    #[test]
    fn the_byte_budget_keeps_the_newest_lines() {
        let text = json_log();
        assert!(text.len() > 150_000);
        let out = condense_log(&text, 199, 30_000);
        assert!(out.len() <= 30_000, "{}", out.len());
        assert!(out.lines().count() <= 199);
        assert!(
            out.contains("CRASH: out of memory"),
            "the last line survives"
        );
        assert!(out.lines().last().unwrap().contains("CRASH"));
        assert!(out.contains("\"level\":\"error\""), "errors are kept");
        assert!(out.starts_with("… condensed:"));
        // Without a byte budget only the line cap applies.
        assert!(condense_log_text(&text, 199).len() > 30_000);
    }
}
