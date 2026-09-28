import { bench } from 'vitest';
import { logLines, mixedRawLines } from '@/lib/perf/fixtures';
import { splitK8sTimestamp } from './ansi';
import { detectLevelToken, parseLogLine } from './parse';
import { RecordIndex, type RawLine } from './records';

// Budget ids are the bench names (`perf/budgets.json`); the per-line budgets
// divide these totals by 10 000. Inputs are built once.

const LINES = 10_000;
const json = logLines('json', LINES);
const logfmt = logLines('logfmt', LINES);
const text = logLines('text', LINES);
/** 10 000 line bodies (as `RecordIndex` passes them), the three formats interleaved. */
const bodies = Array.from(
  { length: LINES },
  (_, i) => splitK8sTimestamp([json, logfmt, text][i % 3]![i]!).body,
);
const raw: RawLine[] = mixedRawLines(50_000);

function parseAll(lines: readonly string[]) {
  for (const line of lines) parseLogLine(line);
}

bench('logs/parse_json', () => parseAll(json), { time: 2000 });

bench('logs/parse_logfmt', () => parseAll(logfmt), { time: 2000 });

bench('logs/parse_text', () => parseAll(text), { time: 2000 });

bench(
  'logs/detect_level',
  () => {
    for (const body of bodies) detectLevelToken(body);
  },
  { time: 2000 },
);

bench('logs/record_index_50k', () => void new RecordIndex().ingest(raw), { time: 2000 });
