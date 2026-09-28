import { splitK8sTimestamp, stripAnsi } from './ansi';
import { normalizeLevel, type LogLevel } from './levels';
import { epochToMs, klogTime, parseClfTime, parseIsoTime, parseTimeValue } from './time';

/**
 * Structured parsing of single log lines. Detects, per line:
 *
 * - JSON objects (zap, logrus JSON, slog, pino/bunyan, ECS, Serilog, …)
 * - logfmt (`level=info msg="…" key=value`, logrus text, go-kit, slog text)
 * - klog (`I0927 12:00:00.000000  1 file.go:12] msg`, incl. structured klog)
 * - common text layouts: Spring Boot / logback, log4j, Python logging, zap
 *   console, Go `log`, nginx error logs, bracketed / leading levels,
 *   logrus TTY (`INFO[0001]`), access logs (level from the status code),
 *   Go panics, Python tracebacks and Java exception headers
 *
 * and turns it into `{ time, level, message, fields }`. Two entry points:
 * {@link detectLevelToken} is the cheap one run on every incoming line (it
 * never builds objects); {@link parseLogLine} is the full parse, run lazily
 * for the structured view. Kubernetes timestamp prefixes
 * (`timestamps=true`) and ANSI colours are removed first.
 */

export type LogFormat = 'json' | 'logfmt' | 'klog' | 'text';

export interface ParsedLog {
  format: LogFormat;
  /** Epoch ms: the line's own timestamp, else the Kubernetes prefix. */
  time: number | null;
  level: LogLevel | null;
  /** The human message ('' when the line has none, e.g. JSON without `msg`). */
  message: string;
  /** Every other field, flattened (`http.status`), values as display text. */
  fields: Record<string, string>;
  /** The decoded object of a JSON line (pretty view), else null. */
  json: Record<string, unknown> | null;
}

export interface ParseOptions {
  /** Year for klog timestamps (klog omits it); defaults to the current year. */
  year?: number;
}

// ---------------------------------------------------------------------------
// Well-known keys
// ---------------------------------------------------------------------------

const LEVEL_KEYS = [
  'level',
  'lvl',
  'severity',
  'log.level',
  'levelname',
  'loglevel',
  'log_level',
  'levelName',
  'severityText',
  'severity_text',
  '@l',
  '@level',
  'l',
];
const TIME_KEYS = [
  'time',
  'ts',
  'timestamp',
  '@timestamp',
  't',
  '@t',
  'date',
  'datetime',
  'eventTime',
  'timeMillis',
  'time_local',
  'asctime',
];
const MESSAGE_KEYS = ['msg', 'message', '@m', '@mt', 'log', 'text', 'event', 'MESSAGE', 'Message'];
const LOGFMT_LEVEL_KEYS = ['level', 'lvl', 'severity', 'loglevel', 'log.level'];
const LOGFMT_TIME_KEYS = ['time', 'ts', 't', 'timestamp', 'date'];
const LOGFMT_MESSAGE_KEYS = ['msg', 'message', 'event'];

// ---------------------------------------------------------------------------
// Cheap level detection (every incoming line)
// ---------------------------------------------------------------------------

/** Where the level of a line is written, in the text passed in. */
export interface LevelToken {
  level: LogLevel;
  start: number;
  end: number;
}

const JSON_LEVEL_RE =
  /"(?:level|lvl|severity|levelname|loglevel|log_level|levelName|severityText|severity_text|@l|@level)"\s*:\s*"?([A-Za-z]{1,12}|\d{1,2})\b/;
const LOGFMT_LEVEL_RE =
  /(?:^|\s)(?:level|lvl|severity|loglevel)=("?)([A-Za-z]{1,12}|\d{1,2})\1(?=\s|$)/;
const KLOG_RE =
  /^([IWEF])(\d{2})(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?\s+(\d+)\s+([^\]\s]+)\]\s?/;
const TTY_RE = /^(TRAC|DEBU|INFO|WARN|ERRO|FATA|PANI)\[(\d+)\]\s*/;
/** An uppercase level word (or a bracketed lower-case one) near the start. */
const WORD_LEVEL_RE =
  /(?:^|[\s[|(<:-])(TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|ERR|FATAL|CRITICAL|CRIT|PANIC|SEVERE|DPANIC|\[(?:trace|debug|info|notice|warn|warning|error|err|crit|alert|emerg|fatal)\])(?=$|[\s\]|):>,-])/;
