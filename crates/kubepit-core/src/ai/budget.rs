//! Local token estimate and section fitting (spec D13, §11).
//!
//! Nothing here calls a provider: the estimate is
//! `ceil(ascii_bytes / 3.5) + non_ascii_chars`, deliberately on the high
//! side, and shown as "≈". Every function is linear in the text: cuts are
//! computed in one scan from the token target, never by re-estimating.

use std::borrow::Cow;
use std::sync::LazyLock;

use regex::Regex;

use super::types::{AiPreviewSection, AiSectionFormat};

/// Sections are capped at this size before redaction.
pub const MAX_SECTION_BYTES: usize = 1024 * 1024;
/// A section that would be trimmed below this becomes its marker alone.
pub const MIN_SECTION_TOKENS: u32 = 64;
/// Room left under [`MAX_SECTION_BYTES`] for a cut's marker.
const MARKER_RESERVE: usize = 64;
/// The largest count a marker is sized for.
const MAX_COUNT: u64 = u32::MAX as u64;

static LINES_MARKER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"… ([0-9]+) lines omitted …").expect("valid marker pattern"));
static TRUNCATED_MARKER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"… truncated \(≈([0-9]+) tokens\) …").expect("valid marker pattern")
});

/// `ceil(ascii_bytes / 3.5) + non_ascii_chars`.
pub fn estimate_tokens(text: &str) -> u32 {
    let (ascii, other) = if text.is_ascii() {
        (text.len() as u64, 0)
    } else {
        let mut ascii = 0u64;
        let mut other = 0u64;
        for &b in text.as_bytes() {
            if b < 0x80 {
                ascii += 1;
            } else if b >= 0xC0 {
                other += 1;
            }
        }
        (ascii, other)
    };
    clamp(tokens_for(ascii, other))
}

fn tokens_for(ascii: u64, other: u64) -> u64 {
    (2 * ascii).div_ceil(7) + other
}

fn clamp(n: u64) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

/// A section being fitted: its preview (text, tokens, flags), how it is cut
/// and its priority (0 = kept longest).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FitSection {
    pub preview: AiPreviewSection,
    pub format: AiSectionFormat,
    pub priority: u8,
}

/// Trims sections until the included ones fit `budget` tokens. The victim
/// is always the included section with the highest priority number (ties:
/// the later one): `log` sections lose their middle (20 % head, 80 % tail
/// lines kept), others their tail, each with a marker saying what went; a
/// section that would fall under [`MIN_SECTION_TOKENS`] becomes its marker.
/// Only when every section is down to its marker are markers dropped too,
/// so the budget holds whatever it is. `sections` should be sorted by
/// priority (stable); excluded sections are left alone.
pub fn fit_sections(sections: &mut [FitSection], budget: u32) {
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Stage {
        Cut,
        Floor,
        Empty,
    }
    let mut stage: Vec<Stage> = sections
        .iter()
        .map(|s| {
            if s.preview.excluded || s.preview.text.is_empty() {
                Stage::Empty
            } else {
                Stage::Cut
            }
        })
        .collect();
    let budget = u64::from(budget);
    loop {
        let total: u64 = sections
            .iter()
            .filter(|s| !s.preview.excluded)
            .map(|s| u64::from(s.preview.tokens))
            .sum();
        if total <= budget {
            return;
        }
        let over = total - budget;
        let pick = |wanted: Stage| {
            (0..sections.len())
                .filter(|&i| stage[i] == wanted)
                .max_by_key(|&i| (sections[i].priority, i))
        };
        let Some(i) = pick(Stage::Cut).or_else(|| pick(Stage::Floor)) else {
            return;
        };
        let section = &mut sections[i];
        let preview = &mut section.preview;
        if stage[i] == Stage::Floor {
            preview.text.clear();
            preview.tokens = 0;
            preview.trimmed = true;
            stage[i] = Stage::Empty;
            continue;
        }
        stage[i] = Stage::Floor;
        let target = u64::from(preview.tokens).saturating_sub(over);
        let text = if target >= u64::from(MIN_SECTION_TOKENS) {
            let target = clamp(target);
            match section.format {
                AiSectionFormat::Log => cut_log(&preview.text, target),
                _ => cut_tail(&preview.text, target),
            }
        } else {
            let marker = marker_only(&preview.text, section.format);
            if estimate_tokens(&marker) >= preview.tokens {
                continue;
            }
            marker
        };
        preview.tokens = estimate_tokens(&text);
        preview.text = text;
        preview.trimmed = true;
    }
}

fn lines_marker(n: u64) -> String {
    format!("… {n} lines omitted …")
}

fn truncated_marker(n: u64) -> String {
    format!("… truncated (≈{n} tokens) …")
}

