import { splitK8sTimestamp, stripAnsi } from './ansi';
import { emptyLevelCounts, levelKey, type LevelCounts, type LogLevel } from './levels';
import { detectLevelToken, parseLogLine, type ParsedLog } from './parse';

/**
 * Lines → records. A record is one log event: its first line plus the
 * continuation lines that belong to it (Java / Node stack frames, `Caused
 * by:`, `... 12 more`, Python tracebacks, Go panics). Grouping is per
 * source (pod/container), so interleaved streams never mix their traces.
 *
 * `RecordIndex` is fed incrementally as lines arrive and stays bounded
 * with the line buffer it mirrors (records are dropped with their first
 * line). It also stamps every line with its record's level, which the
 * xterm views use for colouring and the level filter. Parsing into fields
 * is lazy ({@link parsedRecord}).
 */

/** A buffered line (the dock's `LogEntry` / `MergedEntry` fit this shape). */
export interface RawLine {
  seq: number;
  text: string;
  /** Source id (merged views); single-source views leave it undefined. */
  source?: number;
  /** Set by {@link RecordIndex.ingest}: the level of the line's record. */
  level?: LogLevel | null;
}

export interface LogRecord {
  /** `seq` of the first line (stable address). */
  id: number;
  source: number;
  /** Raw lines (ANSI and Kubernetes prefix kept); `lines[0]` is the head. */
  lines: string[];
  level: LogLevel | null;
  lastSeq: number;
  /** Takes unindented continuation lines too (inside a trace or panic). */
  trace: boolean;
  /** Head is a Go panic: every line up to the next record start belongs to it. */
  panic: boolean;
  /** Lazily parsed head (see {@link parsedRecord}). */
  parsed?: ParsedLog;
}

const INDENTED_RE = /^[ \t]+\S/;
const MARKER_RE = /^(?:Caused by: |Suppressed: |\s*\.\.\. \d+ (?:more|common frames omitted))/;
const TRACEBACK_RE = /^Traceback \(most recent call last\):/;
const JAVA_EXCEPTION_RE = /^(?:[\w$]+\.)+[\w$]*(?:Exception|Error|Throwable)(?::\s|$)/;
const PY_EXCEPTION_RE = /^[A-Z][A-Za-z0-9_]*(?:Error|Exception|Warning|Exit|Interrupt)(?::\s|$)/;
const PANIC_RE = /^(?:panic: |fatal error: )/;
const TS_START_RE = /^\[?\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}/;

/** ANSI-free body of a line without the Kubernetes timestamp prefix. */
export function lineBody(raw: string): string {
  return stripAnsi(splitK8sTimestamp(raw).body);
}

function looksLikeRecordStart(body: string): boolean {
  return (
    body.charCodeAt(0) === 123 /* { */ || TS_START_RE.test(body) || detectLevelToken(body) !== null
  );
}

/** Does `body` continue `open` (the source's current record)? */
export function continues(body: string, open: LogRecord | undefined): boolean {
  if (!open) return false;
  if (body === '') return open.trace || open.panic;
  if (INDENTED_RE.test(body)) return body.trimStart().charCodeAt(0) !== 123;
  if (MARKER_RE.test(body)) return true;
  const exceptional = open.trace || open.level === 'error' || open.level === 'fatal';
  if (exceptional && (JAVA_EXCEPTION_RE.test(body) || TRACEBACK_RE.test(body))) return true;
  if (open.trace && PY_EXCEPTION_RE.test(body)) return true;
  return open.panic && !looksLikeRecordStart(body);
}

export class RecordIndex {
  records: LogRecord[] = [];
  counts: LevelCounts = emptyLevelCounts();
  /** Bumped on every change (cheap memo key). */
  version = 0;
  private open = new Map<number, LogRecord>();

  /**
   * Fold new lines in. Returns the records that were created and whether an
   * existing record grew (its rows need a repaint).
   */
  ingest(lines: readonly RawLine[]): { added: LogRecord[]; grew: boolean } {
    const added: LogRecord[] = [];
    let grew = false;
    for (const line of lines) {
      const source = line.source ?? 0;
      const body = lineBody(line.text);
      const open = this.open.get(source);
      if (open && continues(body, open)) {
        open.lines.push(line.text);
        open.lastSeq = line.seq;
        if (body !== '' && !open.panic) open.trace = true;
        open.parsed = undefined;
        line.level = open.level;
        grew = true;
        continue;
      }
      const token = detectLevelToken(body);
      const record: LogRecord = {
        id: line.seq,
        source,
        lines: [line.text],
        level: token?.level ?? null,
        lastSeq: line.seq,
        trace: TRACEBACK_RE.test(body),
        panic: PANIC_RE.test(body),
      };
      line.level = record.level;
      this.records.push(record);
      this.open.set(source, record);
      this.counts[levelKey(record.level)]++;
      added.push(record);
    }
    if (added.length || grew) this.version++;
    return { added, grew };
  }

  /** Drop records whose first line is older than `seq` (the buffer trimmed it). */
  trimBefore(seq: number): number {
    let cut = 0;
    while (cut < this.records.length && this.records[cut]!.id < seq) {
      this.counts[levelKey(this.records[cut]!.level)]--;
      cut++;
    }
    if (cut === 0) return 0;
    const dropped = this.records.slice(0, cut);
    this.records = this.records.slice(cut);
    for (const record of dropped)
      if (this.open.get(record.source) === record) this.open.delete(record.source);
    this.version++;
    return cut;
  }

  /** A stream (re)started: the next line never continues an older record. */
  closeAll(): void {
    this.open.clear();
  }

  clear(): void {
    this.records = [];
    this.open.clear();
    this.counts = emptyLevelCounts();
    this.version++;
  }

  bySeq(id: number): LogRecord | undefined {
    // Records are sorted by id: binary search.
    let lo = 0;
    let hi = this.records.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const record = this.records[mid]!;
      if (record.id === id) return record;
      if (record.id < id) lo = mid + 1;
      else hi = mid - 1;
    }
    return undefined;
  }
}

/** The parsed head of `record` (cached on the record). */
export function parsedRecord(record: LogRecord, year?: number): ParsedLog {
  record.parsed ??= parseLogLine(record.lines[0]!, { year });
  return record.parsed;
}

/** Full text of a record, ANSI and Kubernetes prefixes removed. */
export function recordText(record: LogRecord): string {
  return record.lines.map(lineBody).join('\n');
}
