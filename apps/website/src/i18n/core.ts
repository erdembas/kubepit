import en from './en/shell.json';
import tr from './tr/shell.json';

export type Locale = 'en' | 'tr';
export type MessageKey = keyof typeof en;
export function t(
  key: MessageKey,
  values: Record<string, string | number> = {},
  locale: Locale = 'en',
): string {
  const messages: Record<string, string> = locale === 'tr' ? tr : en;
  return (messages[key] ?? key).replace(/\{(\w+)\}/g, (match, name: string) =>
    String(values[name] ?? match),
  );
}