/// The marker that replaces a whole section.
fn marker_only(text: &str, format: AiSectionFormat) -> String {
    match format {
        AiSectionFormat::Log => lines_marker(omitted_lines(text)),
        _ => truncated_marker(removed_tokens(text)),
    }
}

/// Lines in a removed region, counting the lines earlier markers stand for.
fn omitted_lines(region: &str) -> u64 {
    if region.is_empty() {
        return 0;
    }
    let newlines = region.bytes().filter(|&b| b == b'\n').count() as u64;
    let mut n = newlines + u64::from(!region.ends_with('\n'));
    if region.contains(" lines omitted …") {
        for c in LINES_MARKER.captures_iter(region) {
            n += c[1].parse::<u64>().unwrap_or(0).saturating_sub(1);
        }
    }
    n.min(MAX_COUNT)
}

/// Tokens in a removed region, counting what earlier markers stand for.
fn removed_tokens(region: &str) -> u64 {
    let mut n = u64::from(estimate_tokens(region));
    if region.contains(" tokens) …") {
        for c in TRUNCATED_MARKER.captures_iter(region) {
            n += c[1].parse::<u64>().unwrap_or(0);
        }
    }
    n.min(MAX_COUNT)
}

/// Keeps whole lines from the head (20 %) and the tail (80 %) of `target`
/// tokens and marks the middle; the result never exceeds `target` (for any
/// target above the marker itself).
fn cut_log(text: &str, target: u32) -> String {
    let reserve = estimate_tokens(&format!("\n{}\n", lines_marker(MAX_COUNT)));
    if target <= reserve {
        return marker_only(text, AiSectionFormat::Log);
    }
    let avail = target - reserve;
    let head_limit = avail / 5;
    let head_end = align_head(text, head_end_for_tokens(text, head_limit));
    let tail_start =
        align_tail(text, tail_start_for_tokens(text, avail - head_limit)).max(head_end);
    join_log(text, head_end, tail_start)
}

/// Keeps the head of `target` tokens (ending at a line when one is near)
/// and marks the rest.
fn cut_tail(text: &str, target: u32) -> String {
    let reserve = estimate_tokens(&format!("\n{}", truncated_marker(MAX_COUNT)));
    if target <= reserve {
        return marker_only(text, AiSectionFormat::Text);
    }
    let end = align_cut(text, head_end_for_tokens(text, target - reserve));
    let (head, removed) = text.split_at(end);
    if removed.is_empty() {
        return text.to_string();
    }
    let marker = truncated_marker(removed_tokens(removed));
    let mut out = String::with_capacity(head.len() + marker.len() + 1);
    out.push_str(head);
    if !head.is_empty() && !head.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(&marker);
    out
}

/// `head` + marker line + `tail`.
fn join_log(text: &str, head_end: usize, tail_start: usize) -> String {
    let (head, rest) = text.split_at(head_end);
    let (removed, tail) = rest.split_at(tail_start - head_end);
    if removed.is_empty() {
        return text.to_string();
    }
    let marker = lines_marker(omitted_lines(removed));
    let mut out = String::with_capacity(head.len() + marker.len() + tail.len() + 2);
    out.push_str(head);
    if !head.is_empty() && !head.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(&marker);
    if !tail.is_empty() {
        out.push('\n');
        out.push_str(tail);
    }
    out
}

/// The largest char boundary whose prefix fits `limit` tokens (one scan).
fn head_end_for_tokens(text: &str, limit: u32) -> usize {
    let limit = u64::from(limit);
    let (mut ascii, mut other) = (0u64, 0u64);
    for (i, &b) in text.as_bytes().iter().enumerate() {
        if b < 0x80 {
            ascii += 1;
        } else if b >= 0xC0 {
            other += 1;
        } else {
            continue; // inside a character
        }
        if tokens_for(ascii, other) > limit {
            return i;
        }
    }
    text.len()
}

/// The smallest char boundary whose suffix fits `limit` tokens (one scan).
fn tail_start_for_tokens(text: &str, limit: u32) -> usize {
    let limit = u64::from(limit);
    let (mut ascii, mut other) = (0u64, 0u64);
    let mut start = text.len();
    for (j, &b) in text.as_bytes().iter().enumerate().rev() {
        if b < 0x80 {
            ascii += 1;
        } else if b >= 0xC0 {
            other += 1;
        } else {
            continue;
        }
        if tokens_for(ascii, other) > limit {
            return start;
        }
        start = j;
    }
    0
}

/// Back to the start of the line `end` falls in (unless there is none).
fn align_head(text: &str, end: usize) -> usize {
    text[..end].rfind('\n').map_or(end, |nl| nl + 1)
}

