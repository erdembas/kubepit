'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { t, type Locale, type MessageKey } from './core';
export * from './core';

const LocaleContext = createContext<Locale>('en');
export function LocaleProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

/** Locale belongs to this render tree, so parallel static builds never share mutable state. */
export function useLocale() {
  const locale = useContext(LocaleContext);
  return useMemo(
    () => ({
      locale,
      t: (key: MessageKey, values?: Record<string, string | number>) => t(key, values, locale),
    }),
    [locale],
  );
}
