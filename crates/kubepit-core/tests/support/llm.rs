//! Reply builders for the fake model provider: Anthropic Messages API
//! server-sent events, OpenAI-compatible `chat/completions` chunks and
//! Ollama NDJSON. The shapes follow the documented wire formats; every
//! builder returns a [`Reply`] (or the events to assemble one), so a test
//! routes `/v1/messages` & co. to it on the 127.0.0.1 fake server.

use serde_json::{json, Value};

use super::{Reply, SseEvent};

/// The model the fake Anthropic server answers with by default.
pub const ANTHROPIC_MODEL: &str = "claude-opus-5";

// ---------------------------------------------------------------------------
// Anthropic Messages API
// ---------------------------------------------------------------------------

/// Anthropic events on the wire: each is named after its `type`.
pub fn anthropic_sse(events: &[Value]) -> Vec<SseEvent> {
    events
        .iter()
        .map(|data| SseEvent {
            event: data["type"].as_str().map(str::to_string),
            data: data.to_string(),
        })
        .collect()
}

/// `events` as one complete stream (no gaps, not cut).
pub fn anthropic_stream(events: &[Value]) -> Reply {
    Reply::Sse {
        events: anthropic_sse(events),
        gap_ms: 0,
        cut_after: None,
    }
}

/// `message_start` of `model` with the input side of `usage`
/// (`input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`).
pub fn message_start_of(model: &str, usage: Value) -> Value {
    let mut usage = usage;
    if usage.get("output_tokens").is_none() {
        usage["output_tokens"] = json!(1);
    }
    json!({
        "type": "message_start",
        "message": {
            "id": "msg_test", "type": "message", "role": "assistant", "content": [],
            "model": model, "stop_reason": null, "stop_sequence": null, "usage": usage,
        }
    })
}

/// [`message_start_of`] the default model.
pub fn message_start(usage: Value) -> Value {
    message_start_of(ANTHROPIC_MODEL, usage)
}

/// `text` in chunks of three characters ("Hello" → "Hel", "lo").
pub fn text_chunks(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    chars.chunks(3).map(|c| c.iter().collect()).collect()
}

pub fn block_start(index: usize, block: Value) -> Value {
    json!({"type": "content_block_start", "index": index, "content_block": block})
}

pub fn block_delta(index: usize, delta: Value) -> Value {
    json!({"type": "content_block_delta", "index": index, "delta": delta})
}

pub fn block_stop(index: usize) -> Value {
    json!({"type": "content_block_stop", "index": index})
}

/// A complete text block streamed in [`text_chunks`].
pub fn text_block(index: usize, text: &str) -> Vec<Value> {
    let mut events = vec![block_start(index, json!({"type": "text", "text": ""}))];
    for chunk in text_chunks(text) {
        events.push(block_delta(
            index,
            json!({"type": "text_delta", "text": chunk}),
        ));
    }
    events.push(block_stop(index));
    events
}

/// A complete thinking block (`display: omitted` sends no thinking text).
pub fn thinking_block(index: usize, thinking: &str, signature: &str) -> Vec<Value> {
    let mut events = vec![block_start(
        index,
        json!({"type": "thinking", "thinking": "", "signature": ""}),
    )];
    if !thinking.is_empty() {
        events.push(block_delta(
            index,
            json!({"type": "thinking_delta", "thinking": thinking}),
        ));
    }
    events.push(block_delta(
        index,
        json!({"type": "signature_delta", "signature": signature}),
    ));
    events.push(block_stop(index));
    events
}

pub fn tool_use_start(index: usize, id: &str, name: &str) -> Value {
    block_start(
        index,
        json!({"type": "tool_use", "id": id, "name": name, "input": {}}),
    )
}

pub fn input_json_delta(index: usize, partial_json: &str) -> Value {
    block_delta(
        index,
        json!({"type": "input_json_delta", "partial_json": partial_json}),
    )
}

/// A complete `tool_use` block whose input arrives in `chunks`.
pub fn tool_use_block(index: usize, id: &str, name: &str, chunks: &[&str]) -> Vec<Value> {
    let mut events = vec![tool_use_start(index, id, name)];
    events.extend(chunks.iter().map(|c| input_json_delta(index, c)));
    events.push(block_stop(index));
    events
}

/// The `fallback` block marking a server-side switch between models.
pub fn fallback_block(index: usize, from: &str, to: &str) -> Vec<Value> {
    vec![
        block_start(
            index,
            json!({"type": "fallback", "from": {"model": from}, "to": {"model": to}}),
        ),
        block_stop(index),
    ]
}

pub fn message_delta(stop_reason: &str, output_tokens: u64) -> Value {
    json!({
        "type": "message_delta",
        "delta": {"stop_reason": stop_reason, "stop_sequence": null},
        "usage": {"output_tokens": output_tokens},
    })
}

pub fn message_stop() -> Value {
    json!({"type": "message_stop"})
}

/// An SSE `error` event (mid-stream failure, e.g. `overloaded_error`).
pub fn error_event(kind: &str, message: &str) -> Value {
    json!({"type": "error", "error": {"type": kind, "message": message}})
}

/// A plain answer: `text` in three-character deltas, `usage` on
/// `message_start` and `output_tokens` (default: the character count) on
/// `message_delta`, `stop_reason: end_turn`.
pub fn anthropic_text(text: &str, usage: Value) -> Reply {
    let output = usage["output_tokens"]
        .as_u64()
        .unwrap_or(text.chars().count() as u64);
    let mut start_usage = usage.clone();
    if let Some(map) = start_usage.as_object_mut() {
        map.remove("output_tokens");
    }
    let mut events = vec![message_start(start_usage)];
    events.extend(text_block(0, text));
    events.push(message_delta("end_turn", output));
    events.push(message_stop());
    anthropic_stream(&events)
}

