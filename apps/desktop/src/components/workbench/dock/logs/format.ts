/**
 * Pod log line formatting for the xterm log view. Mirrors RunHQ's
 * `log-xterm/format.ts`: keep explicit ANSI colour untouched, and only
 * colour plain text lines that carry a recognisable level — errors in red,
 * warnings with a yellow level token — so busy logs stay readable.
 */

// ESC sequences other than SGR (cursor moves, erase, OSC titles, …) would
// corrupt a read-only log view; only colour/style survives.
const ANSI_NON_SGR_RE =
  // eslint-disable-next-line no-control-regex
  /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-9;?]*[@A-HJKSTfhlnpsuDEMLR]|[()][A-Z0-9]|[=>DEMHcp78])/g;
// eslint-disable-next-line no-control-regex
const ANSI_ALL_RE =
  /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][A-Z0-9]|[=>DEMHcp78])/g;
// eslint-disable-next-line no-control-regex
const SGR_RE = /\x1b\[[0-9;]*m/y;

/** RFC 3339 prefix added by the API server when `timestamps=true`. */
const TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))\s/;

const ERROR_RES = [
  /\b(?:ERROR|FATAL|PANIC|CRITICAL|SEVERE|EMERG(?:ENCY)?)\b/,
  /\[(?:error|crit|alert|emerg)\]/, // nginx / apache
  /\blevel[=:]\s*"?(?:error|err|fatal|panic|critical|crit|dpanic)\b/i,
  /"(?:level|severity|lvl|log\.level)"\s*:\s*"(?:error|err|fatal|panic|critical|crit|severe|emergency|alert|dpanic)"/i,
  /^(?:panic:|fatal error:|Traceback \(most recent call last\)|Exception in thread)/,
  /^[EF]\d{4} \d{2}:\d{2}:\d{2}/, // klog
  /^\s*(?:[\w$]+\.)+[\w$]*(?:Exception|Error)(?::|$)/, // java.lang.IllegalStateException: …
];

const WARN_RES = [
  /\b(?:WARN|WARNING)\b/,
  /\[warn(?:ing)?\]/,
  /(?<=\blevel[=:]\s*"?)(?:warn|warning)\b/i,
  /(?<="(?:level|severity|lvl|log\.level)"\s*:\s*")(?:warn|warning)(?=")/i,
  /^W\d{4}(?= \d{2}:\d{2}:\d{2})/, // klog
];

export type LogLevel = 'error' | 'warn' | null;

export function detectLevel(text: string): LogLevel {
  if (ERROR_RES.some((re) => re.test(text))) return 'error';
  if (WARN_RES.some((re) => re.test(text))) return 'warn';
  return null;
}

export function sanitizeAnsi(input: string): string {
  const cr = input.lastIndexOf('\r');
  const collapsed = cr === -1 ? input : input.slice(cr + 1);
  return collapsed.replace(ANSI_NON_SGR_RE, '');
}

export function stripAnsi(input: string): string {
  return input.replace(ANSI_ALL_RE, '');
}

function highlight(body: string): string {
  const level = detectLevel(body);
  if (level === 'error') return `\x1b[31m${body}\x1b[39m`;
  if (level === 'warn') {
    for (const re of WARN_RES) {
      const match = re.exec(body);
      if (match) {
        const end = match.index + match[0].length;
        return `${body.slice(0, match.index)}\x1b[93m${match[0]}\x1b[39m${body.slice(end)}`;
      }
    }
  }
  return body;
}

/** Cut to `width` visible cells (ANSI-aware), marking the cut with a dim ellipsis. */
export function truncateAnsi(text: string, width: number): string {
  let visible = 0;
  let i = 0;
  while (i < text.length) {
    SGR_RE.lastIndex = i;
    const sgr = SGR_RE.exec(text);
    if (sgr) {
      i += sgr[0].length;
      continue;
    }
    const code = text.codePointAt(i)!;
    const size = code > 0xffff ? 2 : 1;
    if (visible >= width - 1) {
      // Only cut when something visible actually follows.
      if (stripAnsi(text.slice(i)).length > 1) return `${text.slice(0, i)}\x1b[0m\x1b[2m…\x1b[22m`;
      return text;
    }
    visible += 1;
    i += size;
  }
  return text;
}

export interface LogFormatOptions {
  wrap: boolean;
  cols: number;
}

/** Bytes written to xterm for one raw log line (no trailing newline in `text`). */
export function formatLogLine(text: string, opts: LogFormatOptions): string {
  let body = sanitizeAnsi(text);
  let ts = '';
  const match = TIMESTAMP_RE.exec(body);
  if (match) {
    ts = match[1]!;
    body = body.slice(match[0].length);
  }
  if (!body.includes('\x1b[')) body = highlight(body);
  let line = ts ? `\x1b[2m${ts}\x1b[22m ${body}` : body;
  if (!opts.wrap && opts.cols > 8) line = truncateAnsi(line, opts.cols);
  // Reset so an unterminated colour in one line never bleeds into the next.
  return `${line}\x1b[0m\r\n`;
}
