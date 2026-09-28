import enShell from './en/shell.json';
import enWorkbench from './en/workbench.json';
import enDock from './en/dock.json';
import trShell from './tr/shell.json';
import trWorkbench from './tr/workbench.json';
import trDock from './tr/dock.json';

/**
 * Catalogs are split per product area so parallel work never edits the same
 * file. English source messages are the keys; every key must exist in both
 * languages (`pnpm i18n:check`).
 */
const en = { ...enShell, ...enWorkbench, ...enDock };
const tr = { ...trShell, ...trWorkbench, ...trDock };

export type Locale = 'en' | 'tr';
export type MessageKey = keyof typeof en;
export type Values = Readonly<Record<string, string | number | null | undefined>>;
export const LOCALE_STORAGE_KEY = 'kp-locale';
export const LOCALES: readonly Locale[] = ['en', 'tr'];
const listeners = new Set<() => void>();
let locale: Locale = 'en';

export function resolveLocale(value: unknown): Locale {
  return typeof value === 'string' && /^tr(?:[-_]|$)/i.test(value) ? 'tr' : 'en';
}
export function getLocale(): Locale {
  return locale;
}
export function getFormatLocale(): string {
  return locale === 'tr' ? 'tr-TR' : 'en-US';
}
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
/** Change display language only. Never translate user content, Kubernetes data or persisted identifiers. */
export function setLocale(next: Locale, persist = true): void {
  if (!LOCALES.includes(next)) return;
  if (typeof document !== 'undefined') document.documentElement.lang = next;
  if (persist && typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      /* Private/blocked storage. */
    }
  }
  if (next === locale) return;
  locale = next;
  listeners.forEach((listener) => listener());
}
/** Desktop opts in at boot. */
export function initializeLocale(): () => void {
  if (typeof window === 'undefined') return () => {};
  const preferred = () => {
    try {
      const saved = window.localStorage.getItem(LOCALE_STORAGE_KEY);
      if (saved === 'tr' || saved === 'en') return saved;
    } catch {
      /* Fall back to system language. */
    }
    return resolveLocale(window.navigator.language);
  };
  setLocale(preferred(), false);
  const onStorage = (event: StorageEvent) => {
    if (event.key === LOCALE_STORAGE_KEY || event.key === null) setLocale(preferred(), false);
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}
export function message(key: MessageKey, language: Locale = locale): string {
  const translated = (tr as Partial<Record<MessageKey, string>>)[key];
  return language === 'tr' && translated !== undefined ? translated : (en[key] ?? key);
}
/** Placeholder substitution is deliberately non-recursive; supplied content stays verbatim. */
export function t(key: MessageKey, values: Values = {}): string {
  return message(key).replace(/\{(\w+)\}/g, (token, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : token,
  );
}
/**
 * Intl formatters per kind, locale and options. Building one costs tens of
 * microseconds (a DateTimeFormat in the webview far more), formatting with
 * it well under one, and charts and tables format hundreds of values per
 * render. Options are plain literals, so their JSON is a stable key; the
 * cache is dropped if a caller ever makes keys unbounded.
 */
const formatters = new Map<string, unknown>();
const MAX_FORMATTERS = 500;

function formatter<T>(kind: string, options: object | undefined, make: (locale: string) => T): T {
  const locale = getFormatLocale();
  const key = `${kind}|${locale}|${options === undefined ? '' : JSON.stringify(options)}`;
  let hit = formatters.get(key) as T | undefined;
  if (hit === undefined) {
    if (formatters.size >= MAX_FORMATTERS) formatters.clear();
    hit = make(locale);
    formatters.set(key, hit);
  }
  return hit;
}

export function number(value: number, options?: Intl.NumberFormatOptions): string {
  return formatter('n', options, (l) => new Intl.NumberFormat(l, options)).format(value);
}
export function date(value: Date | number, options?: Intl.DateTimeFormatOptions): string {
  return formatter('d', options, (l) => new Intl.DateTimeFormat(l, options)).format(value);
}
export function relative(value: number, unit: Intl.RelativeTimeFormatUnit): string {
  return formatter(
    'r',
    undefined,
    (l) => new Intl.RelativeTimeFormat(l, { numeric: 'auto' }),
  ).format(value, unit);
}

/** Translate a complete count-dependent message. Both keys must exist in both catalogs. */
export function plural(
  one: MessageKey,
  other: MessageKey,
  count: number,
  values: Values = {},
): string {
  const rules = formatter('p', undefined, (l) => new Intl.PluralRules(l));
  const key = rules.select(count) === 'one' ? one : other;
  return t(key, { ...values, count: number(count) });
}