const ACCESS_RE =
  /^(\S+) (\S+) (\S+) \[([^\]]+)\] "([A-Z]+) (\S+)(?: (HTTP\/[\d.]+))?" (\d{3}) (\d+|-)(?: "([^"]*)" "([^"]*)")?(.*)$/;
const PANIC_RE = /^(?:panic: |fatal error: )/;
const TRACEBACK_RE = /^Traceback \(most recent call last\):/;
const EXCEPTION_RE = /^(?:[\w$]+\.)+[\w$]*(?:Exception|Error|Throwable)(?::\s|$)/;

function accessLevel(status: number): LogLevel {
  return status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
}

/**
 * The level of a line and where it is written (for colouring the token),
 * or null. `text` must be ANSI-free and without the Kubernetes prefix.
 */
export function detectLevelToken(text: string): LevelToken | null {
  const first = text.charCodeAt(0);
  if (first === 123 /* { */) {
    const m = JSON_LEVEL_RE.exec(text);
    if (m) {
      const level = normalizeLevel(m[1]!.length <= 2 && /\d/.test(m[1]!) ? Number(m[1]) : m[1]);
      if (level) {
        const start = m.index + m[0].length - m[1]!.length;
        return { level, start, end: start + m[1]!.length };
      }
    }
    return null;
  }
  const klog = KLOG_RE.exec(text);
  if (klog) return { level: normalizeLevel(klog[1])!, start: 0, end: 1 };
  const tty = TTY_RE.exec(text);
  if (tty) return { level: normalizeLevel(tty[1])!, start: 0, end: tty[1]!.length };
  const logfmt = LOGFMT_LEVEL_RE.exec(text);
  if (logfmt) {
    const raw = logfmt[2]!;
    const level = normalizeLevel(/^\d+$/.test(raw) ? Number(raw) : raw);
    if (level) {
      const start = logfmt.index + logfmt[0].length - raw.length - logfmt[1]!.length;
      return { level, start, end: start + raw.length };
    }
  }
  // Only the head of the line: messages mention "error" all the time.
  const head = text.length > 160 ? text.slice(0, 160) : text;
  const word = WORD_LEVEL_RE.exec(head);
  if (word) {
    const token = word[1]!;
    const bare = token.startsWith('[') ? token.slice(1, -1) : token;
    const level = normalizeLevel(bare);
    if (level) {
      const start = word.index + word[0].length - token.length;
      return { level, start, end: start + token.length };
    }
  }
  if (PANIC_RE.test(text)) return { level: 'fatal', start: 0, end: text.indexOf(':') };
  if (TRACEBACK_RE.test(text) || EXCEPTION_RE.test(text))
    return { level: 'error', start: 0, end: 0 };
  const access = ACCESS_RE.exec(text);
  if (access) {
    const start = text.indexOf(`" ${access[8]} `) + 2;
    return { level: accessLevel(Number(access[8])), start, end: start + 3 };
  }
  return null;
}

/** Level of a raw line (Kubernetes prefix and ANSI allowed). */
export function detectLevel(raw: string): LogLevel | null {
  return detectLevelToken(stripAnsi(splitK8sTimestamp(raw).body))?.level ?? null;
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

function display(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** Flatten nested objects (`a.b.c`, depth ≤ 4); arrays stay JSON. */
function flatten(
  obj: Record<string, unknown>,
  out: Record<string, string>,
  prefix = '',
  depth = 0,
) {
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value) && depth < 4) {
      flatten(value as Record<string, unknown>, out, path, depth + 1);
    } else {
      out[path] = display(value);
    }
  }
}

function lookup(obj: Record<string, unknown>, key: string): unknown {
  if (key in obj) return obj[key];
  const dot = key.indexOf('.');
  if (dot < 0) return undefined;
  const head = obj[key.slice(0, dot)];
  return head && typeof head === 'object'
    ? (head as Record<string, unknown>)[key.slice(dot + 1)]
    : undefined;
}