/// Forward to the start of the next line (unless that leaves nothing).
fn align_tail(text: &str, start: usize) -> usize {
    if start == 0 || text.as_bytes()[start - 1] == b'\n' {
        return start;
    }
    match text[start..].find('\n') {
        Some(p) if start + p + 1 < text.len() => start + p + 1,
        _ => start,
    }
}

/// Back to a line end when one is in the second half of the kept text.
fn align_cut(text: &str, end: usize) -> usize {
    match text[..end].rfind('\n') {
        Some(nl) if nl + 1 >= end / 2 => nl + 1,
        _ => end,
    }
}

fn floor_boundary(text: &str, mut i: usize) -> usize {
    if i >= text.len() {
        return text.len();
    }
    while !text.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn ceil_boundary(text: &str, mut i: usize) -> usize {
    if i >= text.len() {
        return text.len();
    }
    while !text.is_char_boundary(i) {
        i += 1;
    }
    i
}

/// A section's content capped at [`MAX_SECTION_BYTES`] before redaction:
/// logs keep 20 % head and 80 % tail lines around a marker (in `text`);
/// other formats keep a line-aligned prefix, so a cut manifest still
/// parses, and the marker comes back as `suffix` to append after redaction.
pub(crate) struct Precap<'a> {
    pub text: Cow<'a, str>,
    pub suffix: Option<String>,
    pub capped: bool,
}