/// Optional `text`, then one `tool_use` block whose input arrives in
/// `chunks`, `stop_reason: tool_use`.
pub fn anthropic_tool_use(text: &str, id: &str, name: &str, chunks: &[&str]) -> Reply {
    let mut events = vec![message_start(json!({"input_tokens": 100}))];
    let mut index = 0;
    if !text.is_empty() {
        events.extend(text_block(index, text));
        index += 1;
    }
    events.extend(tool_use_block(index, id, name, chunks));
    events.push(message_delta("tool_use", 20));
    events.push(message_stop());
    anthropic_stream(&events)
}

/// A refusal of `category` that interrupted a started (complete) tool call.
pub fn anthropic_refusal(category: &str) -> Reply {
    let mut events = vec![message_start(json!({"input_tokens": 100}))];
    events.extend(text_block(0, "Let me look"));
    events.extend(tool_use_block(
        1,
        "toolu_refused",
        "get_pod",
        &["{\"namespace\":\"shop\",\"pod\":\"web-1\"}"],
    ));
    events.push(json!({
        "type": "message_delta",
        "delta": {
            "stop_reason": "refusal",
            "stop_sequence": null,
            "stop_details": {"type": "refusal", "category": category, "explanation": "Declined."},
        },
        "usage": {"output_tokens": 12},
    }));
    events.push(message_stop());
    anthropic_stream(&events)
}

/// A documented error response (`{"type":"error","error":{…}}`), with a
/// `retry-after` header in seconds when given.
pub fn anthropic_error(code: u16, kind: &str, message: &str, retry_after: Option<u32>) -> Reply {
    let mut headers = vec![("content-type".to_string(), "application/json".to_string())];
    if let Some(seconds) = retry_after {
        headers.push(("retry-after".to_string(), seconds.to_string()));
    }
    Reply::Raw {
        code,
        headers,
        body: json!({
            "type": "error",
            "error": {"type": kind, "message": message},
            "request_id": "req_test",
        })
        .to_string(),
    }
}

/// One Models API entry with the documented capability tree.
pub fn anthropic_model(
    id: &str,
    display_name: &str,
    max_input_tokens: u64,
    max_tokens: u64,
    adaptive: bool,
    effort: bool,
) -> Value {
    json!({
        "type": "model",
        "id": id,
        "display_name": display_name,
        "created_at": "2026-06-01T00:00:00Z",
        "max_input_tokens": max_input_tokens,
        "max_tokens": max_tokens,
        "capabilities": {
            "thinking": {
                "supported": adaptive,
                "types": {"enabled": {"supported": false}, "adaptive": {"supported": adaptive}},
            },
            "effort": {
                "supported": effort,
                "low": {"supported": effort}, "medium": {"supported": effort},
                "high": {"supported": effort}, "max": {"supported": effort},
            },
        },
    })
}

/// One page of `GET /v1/models`.
pub fn anthropic_models_page(models: Vec<Value>, has_more: bool) -> Reply {
    let first = models
        .first()
        .map(|m| m["id"].clone())
        .unwrap_or(Value::Null);
    let last = models
        .last()
        .map(|m| m["id"].clone())
        .unwrap_or(Value::Null);
    Reply::Json(
        200,
        json!({"data": models, "has_more": has_more, "first_id": first, "last_id": last}),
    )
}

// ---------------------------------------------------------------------------
// OpenAI-compatible and Ollama
// ---------------------------------------------------------------------------

/// Unnamed SSE `data:` events, one per chunk, then `data: [DONE]`.
pub fn openai_stream(chunks: &[Value]) -> Reply {
    let mut events: Vec<SseEvent> = chunks
        .iter()
        .map(|chunk| SseEvent {
            event: None,
            data: chunk.to_string(),
        })
        .collect();
    events.push(SseEvent {
        event: None,
        data: "[DONE]".into(),
    });
    Reply::Sse {
        events,
        gap_ms: 0,
        cut_after: None,
    }
}

/// A `chat.completion.chunk` carrying `delta` (and `finish_reason`).
pub fn openai_chunk(delta: Value, finish_reason: Option<&str>) -> Value {
    json!({
        "id": "chatcmpl-test", "object": "chat.completion.chunk", "created": 1,
        "model": "gpt-test",
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
    })
}

/// The final usage chunk (`stream_options.include_usage`): no choices.
pub fn openai_usage(usage: Value) -> Value {
    json!({
        "id": "chatcmpl-test", "object": "chat.completion.chunk", "created": 1,
        "model": "gpt-test", "choices": [], "usage": usage,
    })
}

/// NDJSON lines through the existing [`Reply::Stream`] (held open after
/// the last line, like a real server between requests).
pub fn ollama_stream(lines: &[Value]) -> Reply {
    Reply::Stream(lines.to_vec())
}

/// One streamed Ollama `/api/chat` line.
pub fn ollama_line(content: &str) -> Value {
    json!({
        "model": "llama3.1:8b", "created_at": "2026-09-29T10:00:00Z",
        "message": {"role": "assistant", "content": content}, "done": false,
    })
}

/// The final Ollama line with its counters.
pub fn ollama_done(done_reason: &str, prompt_eval_count: u64, eval_count: u64) -> Value {
    json!({
        "model": "llama3.1:8b", "created_at": "2026-09-29T10:00:01Z",
        "message": {"role": "assistant", "content": ""}, "done": true,
        "done_reason": done_reason, "total_duration": 1000,
        "prompt_eval_count": prompt_eval_count, "eval_count": eval_count,
    })
}
