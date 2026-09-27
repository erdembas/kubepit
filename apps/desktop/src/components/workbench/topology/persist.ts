import { useCallback, useState } from 'react';

/** Small JSON preference in localStorage (map filters, hop count); memory-only when blocked. */
export function usePersistentJson<T>(
  storageKey: string,
  fallback: T,
  valid: (value: unknown) => value is T,
): readonly [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw == null) return fallback;
      const parsed: unknown = JSON.parse(raw);
      return valid(parsed) ? parsed : fallback;
    } catch {
      return fallback;
    }
  });
  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        /* Storage unavailable: keep the value for this session. */
      }
    },
    [storageKey],
  );
  return [value, set] as const;
}

export const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

export const isHops = (v: unknown): v is number => v === 1 || v === 2 || v === 3;
