//! A server-sent events parser (WHATWG `text/event-stream`) for the
//! Anthropic and OpenAI-compatible streams, plus the newline splitter of
//! Ollama's NDJSON.
//!
//! Bytes arrive in arbitrary chunks: lines are split on `\n`, `\r\n` or
//! `\r` (also across chunks) and decoded only once complete, so a UTF-8
//! character split between chunks is never mangled. Both parsers are
//! bounded: a line or an event larger than the limit (default
//! [`MAX_EVENT_BYTES`]) is an error instead of unbounded buffering.

use std::fmt;

/// Largest single SSE event (`data`) or NDJSON line, in bytes.
pub const MAX_EVENT_BYTES: usize = 1024 * 1024;

/// A line or event exceeded the parser's limit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EventTooLarge {
    pub limit: usize,
}

impl fmt::Display for EventTooLarge {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "the provider sent a stream event larger than {} KiB",
            self.limit / 1024
        )
    }
}

impl std::error::Error for EventTooLarge {}

/// Incremental SSE parser: [`SseParser::push`] returns every event
/// completed by the new bytes as `(event name, data)`. Comments, `id:` and
/// `retry:` are ignored; an event without `data:` is not dispatched.
#[derive(Debug)]
pub struct SseParser {
    lines: LineSplitter,
    event: Option<String>,
    data: String,
    has_data: bool,
    limit: usize,
}

impl Default for SseParser {
    fn default() -> Self {
        Self::new()
    }
}

impl SseParser {
    pub fn new() -> Self {
        Self::with_limit(MAX_EVENT_BYTES)
    }

    pub fn with_limit(limit: usize) -> Self {
        Self {
            lines: LineSplitter::with_limit(limit),
            event: None,
            data: String::new(),
            has_data: false,
            limit,
        }
    }

    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<(Option<String>, String)>, EventTooLarge> {
        let mut events = Vec::new();
        for line in self.lines.push(bytes)? {
            self.line(&line, &mut events)?;
        }
        Ok(events)
    }

    fn line(
        &mut self,
        line: &str,
        events: &mut Vec<(Option<String>, String)>,
    ) -> Result<(), EventTooLarge> {
        if line.is_empty() {
            let event = self.event.take();
            if std::mem::take(&mut self.has_data) {
                events.push((event, std::mem::take(&mut self.data)));
            }
            return Ok(());
        }
        if line.starts_with(':') {
            return Ok(());
        }
        let (field, value) = match line.split_once(':') {
            Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
            None => (line, ""),
        };
        match field {
            "event" => self.event = (!value.is_empty()).then(|| value.to_string()),
            "data" => {
                if self.has_data {
                    self.data.push('\n');
                }
                self.data.push_str(value);
                self.has_data = true;
                if self.data.len() > self.limit {
                    return Err(EventTooLarge { limit: self.limit });
                }
            }
            _ => {}
        }
        Ok(())
    }
}

/// Splits a byte stream into lines (`\n`, `\r\n` or `\r`), decoded as UTF-8
/// (lossy) once complete. A line longer than the limit is an error.
#[derive(Debug)]
pub struct LineSplitter {
    buf: Vec<u8>,
    pending_cr: bool,
    limit: usize,
}

impl Default for LineSplitter {
    fn default() -> Self {
        Self::with_limit(MAX_EVENT_BYTES)
    }
}

impl LineSplitter {
    pub fn with_limit(limit: usize) -> Self {
        Self {
            buf: Vec::new(),
            pending_cr: false,
            limit,
        }
    }

    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<String>, EventTooLarge> {
        let mut lines = Vec::new();
        let mut rest = bytes;
        if self.pending_cr {
            self.pending_cr = false;
            if let Some(stripped) = rest.strip_prefix(b"\n") {
                rest = stripped;
            }
        }
        while let Some(pos) = rest.iter().position(|b| *b == b'\n' || *b == b'\r') {
            self.extend(&rest[..pos])?;
            lines.push(String::from_utf8_lossy(&std::mem::take(&mut self.buf)).into_owned());
            let cr = rest[pos] == b'\r';
            rest = &rest[pos + 1..];
            if cr {
                match rest.first() {
                    Some(b'\n') => rest = &rest[1..],
                    Some(_) => {}
                    None => self.pending_cr = true,
                }
            }
        }
        self.extend(rest)?;
        Ok(lines)
    }

    fn extend(&mut self, bytes: &[u8]) -> Result<(), EventTooLarge> {
        if self.buf.len() + bytes.len() > self.limit {
            return Err(EventTooLarge { limit: self.limit });
        }
        self.buf.extend_from_slice(bytes);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all(parser: &mut SseParser, chunks: &[&[u8]]) -> Vec<(Option<String>, String)> {
        chunks
            .iter()
            .flat_map(|chunk| parser.push(chunk).unwrap())
            .collect()
    }

    #[test]
    fn parses_named_and_unnamed_events() {
        let mut parser = SseParser::new();
        let events = all(
            &mut parser,
            &[b"event: message_start\ndata: {\"a\":1}\n\ndata: [DONE]\n\n"],
        );
        assert_eq!(
            events,
            vec![
                (Some("message_start".into()), "{\"a\":1}".into()),
                (None, "[DONE]".into())
            ]
        );
    }

    #[test]
    fn handles_any_chunking_and_line_ending() {
        let wire = "event: ping\r\ndata: {\"x\":\"ü\"}\r\n\r\n: comment\nevent: e2\rdata:no-space\r\rdata: a\ndata: b\n\n";
        let expected = vec![
            (Some("ping".to_string()), "{\"x\":\"ü\"}".to_string()),
            (Some("e2".to_string()), "no-space".to_string()),
            (None, "a\nb".to_string()),
        ];
        let bytes = wire.as_bytes();
        for size in 1..=bytes.len() {
            let mut parser = SseParser::new();
            let chunks: Vec<&[u8]> = bytes.chunks(size).collect();
            assert_eq!(all(&mut parser, &chunks), expected, "chunk size {size}");
        }
    }

    #[test]
    fn events_without_data_are_not_dispatched() {
        let mut parser = SseParser::new();
        assert!(parser
            .push(b"event: x\n\nid: 7\nretry: 10\n\n")
            .unwrap()
            .is_empty());
        // The name does not leak into the next event.
        assert_eq!(
            parser.push(b"data: y\n\n").unwrap(),
            vec![(None, "y".into())]
        );
    }

    #[test]
    fn oversized_lines_and_events_are_refused() {
        let mut parser = SseParser::with_limit(16);
        assert_eq!(
            parser.push(&[b'a'; 17]).unwrap_err(),
            EventTooLarge { limit: 16 }
        );
        let mut parser = SseParser::with_limit(16);
        assert!(parser
            .push(b"data: 0123456789\ndata: 0123456789\n")
            .is_err());
        let mut parser = SseParser::with_limit(16);
        assert!(parser.push(b"data: 0123456789\n\n").is_ok());
    }

    #[test]
    fn splits_ndjson_lines() {
        let mut lines = LineSplitter::default();
        assert!(lines.push(b"{\"a\":").unwrap().is_empty());
        assert_eq!(
            lines.push(b"1}\n{\"b\":2}\n{").unwrap(),
            vec!["{\"a\":1}".to_string(), "{\"b\":2}".to_string()]
        );
        let mut small = LineSplitter::with_limit(4);
        assert!(small.push(b"12345").is_err());
    }
}
