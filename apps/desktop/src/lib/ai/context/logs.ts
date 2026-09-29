import { emptyLevelCounts, type LevelCounts } from '@/lib/logs/levels';
import { lineBody, RecordIndex, type LogRecord } from '@/lib/logs/records';

/**
 * Deterministic, local log condensation for the assistant's context
 * (spec §11): no model ever summarizes logs. Lines are grouped into records
 * by the structured log parser (`lib/logs/records.ts`, so stack traces,
 * `Caused by:` chains and Go panics stay with their first line), then:
 *
 * - a header line with the level counts (`levels: error=N warn=N info=N …`);
 * - every error / fatal record, the newest 60, with at most 30 continuation
 *   lines each;
 * - repeated messages once, as `(×N) <newest example>`, after normalizing
 *   digits, hex ids and UUIDs;
 * - the last 40 lines (repeats collapsed the same way);
 * - at most 200 lines in total; the oldest repeats go first, then the
 *   oldest errors.
 *
 * Output lines are raw log text without ANSI codes and without the
 * Kubernetes timestamp prefix (`lineBody`), in their original order. The
 * Rust tool condenser (`ai/logs.rs`) follows the same rules.
 */

export interface CondenseOptions {
  /** Total output lines, header included (200). */
  maxLines?: number;
  /** Error / fatal records kept (60). */
  maxErrors?: number;
  /** Continuation lines kept per record (30). */
  maxFrames?: number;
  /** Trailing lines always considered (40). */
  tail?: number;
}

export interface CondensedLogs {
  text: string;
  /** Lines of `text`. */
  lines: number;
  /** Records per level over the whole input. */
  levels: LevelCounts;
  /** Records folded into a `(×N)` line (N − 1 per shown line). */
  collapsed: number;
}

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
/** Hex words and numbers (a digit somewhere): request ids, pointers, counters. */
const HEX_RE = /\b(?:0x)?[0-9a-f]*\d[0-9a-f]*\b/gi;
const DIGITS_RE = /\d+/g;

/** The collapse key of a line: digits, hex ids and UUIDs become `#`. */
export function collapseKey(body: string): string {
  return body.replace(UUID_RE, '#').replace(HEX_RE, '#').replace(DIGITS_RE, '#').trim();
}

interface Item {
  /** 0 = tail, 1 = error, 2 = repeat (dropped first). */
  rank: 0 | 1 | 2;
  lines: string[];
  count: number;
  dropped: boolean;
}

function render(record: LogRecord, count: number, maxFrames: number): string[] {
  const [head = '', ...frames] = record.lines.map(lineBody);
  const shown = frames.length > maxFrames ? frames.slice(0, maxFrames) : frames;
  const more = frames.length - shown.length;
  return [
    count > 1 ? `(×${count}) ${head}` : head,
    ...shown,
    ...(more > 0 ? [`\t… ${more} more lines`] : []),
  ];
}

function header(levels: LevelCounts, shown: number, total: number, collapsed: number): string {
  const counts = [
    `error=${levels.error}`,
    `warn=${levels.warn}`,
    `info=${levels.info}`,
    `debug=${levels.debug}`,
    ...(levels.fatal ? [`fatal=${levels.fatal}`] : []),
    ...(levels.trace ? [`trace=${levels.trace}`] : []),
    ...(levels.none ? [`none=${levels.none}`] : []),
  ];
  const repeats = collapsed ? ` · ${collapsed} repeats collapsed` : '';
  return `levels: ${counts.join(' ')} · shown ${shown} of ${total} lines${repeats}`;
}

export function condenseLogs(raw: readonly string[], opts: CondenseOptions = {}): CondensedLogs {
  const maxLines = Math.max(2, opts.maxLines ?? 200);
  const maxErrors = opts.maxErrors ?? 60;
  const maxFrames = opts.maxFrames ?? 30;
  const tail = opts.tail ?? 40;
  const index = new RecordIndex();
  index.ingest(raw.map((text, seq) => ({ seq, text })));
  const records = index.records;
  const levels = records.length ? { ...index.counts } : emptyLevelCounts();

  // Each message once, at its newest occurrence, with the number of repeats.
  const keys = records.map((r) => collapseKey(lineBody(r.lines[0] ?? '')));
  const groups = new Map<string, { count: number; last: number }>();
  keys.forEach((key, i) => {
    const group = groups.get(key);
    if (group) {
      group.count++;
      group.last = i;
    } else groups.set(key, { count: 1, last: i });
  });

  const tailStart = raw.length - tail;
  const items: Item[] = [];
  let errors = 0;
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i]!;
    const group = groups.get(keys[i]!)!;
    if (group.last !== i) continue;
    const isError = record.level === 'error' || record.level === 'fatal';
    let rank: Item['rank'];
    if (record.lastSeq >= tailStart) rank = 0;
    else if (isError) {
      if (errors >= maxErrors) continue;
      errors++;
      rank = 1;
    } else if (group.count > 1) rank = 2;
    else continue;
    items.push({
      rank,
      lines: render(record, group.count, maxFrames),
      count: group.count,
      dropped: false,
    });
  }
  items.reverse();

  const budget = maxLines - 1;
  let total = items.reduce((n, item) => n + item.lines.length, 0);
  for (const rank of [2, 1, 0] as const)
    for (const item of items) {
      if (total <= budget) break;
      if (item.rank !== rank) continue;
      item.dropped = true;
      total -= item.lines.length;
    }
  const kept = items.filter((item) => !item.dropped);
  let body = kept.flatMap((item) => item.lines);
  if (body.length > budget) body = body.slice(body.length - budget);
  const collapsed = kept.reduce((n, item) => n + (item.count > 1 ? item.count - 1 : 0), 0);
  const text = [header(levels, body.length, raw.length, collapsed), ...body].join('\n');
  return { text, lines: body.length + 1, levels, collapsed };
}
