/**
 * Log levels: the six normalized levels every parser maps to, the lookup
 * from the many spellings logging libraries use (zap, logrus, slog, klog,
 * log4j/logback, Python logging, pino/bunyan numbers, syslog severities)
 * and the ANSI styling the xterm log views apply per level. Pure, no I/O.
 */

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** A level bucket of the filters: one of the levels or `none` (no level found). */
export type LevelKey = LogLevel | 'none';
export const LEVEL_KEYS: readonly LevelKey[] = [...LOG_LEVELS, 'none'];

/** Severity order (trace = 0 … fatal = 5). */
export const LEVEL_RANK: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
};

const NAMES: Record<string, LogLevel> = {
  trace: 'trace',
  trc: 'trace',
  finest: 'trace',
  finer: 'trace',
  verbose: 'trace',
  vrb: 'trace',
  all: 'trace',
  debug: 'debug',
  dbg: 'debug',
  debu: 'debug',
  fine: 'debug',
  d: 'debug',
  info: 'info',
  inf: 'info',
  information: 'info',
  informational: 'info',
  notice: 'info',
  config: 'info',
  i: 'info',
  warn: 'warn',
  warning: 'warn',
  wrn: 'warn',
  warn_: 'warn',
  w: 'warn',
  error: 'error',
  err: 'error',
  eror: 'error',
  erro: 'error',
  severe: 'error',
  e: 'error',
  fatal: 'fatal',
  ftl: 'fatal',
  fata: 'fatal',
  panic: 'fatal',
  dpanic: 'fatal',
  critical: 'fatal',
  crit: 'fatal',
  alert: 'fatal',
  emerg: 'fatal',
  emergency: 'fatal',
  f: 'fatal',
};

/** pino / bunyan numbers (10 … 60); 0–7 are syslog severities. */
function levelFromNumber(n: number): LogLevel | null {
  if (!Number.isFinite(n) || n < 0) return null;
  if (n <= 7) {
    if (n <= 2) return 'fatal';
    if (n === 3) return 'error';
    if (n === 4) return 'warn';
    return n === 7 ? 'debug' : 'info';
  }
  if (n <= 10) return 'trace';
  if (n <= 20) return 'debug';
  if (n <= 30) return 'info';
  if (n <= 40) return 'warn';
  if (n <= 50) return 'error';
  return 'fatal';
}

/** The normalized level of a raw value (`"WARNING"`, `"err"`, `50`, `"E"` …), or null. */
export function normalizeLevel(raw: unknown): LogLevel | null {
  if (typeof raw === 'number') return levelFromNumber(raw);
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text || text.length > 16) return null;
  const key = text.toLowerCase();
  const named = NAMES[key];
  if (named) return named;
  if (/^\d+$/.test(key)) return levelFromNumber(Number(key));
  // `WARN ` padding, `<info>`, `level.info`, `Level(-4)` and friends.
  const word = /[a-z]+/.exec(key)?.[0];
  return word && word.length > 1 ? (NAMES[word] ?? null) : null;
}

/**
 * SGR sequences per level for the xterm views. Errors colour the whole
 * line; other levels only the level token (see `format.ts`).
 */
export const LEVEL_SGR: Record<LogLevel, { open: string; close: string }> = {
  trace: { open: '\x1b[2m', close: '\x1b[22m' },
  debug: { open: '\x1b[2m', close: '\x1b[22m' },
  info: { open: '\x1b[36m', close: '\x1b[39m' },
  warn: { open: '\x1b[93m', close: '\x1b[39m' },
  error: { open: '\x1b[31m', close: '\x1b[39m' },
  fatal: { open: '\x1b[1;31m', close: '\x1b[22;39m' },
};

export type LevelCounts = Record<LevelKey, number>;

export function emptyLevelCounts(): LevelCounts {
  return { trace: 0, debug: 0, info: 0, warn: 0, error: 0, fatal: 0, none: 0 };
}

/** Level bucket of a (possibly unknown) level. */
export function levelKey(level: LogLevel | null | undefined): LevelKey {
  return level ?? 'none';
}