function parseJson(body: string, k8sTime: number | null): ParsedLog | null {
  if (body.charCodeAt(body.length - 1) !== 125 /* } */) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(body);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const record = obj as Record<string, unknown>;
  const used = new Set<string>();
  const pick = (keys: string[], accept: (v: unknown) => boolean) => {
    for (const key of keys) {
      const value = lookup(record, key);
      if (value !== undefined && accept(value)) {
        used.add(key);
        return value;
      }
    }
    return undefined;
  };
  const level = normalizeLevel(pick(LEVEL_KEYS, (v) => normalizeLevel(v) !== null));
  const time = parseTimeValue(pick(TIME_KEYS, (v) => parseTimeValue(v) !== null));
  const message = pick(MESSAGE_KEYS, (v) => typeof v === 'string');
  const all: Record<string, string> = {};
  flatten(record, all);
  const fields: Record<string, string> = {};
  for (const key of Object.keys(all)) if (!used.has(key)) fields[key] = all[key]!;
  return {
    format: 'json',
    time: time ?? k8sTime,
    level,
    message: typeof message === 'string' ? message : '',
    fields,
    json: record,
  };
}

// ---------------------------------------------------------------------------
// logfmt
// ---------------------------------------------------------------------------

/** `key=value key2="quoted \"value\""` pairs; null when the text is not logfmt. */
export function parseLogfmt(text: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  let pairs = 0;
  let bare = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    while (i < n && text.charCodeAt(i) <= 32) i++;
    if (i >= n) break;
    const keyStart = i;
    while (i < n && text.charCodeAt(i) > 32 && text[i] !== '=' && text[i] !== '"') i++;
    const key = text.slice(keyStart, i);
    if (text[i] !== '=' || !key) {
      // A bare word (or a stray quote): skip it.
      if (text[i] === '"') {
        i++;
        while (i < n && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
        i++;
      } else {
        while (i < n && text.charCodeAt(i) > 32) i++;
      }
      bare++;
      if (pairs === 0) return null; // logfmt starts with a pair
      continue;
    }
    i++; // '='
    let value = '';
    if (text[i] === '"') {
      i++;
      let chunk = '';
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < n) {
          const next = text[i + 1]!;
          chunk += next === 'n' ? '\n' : next === 't' ? '\t' : next;
          i += 2;
        } else {
          chunk += text[i];
          i++;
        }
      }
      i++; // closing quote
      value = chunk;
    } else {
      const start = i;
      while (i < n && text.charCodeAt(i) > 32) i++;
      value = text.slice(start, i);
    }
    out[key] = value;
    pairs++;
  }
  return pairs >= 2 && pairs >= bare * 2 ? out : null;
}

function firstKey(fields: Record<string, string>, keys: string[]): string | undefined {
  return keys.find((k) => k in fields);
}

function fromLogfmt(pairs: Record<string, string>, k8sTime: number | null): ParsedLog {
  const levelKey = firstKey(pairs, LOGFMT_LEVEL_KEYS);
  const timeKey = firstKey(pairs, LOGFMT_TIME_KEYS);
  const messageKey = firstKey(pairs, LOGFMT_MESSAGE_KEYS);
  const fields: Record<string, string> = {};
  for (const key of Object.keys(pairs))
    if (key !== levelKey && key !== timeKey && key !== messageKey) fields[key] = pairs[key]!;
  return {
    format: 'logfmt',
    time: (timeKey ? parseTimeValue(pairs[timeKey]) : null) ?? k8sTime,
    level: levelKey ? normalizeLevel(pairs[levelKey]) : null,
    message: messageKey ? pairs[messageKey]! : '',
    fields,
    json: null,
  };
}

// ---------------------------------------------------------------------------
// klog
// ---------------------------------------------------------------------------

/** `"quoted msg" k=v …` (structured klog) → message + fields. */
function klogMessage(rest: string, fields: Record<string, string>): string {
  if (rest.charCodeAt(0) !== 34 /* " */) return rest;
  let i = 1;
  let message = '';
  while (i < rest.length && rest[i] !== '"') {
    if (rest[i] === '\\' && i + 1 < rest.length) {
      message += rest[i + 1];
      i += 2;
    } else {
      message += rest[i];
      i++;
    }
  }
  const tail = rest.slice(i + 1).trim();
  if (tail) {
    const pairs = parseLogfmt(tail) ?? (/^\S+=/.test(tail) ? parseSinglePair(tail) : null);
    if (pairs) Object.assign(fields, pairs);
    else return rest;
  }
  return message;
}

