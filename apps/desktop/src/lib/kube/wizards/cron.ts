import * as i18n from '@/i18n/core';

/**
 * CronJob schedules: parsing (5 fields, names, ranges, steps and the
 * `@daily`-style macros the CronJob controller accepts), a localized
 * human-readable description and the next run times.
 *
 * Descriptions are built from two complete, translated phrases — when in
 * the day, and on which days — joined by a translated template, so word
 * order stays natural in every language. Anything the phrases cannot say
 * falls back to a field-by-field sentence.
 */

interface FieldSpec {
  min: number;
  max: number;
  names?: readonly string[];
}

const FIELDS: readonly FieldSpec[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  {
    min: 1,
    max: 12,
    names: ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'],
  },
  { min: 0, max: 7, names: ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] },
];

const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

export interface CronField {
  /** Sorted allowed values (day of week folded to 0–6). */
  values: number[];
  /** `*` or `?`: unrestricted. */
  any: boolean;
  /** `*\/n` (or `min-max/n` over the full range): every n-th value from the minimum. */
  step: number | null;
  /** One contiguous range `a-b` (no step). */
  range: [number, number] | null;
}

export interface CronSchedule {
  minute: CronField;
  hour: CronField;
  day: CronField;
  month: CronField;
  weekday: CronField;
  /** The expression after macro expansion (`@every` has no fields). */
  fields: string[];
}

export type CronParse =
  { ok: true; schedule: CronSchedule } | { ok: true; every: string } | { ok: false; error: string };

function atom(text: string, spec: FieldSpec): number | null {
  const upper = text.toUpperCase();
  const named = spec.names?.indexOf(upper) ?? -1;
  if (named >= 0) return named + spec.min;
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return n >= spec.min && n <= spec.max ? n : null;
}

function parseField(text: string, spec: FieldSpec, index: number): CronField | string {
  const values = new Set<number>();
  let any = false;
  let step: number | null = null;
  let range: [number, number] | null = null;
  const items = text.split(',');
  for (const item of items) {
    if (!item) return i18n.t('Field {index} has an empty list item.', { index: index + 1 });
    const [base, stepText, extra] = item.split('/');
    if (extra !== undefined)
      return i18n.t('Field {index} has more than one "/".', { index: index + 1 });
    let from: number;
    let to: number;
    if (base === '*' || base === '?') {
      if (base === '?' && index !== 2 && index !== 4)
        return i18n.t('"?" is only allowed for the day of month and day of week.');
      from = spec.min;
      to = index === 4 ? 6 : spec.max;
      if (stepText === undefined && items.length === 1) any = true;
    } else {
      const [a, b] = base!.split('-');
      const start = atom(a ?? '', spec);
      if (start === null)
        return i18n.t('"{value}" is not valid in field {index}.', {
          value: a ?? '',
          index: index + 1,
        });
      from = start;
      to = start;
      if (b !== undefined) {
        const end = atom(b, spec);
        if (end === null || end < start)
          return i18n.t('"{value}" is not a valid range in field {index}.', {
            value: base ?? '',
            index: index + 1,
          });
        to = end;
      } else if (stepText !== undefined) to = index === 4 ? 6 : spec.max;
    }
    let every = 1;
    if (stepText !== undefined) {
      every = /^\d+$/.test(stepText) ? Number(stepText) : 0;
      if (every < 1)
        return i18n.t('"{value}" is not a valid step in field {index}.', {
          value: stepText,
          index: index + 1,
        });
    }
    for (let v = from; v <= to; v += every) values.add(index === 4 && v === 7 ? 0 : v);
    if (items.length === 1) {
      if (stepText !== undefined && from === spec.min && (base === '*' || base === '?'))
        step = every;
      else if (stepText === undefined && from !== to) range = [from, to];
    }
  }
  return { values: [...values].sort((a, b) => a - b), any, step, range };
}

