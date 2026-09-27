import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark' | 'system';

/** Read by the boot script in index.html before React mounts (no flash). */
export const THEME_STORAGE_KEY = 'kp-theme';

function prefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function effectiveTheme(theme: Theme): 'light' | 'dark' {
  return theme === 'system' ? (prefersDark() ? 'dark' : 'light') : theme;
}

/** Writes the `dark` class and persists the choice; `system` is stored as no key. */
export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('dark', effectiveTheme(theme) === 'dark');
  try {
    if (theme === 'system') localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage can be blocked — not fatal.
  }
  window.dispatchEvent(new CustomEvent('kubepit:theme', { detail: theme }));
}

/** Follow theme changes made in another app window (they share localStorage). */
export function syncThemeAcrossWindows(): () => void {
  if (typeof window === 'undefined') return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
    const next = readInitial();
    document.documentElement.classList.toggle('dark', effectiveTheme(next) === 'dark');
    window.dispatchEvent(new CustomEvent('kubepit:theme', { detail: next }));
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}

function readInitial(): Theme {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // noop
  }
  return 'system';
}

/** Theme state for the window; follows OS changes while set to `system`. */
export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(readInitial);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    const onChange = (event: Event) => {
      const next = (event as CustomEvent<Theme>).detail;
      setThemeState((current) => (current === next ? current : next));
    };
    window.addEventListener('kubepit:theme', onChange);
    return () => window.removeEventListener('kubepit:theme', onChange);
  }, []);

  useEffect(() => {
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => applyTheme('system');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => setThemeState(next), []);
  return { theme, effective: effectiveTheme(theme), setTheme };
}

/** Effective theme for components that must re-render on change (Monaco, xterm). */
export function useEffectiveTheme(): 'light' | 'dark' {
  const [effective, setEffective] = useState<'light' | 'dark'>(() =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
      ? 'dark'
      : 'light',
  );
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setEffective(document.documentElement.classList.contains('dark') ? 'dark' : 'light'),
    );
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return effective;
}