function parseSinglePair(text: string): Record<string, string> | null {
  const eq = text.indexOf('=');
  if (eq <= 0) return null;
  const value = text.slice(eq + 1);
  return {
    [text.slice(0, eq)]: value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value,
  };
}

// ---------------------------------------------------------------------------
// Text layouts
// ---------------------------------------------------------------------------

const TS_HEAD_RE =
  /^\[?(\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?(?:\s?(?:Z|UTC|[+-]\d{2}:?\d{2}))?)\]?\s+/;
const LEVEL_HEAD_RE = /^\[?([A-Za-z]{1,9})\]?(?::\s*|\s+)/;
const SPRING_RE = /^(\d+) --- \[\s*([^\]]*)\]\s+(\S+)\s*:\s(.*)$/s;
const PYTHON_RE = /^- (\S+) - ([A-Z]+) - (.*)$/s;
const LOG4J_RE = /^\[([^\]]+)\]\s+([A-Z]+)\s+(\S+)\s+-\s(.*)$/s;
const PY_DEFAULT_RE = /^(DEBUG|INFO|WARNING|ERROR|CRITICAL):([\w.]+):(.*)$/s;
const UPPER_LEVEL_RE =
  /^\[?(TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|ERR|FATAL|CRITICAL|PANIC|SEVERE)\]?(?::\s*|\s+)(.*)$/s;

function textResult(
  time: number | null,
  level: LogLevel | null,
  message: string,
  fields: Record<string, string> = {},
): ParsedLog {
  return { format: 'text', time, level, message, fields, json: null };
}

/** After a leading timestamp: zap console, Spring, Python, log4j, `[level]`. */
function afterTimestamp(rest: string, time: number | null): ParsedLog {
  // zap console: `LEVEL\tcaller\tmessage\t{json}`.
  if (rest.includes('\t')) {
    const parts = rest.split('\t');
    const level = normalizeLevel(parts[0]);
    if (level && parts.length >= 2) {
      const fields: Record<string, string> = {};
      let tail = parts.slice(1);
      const last = tail[tail.length - 1]!;
      if (tail.length > 1 && last.startsWith('{') && last.endsWith('}')) {
        try {
          flatten(JSON.parse(last) as Record<string, unknown>, fields);
          tail = tail.slice(0, -1);
        } catch {
          /* not JSON: part of the message */
        }
      }
      if (tail.length > 1 && /^[\w./-]+:\d+$/.test(tail[0]!)) {
        fields.caller = tail[0]!;
        tail = tail.slice(1);
      }
      return textResult(time, level, tail.join('\t'), fields);
    }
  }
  const python = PYTHON_RE.exec(rest);
  if (python)
    return textResult(time, normalizeLevel(python[2]), python[3]!, { logger: python[1]! });
  const log4j = LOG4J_RE.exec(rest);
  if (log4j && normalizeLevel(log4j[2]))
    return textResult(time, normalizeLevel(log4j[2]), log4j[4]!, {
      thread: log4j[1]!,
      logger: log4j[3]!,
    });
  const head = LEVEL_HEAD_RE.exec(rest);
  const level = head ? normalizeLevel(head[1]) : null;
  if (head && level && (head[1]!.length > 1 || head[0].includes('['))) {
    const body = rest.slice(head[0].length);
    const spring = SPRING_RE.exec(body);
    if (spring)
      return textResult(time, level, spring[4]!, {
        pid: spring[1]!,
        thread: spring[2]!.trim(),
        logger: spring[3]!,
      });
    const pairs = body.includes('=') ? parseLogfmt(body) : null;
    if (pairs) {
      const parsed = fromLogfmt(pairs, time);
      return { ...parsed, format: 'text', level: parsed.level ?? level };
    }
    return textResult(time, level, body);
  }
  return textResult(time, null, rest);
}

