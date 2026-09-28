import { splitK8sTimestamp, stripAnsi } from '@/lib/logs/ansi';
import { LEVEL_SGR, type LogLevel } from '@/lib/logs/levels';
import { detectLevelToken } from '@/lib/logs/parse';

export { stripAnsi };

/**
 * Pod log line formatting for the xterm log views. Mirrors RunHQ's
 * `log-xterm/format.ts`: keep explicit ANSI colour untouched, and only
 * colour plain text lines by their level — errors (and their stack traces)
 * in red, other levels on the level token (warnings yellow, info cyan,
 * debug/trace dim) — so busy logs stay readable. The text itself never
 * changes, so selections and copies are the raw line.
 */

// ESC sequences other than SGR (cursor moves, erase, OSC titles, …) would
// corrupt a read-only log view; only colour/style survives.
const ANSI_NON_SGR_RE =
  // eslint-disable-next-line no-control-regex
  /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-9;?]*[@A-HJKSTfhlnpsuDEMLR]|[()][A-Z0-9]|[=>DEMHcp78])/g;
// eslint-disable-next-line no-control-regex
const SGR_RE = /\x1b\[[0-9;]*m/y;

export function sanitizeAnsi(input: string): string {
  const cr = input.lastIndexOf('\r');
  const collapsed = cr === -1 ? input : input.slice(cr + 1);
  return collapsed.replace(ANSI_NON_SGR_RE, '');
}

/**
 * Colour `body` by `level` (the line's record level; `undefined` = detect
 * from the line itself). Errors colour the whole line, so continuation
 * lines of an error (stack frames) are red too.
 */
function highlight(body: string, level: LogLevel | null | undefined): string {
  const token = detectLevelToken(body);
  const effective = level === undefined ? (token?.level ?? null) : level;
  if (!effective) return body;
  const sgr = LEVEL_SGR[effective];
  if (effective === 'error' || effective === 'fatal') return `${sgr.open}${body}${sgr.close}`;
  if (!token || token.level !== effective || token.end <= token.start) return body;
  return `${body.slice(0, token.start)}${sgr.open}${body.slice(token.start, token.end)}${sgr.close}${body.slice(token.end)}`;
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

/**
 * Bytes written to xterm for one raw log line (no trailing newline in
 * `text`). `level` is the line's record level when known (continuation
 * lines inherit it); `undefined` detects it from the line.
 */
export function formatLogLine(
  text: string,
  opts: LogFormatOptions,
  level?: LogLevel | null,
): string {
  const split = splitK8sTimestamp(sanitizeAnsi(text));
  let body = split.body;
  if (!body.includes('\x1b[')) body = highlight(body, level);
  let line = split.ts ? `\x1b[2m${split.ts}\x1b[22m ${body}` : body;
  if (!opts.wrap && opts.cols > 8) line = truncateAnsi(line, opts.cols);
  // Reset so an unterminated colour in one line never bleeds into the next.
  return `${line}\x1b[0m\r\n`;
}
