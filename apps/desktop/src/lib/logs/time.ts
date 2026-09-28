/**
 * Timestamps found in log lines → epoch milliseconds. Parsed by hand
 * (no `Date.parse` guessing): ISO-like dates with `T` or a space, `-` or
 * `/` separators, `.` or `,` fractions of any length and an optional zone
 * (no zone = UTC, as in containers); epoch numbers in s / ms / µs / ns;
 * klog's `MMDD hh:mm:ss.uuuuuu`; and the common log format's
 * `02/Jan/2006:15:04:05 -0700`.
 */

const ISO_RE =
  /^(\d{4})[-/](\d{2})[-/](\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,9}))?\s?(Z|z|UTC|[+-]\d{2}(?::?\d{2})?)?$/;
const CLF_RE =
  /^(\d{2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})(?:\s([+-]\d{2}):?(\d{2}))?$/;
const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

function fractionMs(fraction: string | undefined): number {
  if (!fraction) return 0;
  return Number(fraction.slice(0, 3).padEnd(3, '0'));
}

function zoneOffsetMs(zone: string | undefined): number {
  if (!zone || zone === 'Z' || zone === 'z' || zone === 'UTC') return 0;
  const sign = zone[0] === '-' ? -1 : 1;
  const digits = zone.slice(1).replace(':', '');
  const hours = Number(digits.slice(0, 2));
  const minutes = Number(digits.slice(2, 4) || '0');
  return sign * (hours * 60 + minutes) * 60_000;
}

/** An ISO-like date string → epoch ms, or null. */
export function parseIsoTime(text: string): number | null {
  const m = ISO_RE.exec(text.trim());
  if (!m) return null;
  const ms = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
    fractionMs(m[7]),
  );
  return Number.isFinite(ms) ? ms - zoneOffsetMs(m[8]) : null;
}

/** `10/Oct/2000:13:55:36 -0700` (nginx / Apache access logs) → epoch ms. */
export function parseClfTime(text: string): number | null {
  const m = CLF_RE.exec(text.trim());
  if (!m) return null;
  const month = MONTHS[m[2]!.toLowerCase()];
  if (month === undefined) return null;
  const ms = Date.UTC(Number(m[3]), month, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6]));
  const offset = m[7] ? zoneOffsetMs(`${m[7]}${m[8]}`) : 0;
  return ms - offset;
}

/** An epoch number in seconds, milliseconds, microseconds or nanoseconds → ms. */
export function epochToMs(n: number): number | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 1e11) return Math.round(n * 1000); // seconds (until year 5138)
  if (n < 1e14) return Math.round(n); // milliseconds
  if (n < 1e17) return Math.round(n / 1000); // microseconds
  return Math.round(n / 1e6); // nanoseconds
}

/** klog's `MMDD hh:mm:ss.uuuuuu` in `year` (klog omits it) → epoch ms. */
export function klogTime(
  month: string,
  day: string,
  clock: [string, string, string],
  fraction: string | undefined,
  year: number,
): number {
  return Date.UTC(
    year,
    Number(month) - 1,
    Number(day),
    Number(clock[0]),
    Number(clock[1]),
    Number(clock[2]),
    fractionMs(fraction),
  );
}

/** Any timestamp value of a structured record (string or number) → epoch ms. */
export function parseTimeValue(raw: unknown): number | null {
  if (typeof raw === 'number') return epochToMs(raw);
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;
  if (/^\d+(?:\.\d+)?$/.test(text)) return epochToMs(Number(text));
  return parseIsoTime(text) ?? parseClfTime(text);
}

/** Nanosecond epoch string (Loki) → epoch ms (sub-millisecond digits dropped). */
export function nsToMs(ns: string): number {
  return ns.length > 6 ? Number(ns.slice(0, -6)) : 0;
}

/** Epoch ms → nanosecond epoch string. */
export function msToNs(ms: number): string {
  return `${Math.max(0, Math.floor(ms))}000000`;
}

/** Nanosecond epoch string → RFC 3339 with all nine fraction digits (UTC). */
export function nsToIso(ns: string): string {
  const digits = ns.padStart(10, '0');
  const seconds = Number(digits.slice(0, -9));
  return `${new Date(seconds * 1000).toISOString().slice(0, 19)}.${digits.slice(-9)}Z`;
}

/** `ns + 1` on a decimal string (no BigInt needed). */
export function incNs(ns: string): string {
  const chars = ns.split('');
  for (let i = chars.length - 1; i >= 0; i--) {
    if (chars[i] !== '9') {
      chars[i] = String(Number(chars[i]) + 1);
      return chars.join('');
    }
    chars[i] = '0';
  }
  return `1${chars.join('')}`;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** `2024-09-27 14:00:00.123` in local time (table cells; stable width, locale-free). */
export function formatLogTime(ms: number, withDate: boolean): string {
  const d = new Date(ms);
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  return withDate
    ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clock}`
    : clock;
}