function parseText(body: string, k8sTime: number | null): ParsedLog {
  const ts = TS_HEAD_RE.exec(body);
  if (ts) {
    const time = parseIsoTime(ts[1]!) ?? k8sTime;
    const parsed = afterTimestamp(body.slice(ts[0].length), time);
    if (parsed.level) return parsed;
    const token = detectLevelToken(body);
    return token ? { ...parsed, level: token.level } : parsed;
  }
  const tty = TTY_RE.exec(body);
  if (tty) {
    const rest = body.slice(tty[0].length);
    const pairs = rest.includes('=') ? splitTrailingPairs(rest) : null;
    return textResult(k8sTime, normalizeLevel(tty[1]), pairs?.message ?? rest, pairs?.fields);
  }
  const py = PY_DEFAULT_RE.exec(body);
  if (py) return textResult(k8sTime, normalizeLevel(py[1]), py[3]!, { logger: py[2]! });
  const upper = UPPER_LEVEL_RE.exec(body);
  if (upper) {
    const rest = upper[2]!;
    const ts2 = TS_HEAD_RE.exec(rest);
    return textResult(
      (ts2 ? parseIsoTime(ts2[1]!) : null) ?? k8sTime,
      normalizeLevel(upper[1]),
      ts2 ? rest.slice(ts2[0].length) : rest,
    );
  }
  const access = ACCESS_RE.exec(body);
  if (access) {
    const status = Number(access[8]);
    const fields: Record<string, string> = {
      remote_addr: access[1]!,
      method: access[5]!,
      path: access[6]!,
      status: access[8]!,
      bytes: access[9]!,
    };
    if (access[2] !== '-') fields.ident = access[2]!;
    if (access[3] !== '-') fields.user = access[3]!;
    if (access[7]) fields.protocol = access[7];
    if (access[10] !== undefined && access[10] !== '-') fields.referer = access[10];
    if (access[11] !== undefined) fields.user_agent = access[11];
    const extra = access[12]?.trim();
    if (extra) fields.extra = extra;
    return textResult(
      parseClfTime(access[4]!) ?? k8sTime,
      accessLevel(status),
      `${access[5]} ${access[6]} ${status}`,
      fields,
    );
  }
  return textResult(k8sTime, detectLevelToken(body)?.level ?? null, body);
}

/** `message key=value key2=value` (logrus TTY) → message + trailing pairs. */
function splitTrailingPairs(
  text: string,
): { message: string; fields: Record<string, string> } | null {
  const m = /^(.*?)\s{2,}(\S+=.*)$/.exec(text);
  if (!m) return null;
  const pairs = parseLogfmt(m[2]!) ?? parseSinglePair(m[2]!);
  return pairs ? { message: m[1]!, fields: pairs } : null;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Full parse of one raw line (Kubernetes timestamp prefix and ANSI allowed). */
export function parseLogLine(raw: string, options: ParseOptions = {}): ParsedLog {
  const { ts, body: withAnsi } = splitK8sTimestamp(raw);
  const body = stripAnsi(withAnsi).trim();
  const k8sTime = ts ? parseIsoTime(ts) : null;
  if (!body) return textResult(k8sTime, null, '');
  if (body.charCodeAt(0) === 123 /* { */) {
    const json = parseJson(body, k8sTime);
    if (json) return json;
  }
  const klog = KLOG_RE.exec(body);
  if (klog) {
    const fields: Record<string, string> = { pid: klog[8]!, caller: klog[9]! };
    const year = options.year ?? new Date().getUTCFullYear();
    const message = klogMessage(body.slice(klog[0].length), fields);
    return {
      format: 'klog',
      time: k8sTime ?? klogTime(klog[2]!, klog[3]!, [klog[4]!, klog[5]!, klog[6]!], klog[7], year),
      level: normalizeLevel(klog[1]),
      message,
      fields,
      json: null,
    };
  }
  if (body.includes('=') && /^[\w.@-]+=/.test(body)) {
    const pairs = parseLogfmt(body);
    if (pairs) return fromLogfmt(pairs, k8sTime);
  }
  return parseText(body, k8sTime);
}

/** Epoch ms of a line's Kubernetes prefix, if it has one. */
export function k8sPrefixTime(raw: string): number | null {
  const { ts } = splitK8sTimestamp(raw);
  return ts ? parseIsoTime(ts) : null;
}

export { epochToMs };