export function parseCron(expression: string): CronParse {
  const text = expression.trim().replace(/\s+/g, ' ');
  if (!text) return { ok: false, error: i18n.t('A schedule is required.') };
  if (/^(CRON_)?TZ=/i.test(text))
    return { ok: false, error: i18n.t('Set the time zone in its own field, not in the schedule.') };
  if (text.startsWith('@')) {
    const [macro, ...rest] = text.split(' ');
    const lower = macro!.toLowerCase();
    if (lower === '@every') {
      const interval = rest.join(' ');
      if (!/^(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+$/.test(interval))
        return { ok: false, error: i18n.t('Use a duration like 90m or 1h30m after @every.') };
      return { ok: true, every: interval };
    }
    const expanded = MACROS[lower];
    if (!expanded || rest.length)
      return { ok: false, error: i18n.t('Unknown schedule macro {macro}.', { macro: macro! }) };
    return parseCron(expanded);
  }
  const fields = text.split(' ');
  if (fields.length !== 5)
    return {
      ok: false,
      error: i18n.t(
        'Use five fields: minute, hour, day of month, month and day of week ({count} given).',
        { count: fields.length },
      ),
    };
  const parsed: CronField[] = [];
  for (let i = 0; i < 5; i++) {
    const field = parseField(fields[i]!, FIELDS[i]!, i);
    if (typeof field === 'string') return { ok: false, error: field };
    parsed.push(field);
  }
  const [minute, hour, day, month, weekday] = parsed as [
    CronField,
    CronField,
    CronField,
    CronField,
    CronField,
  ];
  return { ok: true, schedule: { minute, hour, day, month, weekday, fields } };
}

// ---------------------------------------------------------------------------
// Description
// ---------------------------------------------------------------------------

function locale() {
  return i18n.getFormatLocale();
}

function list(items: string[]): string {
  try {
    return new Intl.ListFormat(locale(), { style: 'long', type: 'conjunction' }).format(items);
  } catch {
    return items.join(', ');
  }
}

function timeText(hour: number, minute: number): string {
  return new Intl.DateTimeFormat(locale(), {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(Date.UTC(2000, 0, 1, hour, minute));
}

/** Turkish writes day and month names in lower case inside a sentence; Intl capitalizes them. */
function inSentence(name: string): string {
  return i18n.getLocale() === 'tr' ? name.toLocaleLowerCase(locale()) : name;
}

function weekdayName(day: number): string {
  // 2000-01-02 was a Sunday.
  return inSentence(
    new Intl.DateTimeFormat(locale(), { weekday: 'long', timeZone: 'UTC' }).format(
      Date.UTC(2000, 0, 2 + day),
    ),
  );
}

function monthName(month: number): string {
  return inSentence(
    new Intl.DateTimeFormat(locale(), { month: 'long', timeZone: 'UTC' }).format(
      Date.UTC(2000, month - 1, 1),
    ),
  );
}

const MAX_TIMES = 8;

/** When in the day, or null when no phrase fits. */
function timePhrase(s: CronSchedule): string | null {
  const { minute, hour } = s;
  if (minute.any && hour.any) return i18n.t('every minute');
  if (minute.step && hour.any)
    return i18n.plural('every {count} minute', 'every {count} minutes', minute.step);
  if (minute.values.length === 1 && hour.any)
    return i18n.t('every hour at minute {minute}', { minute: minute.values[0]! });
  if (minute.values.length === 1 && hour.step)
    return i18n.plural(
      'every {count} hour at minute {minute}',
      'every {count} hours at minute {minute}',
      hour.step,
      { minute: minute.values[0]! },
    );
  const window =
    hour.range ?? (hour.values.length === 1 ? [hour.values[0]!, hour.values[0]!] : null);
  if (window && minute.range && window[0] === window[1])
    return i18n.t('every minute from {start} to {end}', {
      start: timeText(window[0], minute.range[0]),
      end: timeText(window[0], minute.range[1]),
    });
  if (window && (minute.any || minute.step)) {
    const values = { start: timeText(window[0], 0), end: timeText(window[1], 59) };
    return minute.any
      ? i18n.t('every minute from {start} to {end}', values)
      : i18n.plural(
          'every {count} minute from {start} to {end}',
          'every {count} minutes from {start} to {end}',
          minute.step!,
          values,
        );
  }
  if (!minute.any && !hour.any && minute.values.length * hour.values.length <= MAX_TIMES) {
    const times: string[] = [];
    for (const h of hour.values) for (const m of minute.values) times.push(timeText(h, m));
    return i18n.t('at {times}', { times: list(times) });
  }
  return null;
}

function numbers(values: number[]): string {
  return list(values.map((v) => i18n.number(v)));
}

/** On which days, or null when no phrase fits. */
function dayPhrase(s: CronSchedule): string | null {
  const { day, month, weekday } = s;
  const weekdays = () => {
    const v = weekday.values;
    if (v.length === 5 && v.join() === '1,2,3,4,5') return i18n.t('Monday to Friday');
    if (v.length === 2 && v.join() === '0,6') return i18n.t('on weekends');
    return i18n.t('every {weekdays}', { weekdays: list(v.map(weekdayName)) });
  };
  const months = () => list(month.values.map(monthName));
  const monthCount = month.values.length;
  if (day.any && month.any && weekday.any) return i18n.t('every day');
  if (day.any && month.any) return weekdays();
  if (month.any && weekday.any) {
    if (day.step)
      return i18n.plural(
        'every {count} day of the month',
        'every {count} days of the month',
        day.step,
      );
    return i18n.t('on day {days} of the month', { days: numbers(day.values) });
  }
  // Month phrases agree in number with the months (Turkish "ayında" / "aylarında").
  if (day.any && weekday.any)
    return i18n.plural('every day in {months}', 'every day during {months}', monthCount, {
      months: months(),
    });
  if (weekday.any)
    return i18n.plural(
      'on day {days} of {months}',
      'on day {days} of each of {months}',
      monthCount,
      { days: numbers(day.values), months: months() },
    );
  if (day.any)
    return i18n.plural('{weekdays} in {months}', '{weekdays} during {months}', monthCount, {
      weekdays: weekdays(),
      months: months(),
    });
  if (month.any)
    // Both restricted: cron runs when either matches.
    return i18n.t('on day {days} of the month or {weekdays}', {
      days: numbers(day.values),
      weekdays: weekdays(),
    });
  return null;
}

function capitalize(text: string): string {
  return text ? text[0]!.toLocaleUpperCase(locale()) + text.slice(1) : text;
}

/** Human-readable, localized description of a valid schedule; null for invalid ones. */
export function describeCron(expression: string): string | null {
  const parsed = parseCron(expression);
  if (!parsed.ok) return null;
  if ('every' in parsed) return i18n.t('Every {interval}', { interval: parsed.every });
  const s = parsed.schedule;
  const time = timePhrase(s);
  const days = dayPhrase(s);
  if (time && days) {
    if (s.day.any && s.month.any && s.weekday.any) return capitalize(time);
    return capitalize(i18n.t('{time}, {days}', { time, days }));
  }
  const [minute, hour, day, month, weekday] = s.fields;
  return i18n.t(
    'Minute {minute}, hour {hour}, day of month {day}, month {month}, day of week {weekday}',
    { minute: minute!, hour: hour!, day: day!, month: month!, weekday: weekday! },
  );
}

// ---------------------------------------------------------------------------
// Next runs
// ---------------------------------------------------------------------------

/** Wall-clock parts of `instant` in `timeZone` (IANA name; '' = UTC). */
function wallClock(instant: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone || 'UTC',
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
  };
}

export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone) return true;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The next `count` run times after `from`, as wall-clock times in
 * `timeZone` encoded as UTC epoch milliseconds (format them with
 * `timeZone: 'UTC'`). `@every` schedules and invalid input yield [].
 */
export function nextRuns(expression: string, from: number, count = 3, timeZone = ''): number[] {
  const parsed = parseCron(expression);
  if (!parsed.ok || 'every' in parsed || !isValidTimeZone(timeZone)) return [];
  const s = parsed.schedule;
  const now = wallClock(from, timeZone);
  const start = Date.UTC(now.year, now.month - 1, now.day);
  const nowWall = Date.UTC(now.year, now.month - 1, now.day, now.hour, now.minute);
  const months = new Set(s.month.values);
  const days = new Set(s.day.values);
  const weekdays = new Set(s.weekday.values);
  const out: number[] = [];
  // Five years covers every valid schedule (29 February included).
  for (let d = 0; d < 366 * 5 && out.length < count; d++) {
    const date = new Date(start + d * 86_400_000);
    if (!months.has(date.getUTCMonth() + 1)) continue;
    const dom = days.has(date.getUTCDate());
    const dow = weekdays.has(date.getUTCDay());
    // Like cron: with both day fields restricted either may match.
    const dayMatch = s.day.any || s.weekday.any ? dom && dow : dom || dow;
    if (!dayMatch) continue;
    for (const h of s.hour.values) {
      for (const m of s.minute.values) {
        const t = date.getTime() + h * 3_600_000 + m * 60_000;
        if (t <= nowWall) continue;
        out.push(t);
        if (out.length >= count) return out;
      }
    }
  }
  return out;
}

/** Common schedules for the picker. */
export const CRON_PRESETS: readonly string[] = [
  '*/5 * * * *',
  '*/15 * * * *',
  '0 * * * *',
  '0 */6 * * *',
  '0 0 * * *',
  '30 2 * * *',
  '0 9 * * 1-5',
  '0 0 * * 0',
  '0 0 1 * *',
];
