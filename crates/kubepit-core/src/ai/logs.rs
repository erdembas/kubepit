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
//!    one-line summary; the whole output never exceeds `max_lines` lines.

use std::collections::BTreeSet;
use std::sync::LazyLock;

use regex::Regex;

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

impl Entry<'_> {
    fn render(&self) -> String {
        if self.count > 1 {
            format!("{} (×{})", self.line, self.count)
        } else {
            self.line.to_string()
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

/// Lines (entries plus gap markers) the selection `picked` renders to.
fn rendered_lines(picked: &BTreeSet<usize>) -> usize {
    let mut lines = 0;
    let mut next = 0;
    for &i in picked {
        if i != next {
            lines += 1; // gap marker
        }
        lines += 1;
        next = i + 1;
    }
    lines
}

/// Condense `text` to at most `max_lines` lines (see the module docs).
pub fn condense_log_text(text: &str, max_lines: usize) -> String {
    let entries = dedupe(text);
    let raw_lines = text.lines().count();
    if entries.len() <= max_lines {
        return join(entries.iter().map(Entry::render));
    }
    if max_lines < 2 {
        return format!("… {raw_lines} lines omitted …")
            .lines()
            .take(max_lines)
            .collect();
    }
    // One line for the summary, the rest for entries and gap markers.
    let budget = max_lines - 1;
    let total = entries.len();
    let mut picked = BTreeSet::new();
    // Errors take at most half of the budget, newest first, two lines each
    // (the entry and a gap marker in the worst case).
    let error_budget = budget / 2;
    for (i, _) in entries
        .iter()
        .enumerate()
        .rev()
        .filter(|(_, e)| is_error_line(e.line))
    {
        if (picked.len() + 1) * 2 > error_budget {
            break;
        }
        picked.insert(i);
    }
    // The tail fills the rest.
    for i in (0..total).rev() {
        if picked.contains(&i) {
            continue;
        }
        picked.insert(i);
        if rendered_lines(&picked) > budget {
            picked.remove(&i);
            break;
        }
    }
    let errors = picked
        .iter()
        .filter(|&&i| is_error_line(entries[i].line))
        .count();
    let shown: usize = picked.iter().map(|&i| entries[i].count).sum();
    let mut out = vec![format!(
        "… condensed: {shown} of {raw_lines} lines ({errors} error lines kept, repeats collapsed) …"
    )];
    let mut next = 0;
    for &i in &picked {
        if i != next {
            let omitted: usize = entries[next..i].iter().map(|e| e.count).sum();
            out.push(format!("… {omitted} lines omitted …"));
        }
        out.push(entries[i].render());
        next = i + 1;
    }
    join(out.into_iter())
}

fn join(lines: impl Iterator<Item = String>) -> String {
    lines.collect::<Vec<_>>().join("\n")
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
    }
}