pub(crate) fn precap(text: &str, format: AiSectionFormat) -> Precap<'_> {
    if text.len() <= MAX_SECTION_BYTES {
        return Precap {
            text: Cow::Borrowed(text),
            suffix: None,
            capped: false,
        };
    }
    let keep = MAX_SECTION_BYTES - MARKER_RESERVE;
    if format == AiSectionFormat::Log {
        let head = keep / 5;
        let head_end = align_head(text, floor_boundary(text, head));
        let tail_start =
            align_tail(text, ceil_boundary(text, text.len() - (keep - head))).max(head_end);
        return Precap {
            text: Cow::Owned(join_log(text, head_end, tail_start)),
            suffix: None,
            capped: true,
        };
    }
    let end = align_cut(text, floor_boundary(text, keep));
    Precap {
        text: Cow::Borrowed(&text[..end]),
        suffix: Some(truncated_marker(removed_tokens(&text[end..]))),
        capped: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::types::{AiPreviewSection, AiSectionKind, RedactionCounts};

    fn fit(id: &str, priority: u8, format: AiSectionFormat, text: String) -> FitSection {
        let tokens = estimate_tokens(&text);
        FitSection {
            preview: AiPreviewSection {
                id: id.into(),
                kind: AiSectionKind::Logs,
                label: id.into(),
                text,
                tokens,
                original_tokens: tokens,
                trimmed: false,
                excluded: false,
                redactions: RedactionCounts::default(),
            },
            format,
            priority,
        }
    }

    fn lines(n: usize) -> String {
        (1..=n)
            .map(|i| format!("line {i:05} çalışıyor ok\n"))
            .collect()
    }

    fn total(sections: &[FitSection]) -> u32 {
        sections
            .iter()
            .filter(|s| !s.preview.excluded)
            .map(|s| s.preview.tokens)
            .sum()
    }

    #[test]
    fn estimate_is_conservative_and_counts_non_ascii() {
        assert_eq!(estimate_tokens("abcdefg"), 2);
        assert_eq!(estimate_tokens("ğüşİöç"), 6);
    }

    #[test]
    fn estimates_round_up_and_add_up_conservatively() {
        assert_eq!(estimate_tokens(""), 0);
        assert_eq!(estimate_tokens("a"), 1);
        assert_eq!(estimate_tokens("abcdefgh"), 3);
        assert_eq!(estimate_tokens("aç"), 2);
        let (a, b) = ("abc", "defg");
        assert!(estimate_tokens(a) + estimate_tokens(b) >= estimate_tokens("abcdefg"));
    }

    #[test]
    fn the_highest_priority_number_is_trimmed_first_and_the_later_one_on_ties() {
        let text = "x".repeat(1_750); // 500 tokens
        let mut s = vec![
            fit("a", 0, AiSectionFormat::Text, text.clone()),
            fit("b", 2, AiSectionFormat::Text, text.clone()),
            fit("c", 2, AiSectionFormat::Text, text.clone()),
        ];
        fit_sections(&mut s, 1_200);
        assert!(total(&s) <= 1_200);
        assert!(!s[0].preview.trimmed && !s[1].preview.trimmed && s[2].preview.trimmed);
        assert!(s[2].preview.text.contains("truncated (≈"));
        assert_eq!(s[2].preview.original_tokens, 500);
    }

    #[test]
    fn sections_that_would_fall_under_64_tokens_become_their_marker() {
        let mut s = vec![
            fit("keep", 0, AiSectionFormat::Text, "k".repeat(700)),
            fit("logs", 2, AiSectionFormat::Log, lines(100)),
            fit("tail", 3, AiSectionFormat::Yaml, "y: z\n".repeat(100)),
        ];
        fit_sections(&mut s, 230);
        assert!(total(&s) <= 230);
        assert_eq!(s[1].preview.text, "… 100 lines omitted …");
        assert_eq!(s[2].preview.text, "… truncated (≈143 tokens) …");
        assert!(s[1].preview.trimmed && s[2].preview.trimmed && !s[0].preview.trimmed);
    }

    #[test]
    fn any_budget_is_met_even_zero() {
        for budget in [0, 1, 10, 50, 100] {
            let mut s = vec![
                fit("a", 0, AiSectionFormat::Text, "a".repeat(400)),
                fit("b", 1, AiSectionFormat::Log, lines(30)),
                fit("c", 1, AiSectionFormat::Json, "{}".into()),
            ];
            fit_sections(&mut s, budget);
            assert!(total(&s) <= budget, "budget {budget}");
        }
    }

    #[test]
    fn excluded_sections_neither_count_nor_change() {
        let mut s = vec![
            fit("a", 0, AiSectionFormat::Text, "a".repeat(350)),
            fit("x", 5, AiSectionFormat::Text, "x".repeat(35_000)),
        ];
        s[1].preview.excluded = true;
        fit_sections(&mut s, 100);
        assert!(!s[0].preview.trimmed && !s[1].preview.trimmed);
        assert_eq!(s[1].preview.text.len(), 35_000);
    }

    #[test]
    fn cuts_never_exceed_their_target() {
        let log = lines(2_000);
        let text: String = "ağaç ".repeat(20_000);
        let one_line = "z".repeat(50_000);
        for target in [64, 65, 100, 333, 1_000, 4_096, 9_999] {
            for (input, cut) in [
                (&log, cut_log as fn(&str, u32) -> String),
                (&text, cut_tail),
                (&one_line, cut_log),
                (&one_line, cut_tail),
            ] {
                let out = cut(input, target);
                assert!(
                    estimate_tokens(&out) <= target,
                    "target {target}: {}",
                    estimate_tokens(&out)
                );
                assert!(out.len() < input.len());
            }
        }
    }

    #[test]
    fn log_cuts_keep_whole_head_and_tail_lines() {
        let out = cut_log(&lines(1_000), 1_000);
        let kept: Vec<&str> = out.lines().collect();
        assert!(
            kept[0].starts_with("line 00001 ") && kept.last().unwrap().starts_with("line 01000 ")
        );
        let marker = kept
            .iter()
            .position(|l| l.ends_with("lines omitted …"))
            .unwrap();
        // 20 % head, 80 % tail.
        assert!(marker * 3 < kept.len() - marker);
        let omitted: usize = kept[marker]
            .trim_start_matches("… ")
            .split(' ')
            .next()
            .unwrap()
            .parse()
            .unwrap();
        assert_eq!(omitted + kept.len() - 1, 1_000);
    }

    #[test]
    fn repeated_cuts_count_every_omitted_line() {
        let log = lines(60_000);
        let capped = precap(&log, AiSectionFormat::Log);
        assert!(capped.capped && capped.suffix.is_none());
        let once = capped.text.into_owned();
        assert!(once.len() <= MAX_SECTION_BYTES);
        let twice = cut_log(&once, 2_000);
        let kept = twice.lines().count() - 1;
        let marker = twice
            .lines()
            .find(|l| l.ends_with("lines omitted …"))
            .unwrap();
        let omitted: usize = marker.split(' ').nth(1).unwrap().parse().unwrap();
        assert_eq!(omitted + kept, 60_000);
    }

    #[test]
    fn precap_bounds_bytes_and_keeps_manifest_prefixes_parseable() {
        let small = "a: b\n";
        let p = precap(small, AiSectionFormat::Yaml);
        assert!(!p.capped && p.text == small && p.suffix.is_none());

        let yaml: String = (0..200_000).map(|i| format!("k{i}: v{i}\n")).collect();
        let p = precap(&yaml, AiSectionFormat::Yaml);
        assert!(p.capped && p.text.len() <= MAX_SECTION_BYTES && p.text.ends_with('\n'));
        assert!(yaml.starts_with(p.text.as_ref()));
        let suffix = p.suffix.unwrap();
        assert!(suffix.starts_with("… truncated (≈") && suffix.ends_with(" tokens) …"));

        let log = format!("{}\n{}", "é".repeat(700_000), "ş".repeat(700_000));
        let p = precap(&log, AiSectionFormat::Log);
        assert!(p.text.len() <= MAX_SECTION_BYTES && p.text.contains("lines omitted"));
    }
}
